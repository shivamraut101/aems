import type { WorkSession } from "@aems/types";

import type { DaySpan, DayTotals } from "../shared/types/index.js";

/**
 * The two session routes, narrowed to what this module calls.
 *
 * `AemsClient` satisfies it structurally, so the collection loop still passes the
 * real client while tests pass a fake — no network stub, no HTTP layer under a unit
 * test of a state machine.
 */
export interface SessionApi {
  startWorkSession(deviceId: string): Promise<WorkSession>;
  endWorkSession(workSessionId: number): Promise<WorkSession>;
}

export interface DayInput {
  sessions: readonly DaySpan[];
  idle: readonly DaySpan[];
  breaks: readonly DaySpan[];
  /** Start of the reporting day, in whatever timezone the caller reports in. */
  dayStart: Date;
  /** Caps still-running spans. Passed in rather than read, so the totals are testable. */
  now: Date;
}

/** Half-open interval [start, end) in epoch milliseconds. */
interface Range {
  start: number;
  end: number;
}

/**
 * Reduces the day to total / active / idle / break.
 *
 * Tracked time is the union of the work sessions, so overlapping or repeated spans
 * cannot inflate it past the clock. Everything else is carved out of that union
 * rather than counted alongside it — an idle stretch happens *while* a session is
 * running, so adding the two would report more hours than the employee was clocked in.
 */
export function summariseDay(input: DayInput): DayTotals {
  const window: Range = {
    start: input.dayStart.getTime(),
    end: input.now.getTime(),
  };
  const sessions = confine(input.sessions, window);

  // Clipped to the sessions: idle or a break observed while clocked out is not the
  // employee's time, it is time nobody was tracking.
  const breaks = intersect(confine(input.breaks, window), sessions);

  // Break wins where the two overlap. Sitting still during a declared break is one
  // stretch of not-working described twice, and counting both is how a dashboard
  // ends up showing parts that add to more than the day.
  const idle = subtract(intersect(confine(input.idle, window), sessions), breaks);

  // Active is what is left of the sessions once both are removed, so it is derived
  // rather than measured — there is no third list to fall out of step with.
  //
  // Rounding each part on its own is how "Total 8h 20m" ends up next to parts that
  // add to 8h 21m. The three are a partition of the total, so they are rounded as
  // running sums and each part is the difference between two of them — that makes
  // the identity exact and every part non-negative, at the cost of up to a second
  // of drift on an individual figure.
  const breakSeconds = secondsIn(breaks);
  const idleSeconds = secondsIn([...breaks, ...idle]) - breakSeconds;
  const totalSeconds = secondsIn(sessions);

  return {
    totalSeconds,
    activeSeconds: totalSeconds - breakSeconds - idleSeconds,
    idleSeconds,
    breakSeconds,
  };
}

/** Clamps spans to the window, resolving open ones at its end, and merges what overlaps. */
function confine(spans: readonly DaySpan[], window: Range): Range[] {
  const trimmed: Range[] = [];

  for (const span of spans) {
    const start = Math.max(Date.parse(span.startedAt), window.start);
    // An open span runs up to `now`; a clock-skewed one is not allowed past it either.
    const end = Math.min(span.endedAt === null ? window.end : Date.parse(span.endedAt), window.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) trimmed.push({ start, end });
  }

  return merge(trimmed);
}

function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const first = sorted[0];
  if (!first) return [];

  const merged: Range[] = [{ ...first }];

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (!current || !last) continue;

    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

/** Both inputs are already disjoint, so pairwise overlap is the whole intersection. */
function intersect(a: Range[], b: Range[]): Range[] {
  const overlaps: Range[] = [];

  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) overlaps.push({ start, end });
    }
  }

  return merge(overlaps);
}

function subtract(base: Range[], holes: Range[]): Range[] {
  let result = base;

  for (const hole of holes) {
    const next: Range[] = [];
    for (const piece of result) {
      if (hole.end <= piece.start || hole.start >= piece.end) {
        next.push(piece);
        continue;
      }
      if (hole.start > piece.start) next.push({ start: piece.start, end: hole.start });
      if (hole.end < piece.end) next.push({ start: hole.end, end: piece.end });
    }
    result = next;
  }

  return result;
}

function secondsIn(ranges: Range[]): number {
  return Math.round(ranges.reduce((sum, r) => sum + (r.end - r.start), 0) / 1000);
}

/**
 * Reads the HTTP status off a thrown error without an `instanceof AemsApiError`.
 *
 * Status first, error code second — the API's 404 comes from Fastify's default
 * handler, which returns `error: "Not Found"` rather than any of the snake_case
 * domain codes, so matching on the code would miss it.
 */
function httpStatusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status: unknown = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : null;
}

/**
 * Owns the work session — the clock-in/clock-out pair every activity, idle and
 * screenshot row hangs off.
 *
 * The Tauri build never called either endpoint, so every ingested row landed with a
 * null `work_session_id` and scope §2.2 (tracked time, active, idle, break) had
 * nothing to aggregate over.
 */
export class SessionManager {
  private readonly api: SessionApi;
  private readonly deviceId: string;

  private sessionId: number | null = null;
  /** Held so overlapping callers await the same clock-in instead of racing a second one. */
  private starting: Promise<number> | null = null;

  /**
   * Clock-in/clock-out pairs, timed by the server rather than by this process.
   *
   * Taking `clock_in_at` from the response is what makes an adopted session count
   * from when the employee actually started, instead of restarting the day's total
   * every time the agent is relaunched.
   */
  private readonly recorded: DaySpan[] = [];

  constructor(api: SessionApi, deviceId: string) {
    this.api = api;
    this.deviceId = deviceId;
  }

  get current(): number | null {
    return this.sessionId;
  }

  /** Every session this agent has opened or adopted, oldest first. */
  get spans(): readonly DaySpan[] {
    return this.recorded;
  }

  /**
   * Clocks in when collection becomes permitted.
   *
   * The API hands back the session already running rather than opening a second one,
   * so an agent restart mid-day resumes instead of fragmenting the day.
   */
  start(): Promise<number> {
    // The collection loop calls this whenever `mayCollect()` flips true, which is
    // every tick once consent is on file. Short-circuiting keeps that from becoming
    // a request per tick.
    if (this.sessionId !== null) return Promise.resolve(this.sessionId);
    if (this.starting !== null) return this.starting;

    this.starting = this.api
      .startWorkSession(this.deviceId)
      .then((session) => {
        this.sessionId = session.id;
        this.recorded.push({
          startedAt: session.clock_in_at,
          endedAt: session.clock_out_at,
        });
        return session.id;
      })
      .finally(() => {
        this.starting = null;
      });

    return this.starting;
  }

  /**
   * Clocks out on shutdown and when consent is lost, after the final buffer flush.
   *
   * `now` is only the fallback stamp for the 404 path, where the server closed the
   * session without telling us when. It is a parameter so the day's totals stay
   * deterministic under test; the default exists because the shutdown hook has no
   * clock of its own to hand over.
   */
  async end(now: Date = new Date()): Promise<void> {
    const sessionId = this.sessionId;
    if (sessionId === null) return;

    try {
      const closed = await this.api.endWorkSession(sessionId);
      this.closeLastSpan(closed.clock_out_at ?? now.toISOString());
    } catch (error) {
      // The route only matches sessions that are still open, so a retried clock-out
      // — or one racing an admin closing the session — comes back 404. The session
      // is closed either way; treating that as an error would leave the agent
      // hammering an endpoint that can never succeed again.
      if (httpStatusOf(error) !== 404) throw error;
      this.closeLastSpan(now.toISOString());
    }

    this.sessionId = null;
  }

  /**
   * Gives up the open session locally, without asking the API to close it.
   *
   * Only for revocation: the server has already stopped accepting this device, so a
   * clock-out call can only fail, and continuing to report a session id would show a
   * running session on a device that has stopped collecting.
   */
  abandon(now: Date): void {
    if (this.sessionId === null) return;
    this.closeLastSpan(now.toISOString());
    this.sessionId = null;
  }

  /**
   * Scope §2.2's headline block: total tracked, active, idle, break.
   *
   * Idle and breaks come from the watchers rather than from here — this class owns
   * the sessions those numbers are measured against, and nothing else.
   */
  totalsToday(observed: Omit<DayInput, "sessions">): DayTotals {
    return summariseDay({ ...observed, sessions: this.recorded });
  }

  /** Only one session is open at a time, so the running span is always the last one. */
  private closeLastSpan(endedAt: string): void {
    const open = this.recorded[this.recorded.length - 1];
    if (open === undefined || open.endedAt !== null) return;
    open.endedAt = endedAt;
  }
}
