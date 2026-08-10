import type { BreakEventInput } from "@aems/types";

import { client } from "./api";
import {
  DEFAULT_MAX_OPEN_BREAK_SECONDS,
  hasEnded,
  isOnBreak,
  loadDay,
  localDayKey,
  openBreak,
  saveDay,
  type DayState,
} from "./day";
import { enqueue } from "./queue";
import AemsUsage from "../modules/aems-usage";

/**
 * Clocking in and out, and the breaks in between — the mobile counterpart of the
 * desktop agent's `session.ts` plus the break half of its collector.
 *
 * Two rules run through all of it:
 *
 *  - **Local state is written first, the server is told second.** Every call here is
 *    something the employee just did with their thumb; it has to hold even when the
 *    phone has no signal. The server call is best-effort and the pieces that must not
 *    be lost — break spans — go through the on-disk queue rather than the network.
 *  - **The work session id is not required.** Batches carry it when it is known and
 *    `null` when it is not, which is what lets a day start offline and still be
 *    attributed once the session opens on a later cycle.
 */

async function screenActiveSeconds(): Promise<number> {
  try {
    return (await AemsUsage.getDeviceSnapshot()).screenActiveSeconds;
  } catch {
    // Losing this reading skews one boundary, not the day; treating it as zero would
    // be worse, because it would credit all of today's screen time to this moment.
    return 0;
  }
}

/** Opens the server-side work session if it is not already open. Safe to call often. */
export async function ensureWorkSession(state: DayState, deviceId: string): Promise<DayState> {
  if (state.workSessionId !== null || state.startedAtMs === null || hasEnded(state)) return state;

  try {
    const session = await client.startWorkSession(deviceId);
    const next = { ...state, workSessionId: session.id };
    await saveDay(next);
    return next;
  } catch {
    // Offline. Events still queue and still send; they are simply unstamped until a
    // later cycle succeeds here.
    return state;
  }
}

export async function startDay(deviceId: string): Promise<DayState> {
  const current = await loadDay();
  if (current.startedAtMs !== null && !hasEnded(current)) return current;

  const startedAtMs = Date.now();
  const next: DayState = {
    day: localDayKey(startedAtMs),
    startedAtMs,
    endedAtMs: null,
    workSessionId: null,
    breaks: [],
    excludedActiveSeconds: 0,
    activeSecondsAtDayStart: await screenActiveSeconds(),
  };

  await saveDay(next);
  return ensureWorkSession(next, deviceId);
}

export async function endDay(deviceId: string): Promise<DayState> {
  const current = await loadDay();
  if (current.startedAtMs === null || hasEnded(current)) return current;

  // An open break is closed at the same instant the day ends, so the two can never
  // disagree about how the day finished.
  const closed = await closeOpenBreak(current, Date.now());
  const next: DayState = { ...closed, endedAtMs: Date.now() };
  await saveDay(next);

  const withSession = await ensureWorkSession(next, deviceId);
  if (withSession.workSessionId !== null) {
    try {
      await client.endWorkSession(withSession.workSessionId);
    } catch {
      // The local day is ended regardless — collection has stopped on this device,
      // which is what the employee asked for. A stale open session server-side is
      // corrected by the next clock-in, which returns the same session.
    }
  }

  return { ...withSession, endedAtMs: next.endedAtMs };
}

export async function startBreak(): Promise<DayState> {
  const current = await loadDay();
  if (current.startedAtMs === null || hasEnded(current) || isOnBreak(current)) return current;

  const startedAtMs = Date.now();
  const next: DayState = {
    ...current,
    breaks: [
      ...current.breaks,
      {
        clientEventId: `break:${current.day}:${startedAtMs}`,
        startedAtMs,
        endedAtMs: null,
        activeSecondsAtStart: await screenActiveSeconds(),
      },
    ],
  };

  await saveDay(next);
  return next;
}

export async function endBreak(): Promise<DayState> {
  const current = await loadDay();
  if (!isOnBreak(current)) return current;

  const next = await closeOpenBreak(current, Date.now());
  await saveDay(next);
  return next;
}

/**
 * Closes the open break, banking the screen time that fell inside it and journalling
 * the completed span.
 *
 * Shared by `endBreak`, `endDay` and the forgotten-break guard so all three produce
 * exactly the same record — the desktop agent's bug here was a break that ran all
 * night, and the fix is that only one piece of code knows how a break finishes.
 */
async function closeOpenBreak(state: DayState, endedAtMs: number): Promise<DayState> {
  const open = openBreak(state);
  if (open === null) return state;

  const activeNow = await screenActiveSeconds();
  const spentOnBreak = Math.max(0, activeNow - open.activeSecondsAtStart);

  const closedSpan = { ...open, endedAtMs };
  const next: DayState = {
    ...state,
    breaks: state.breaks.map((span) => (span === open ? closedSpan : span)),
    excludedActiveSeconds: state.excludedActiveSeconds + spentOnBreak,
  };

  const event: BreakEventInput = {
    clientEventId: closedSpan.clientEventId,
    breakStartAt: new Date(closedSpan.startedAtMs).toISOString(),
    breakEndAt: new Date(endedAtMs).toISOString(),
  };
  await enqueue({ breaks: [event] });

  return next;
}

/**
 * Ends a day whose break has been open past the policy's limit, backdated to when the
 * break began.
 *
 * Called from the sync cycle rather than a timer, for the same reason the day rolls
 * over on read: a phone asleep in a drawer runs no timers, but it does sync when it
 * wakes. Without this a break started at 5pm reports as a break until morning.
 *
 * `maxOpenBreakSeconds` is **passed in, not re-read**. The caller already holds the
 * policy it loaded from `SecureStore`; reading it a second time here would make two
 * sources for one number, and two sources eventually disagree. Absence falls back to
 * {@link DEFAULT_MAX_OPEN_BREAK_SECONDS} rather than to no limit at all — see the note
 * on that constant.
 */
export async function closeForgottenBreak(
  maxOpenBreakSeconds: number | undefined,
  nowMs: number = Date.now(),
): Promise<DayState> {
  const limitMs =
    (typeof maxOpenBreakSeconds === "number" && maxOpenBreakSeconds > 0
      ? maxOpenBreakSeconds
      : DEFAULT_MAX_OPEN_BREAK_SECONDS) * 1000;

  const current = await loadDay();
  const open = openBreak(current);
  if (open === null || nowMs - open.startedAtMs < limitMs) return current;

  const closed = await closeOpenBreak(current, open.startedAtMs);
  const next: DayState = { ...closed, endedAtMs: open.startedAtMs };
  await saveDay(next);
  return next;
}
