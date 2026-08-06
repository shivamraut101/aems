import * as FileSystem from "expo-file-system";

/**
 * The working day: when it started, the breaks taken in it, and whether it has been
 * ended. Mirrors the desktop agent's `day-state.json` (`apps/desktop-agent/src/main`),
 * for the same reason it exists there — a day that only lives in component state is a
 * day that a process death silently erases.
 *
 * Kept in a plain file rather than SecureStore: none of it is a secret, and SecureStore
 * is a small key/value store for credentials, not a place to grow a list of spans.
 */

const DAY_STATE_URI = `${FileSystem.documentDirectory}day-state.json`;

export interface DayTotals {
  totalSeconds: number;
  activeSeconds: number;
  idleSeconds: number;
  breakSeconds: number;
}

export const EMPTY_TOTALS: DayTotals = {
  totalSeconds: 0,
  activeSeconds: 0,
  idleSeconds: 0,
  breakSeconds: 0,
};

export interface BreakSpan {
  /** Idempotency key for ingestion, matching how the desktop agent keys its events. */
  clientEventId: string;
  startedAtMs: number;
  endedAtMs: number | null;
  /**
   * The native screen-on total at the moment the break opened.
   *
   * `ScreenTimeTracker` keeps counting while the screen is on, and it has no idea a
   * break was declared — so without this the phone being used during a break would be
   * billed as active work. Differencing the counter across the break is the only way
   * to subtract exactly the screen time that fell inside it.
   */
  activeSecondsAtStart: number;
}

export interface DayState {
  /** Local calendar day this state describes, so it expires by itself at midnight. */
  day: string;
  startedAtMs: number | null;
  endedAtMs: number | null;
  workSessionId: number | null;
  breaks: BreakSpan[];
  /** Screen-on seconds that fell inside a break and must not count as active. */
  excludedActiveSeconds: number;
  /**
   * The native screen-on total when the day was clocked in.
   *
   * `ScreenTimeTracker` counts from local midnight, but a working day rarely starts
   * there — without this baseline, an hour of personal phone use before clocking in
   * would be reported as an hour of work.
   */
  activeSecondsAtDayStart: number;
}

export function localDayKey(atMs: number = Date.now()): string {
  const date = new Date(atMs);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

export function emptyDay(atMs: number = Date.now()): DayState {
  return {
    day: localDayKey(atMs),
    startedAtMs: null,
    endedAtMs: null,
    workSessionId: null,
    breaks: [],
    excludedActiveSeconds: 0,
    activeSecondsAtDayStart: 0,
  };
}

/**
 * Reads the stored day, discarding one that belongs to a previous calendar day.
 *
 * The rollover is checked on read rather than driven by a timer, exactly as the desktop
 * collector does it: a phone that was asleep at midnight never runs a timer scheduled
 * for midnight, but it does read this file the next time it wakes.
 */
export async function loadDay(atMs: number = Date.now()): Promise<DayState> {
  try {
    const info = await FileSystem.getInfoAsync(DAY_STATE_URI);
    if (!info.exists) return emptyDay(atMs);

    const parsed = JSON.parse(await FileSystem.readAsStringAsync(DAY_STATE_URI)) as DayState;
    if (parsed.day !== localDayKey(atMs)) return emptyDay(atMs);

    return { ...emptyDay(atMs), ...parsed, breaks: parsed.breaks ?? [] };
  } catch {
    // A corrupt or unreadable file must not stop the agent from working today; the
    // worst case is that today starts over, which is what a fresh install would do.
    return emptyDay(atMs);
  }
}

export async function saveDay(state: DayState): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(DAY_STATE_URI, JSON.stringify(state));
  } catch {
    // Losing the write costs the resume-after-restart guarantee, not the current day.
  }
}

export function openBreak(state: DayState): BreakSpan | null {
  return state.breaks.find((span) => span.endedAtMs === null) ?? null;
}

export function isOnBreak(state: DayState): boolean {
  return openBreak(state) !== null;
}

export function hasEnded(state: DayState): boolean {
  return state.endedAtMs !== null;
}

/**
 * A break left open past this is treated as one the employee forgot to end, and the day
 * is closed at the point the break began. Same guard, and the same three hours, as the
 * desktop collector's `MAX_OPEN_BREAK_MS` — without it a phone put down at 5pm reports
 * a break running until the following morning.
 */
export const MAX_OPEN_BREAK_MS = 3 * 60 * 60 * 1000;

/**
 * The four-way split `docs/scope.md` §2.2 is written around, computed so the parts
 * always add up to the total.
 *
 * `idle` is deliberately the remainder rather than its own measurement. Android gives
 * no keyboard/mouse idle signal the way the desktop agent's `powerMonitor` does; what
 * it gives is screen-on time. So the honest reading here is: the day is *total*, the
 * part with the screen on and no break running is *active*, declared breaks are
 * *break*, and everything left — phone down, pocketed, asleep — is *idle*. Deriving it
 * rather than measuring it is also what guarantees the partition is exact.
 */
export function summariseDay(
  state: DayState,
  screenActiveSeconds: number,
  nowMs: number = Date.now(),
): DayTotals {
  if (state.startedAtMs === null) return EMPTY_TOTALS;

  const endMs = state.endedAtMs ?? nowMs;
  const totalSeconds = Math.max(0, Math.floor((endMs - state.startedAtMs) / 1000));

  const breakSeconds = state.breaks.reduce((sum, span) => {
    const spanEnd = span.endedAtMs ?? endMs;
    return sum + Math.max(0, Math.floor((spanEnd - span.startedAtMs) / 1000));
  }, 0);

  // Screen time banked before today's session opened is not part of today's work, and
  // neither is screen time spent on a break.
  const sinceClockIn = screenActiveSeconds - state.activeSecondsAtDayStart;
  const attributable = Math.max(0, sinceClockIn - state.excludedActiveSeconds);
  const activeSeconds = Math.min(attributable, Math.max(0, totalSeconds - breakSeconds));
  const idleSeconds = Math.max(0, totalSeconds - activeSeconds - breakSeconds);

  return { totalSeconds, activeSeconds, idleSeconds, breakSeconds };
}
