import { randomUUID } from "node:crypto";

import type { BreakEventInput, IdleEventInput } from "@aems/types";

/** `powerMonitor.getSystemIdleState`, with `locked` treated as idle by the caller. */
export type IdleState = "active" | "idle" | "locked" | "unknown";

/** The slice of Electron's `powerMonitor` this module needs. */
export interface SystemIdleSource {
  getSystemIdleTime(): number;
  getSystemIdleState(idleThreshold: number): string;
}

let systemIdleSource: SystemIdleSource | null = null;

/**
 * Attaches the OS idle counter, injected once at startup.
 *
 * `powerMonitor` is only meaningful inside a running Electron main process, so
 * importing it here would drag an Electron runtime into every test of the pure
 * interval logic below. `index.ts` owns the import and hands it in.
 */
export function setSystemIdleSource(source: SystemIdleSource | null): void {
  systemIdleSource = source;
}

export function readIdleSeconds(): number {
  return systemIdleSource?.getSystemIdleTime() ?? 0;
}

const IDLE_STATES: readonly IdleState[] = ["active", "idle", "locked", "unknown"];

/**
 * Reports zero / `unknown` rather than throwing when nothing is attached.
 *
 * A collection tick that throws would take the whole loop down; a tick that reports no
 * idle merely under-collects, which is the safer failure for a monitoring agent.
 */
export function readIdleState(thresholdSeconds: number): IdleState {
  const state = systemIdleSource?.getSystemIdleState(thresholdSeconds);
  return IDLE_STATES.find((known) => known === state) ?? "unknown";
}

/**
 * How far the backdated start may drift forward before it counts as a counter reset.
 *
 * `getSystemIdleTime` returns whole seconds while `now` carries milliseconds, so
 * `now - idleSeconds` wanders inside a one-second band across the ticks of a single
 * unbroken stretch. Splitting on that would shatter every stretch into poll-sized pieces.
 */
const COUNTER_RESET_TOLERANCE_MS = 2_000;

/**
 * Turns a sampled idle counter into closed idle intervals, and tracks explicit breaks.
 *
 * Idle intervals deliberately overlap activity intervals rather than splitting them.
 * The server subtracts idle from active (`@aems/analytics` `difference()`), so an
 * agent that also split focus intervals around idle would have the time removed twice.
 *
 * Breaks are the exception to that overlap: the server subtracts them the same way, so
 * a break and an inferred idle stretch covering the same seconds would be deducted
 * twice. An explicit break therefore wins — the employee saying where they are beats
 * the agent guessing from a keyboard counter.
 *
 * Pure by construction: `now` is always a parameter and nothing here reads a clock or
 * touches the OS, which is what lets the whole contract be tested without Electron.
 */
export class IdleWatcher {
  private idleStart: Date | null = null;
  /** Last tick that actually observed idle — the only end we can honestly claim on a split. */
  private lastIdleAt: Date | null = null;
  private breakStart: Date | null = null;
  /** Floor for backdated idle starts: seconds before this belong to the break. */
  private lastBreakEnd: Date | null = null;

  /** True while an explicit break is running, which the tray and the readout both show. */
  get onBreak(): boolean {
    return this.breakStart !== null;
  }

  /**
   * The still-open idle stretch and break, so the day's totals can include time that
   * has not ended yet. Reporting only closed spans would leave the readout frozen for
   * the whole of a long break — the one moment somebody checks it.
   */
  get openIdleSince(): Date | null {
    return this.idleStart;
  }

  get openBreakSince(): Date | null {
    return this.breakStart;
  }

  /**
   * Reopens the stretches a previous process was still timing.
   *
   * Both are unbounded losses otherwise, and both fail in the direction that flatters
   * the employee's numbers: an absence killed at minute 44 reports as active, and a
   * crash during lunch credits the whole hour as worked.
   *
   * A stretch already open here wins — this is only ever called at construction, and
   * silently discarding live observations in favour of a stale file would be worse than
   * not restoring at all.
   */
  resume(state: { idleSince: Date | null; breakSince: Date | null }): void {
    this.idleStart ??= state.idleSince;
    this.breakStart ??= state.breakSince;
  }

  /**
   * Threshold is inclusive.
   *
   * The start is backdated to `now - idleSeconds`: to when input actually stopped,
   * not to when we noticed. Otherwise every idle stretch silently loses the whole
   * threshold — a dozen breaks a day at a 120s threshold is ~25 minutes of idle
   * reported as active. Once open, the start is never refreshed, or a 40-minute
   * break collapses to one poll interval.
   *
   * The end is backdated the same way: when input resumes the OS counter restarts,
   * so closing at `now` over-reports the stretch by up to a full poll period.
   */
  observeIdle(idleSeconds: number, thresholdSeconds: number, now: Date): IdleEventInput | null {
    // An explicit break outranks inferred idle: the employee has already told us where
    // they are, and the server subtracts both from active time, so tracking them
    // concurrently would remove the same span twice.
    if (this.breakStart !== null) return null;

    // A zero or negative threshold makes `idleSeconds >= threshold` unconditionally true,
    // so the stretch opens on the first tick and can never close — the agent looks idle
    // forever and emits nothing. Floor it instead of trusting the policy.
    const isIdle = idleSeconds >= Math.max(1, thresholdSeconds);
    const stoppedAt = new Date(now.getTime() - idleSeconds * 1000);

    if (!isIdle) return this.closeIdle(stoppedAt);

    // A break ended while the employee was still away leaves the OS counter reaching
    // back through it, so an unclamped backdate would report the whole break as idle a
    // second time.
    const openAt =
      this.lastBreakEnd !== null && stoppedAt.getTime() < this.lastBreakEnd.getTime()
        ? this.lastBreakEnd
        : stoppedAt;

    if (this.idleStart === null) {
      this.idleStart = openAt;
      this.lastIdleAt = now;
      return null;
    }

    // The counter having jumped forward past the open start proves it restarted, so the
    // employee was active between two polls. Close the old stretch at the last tick that
    // observed it — the unwitnessed gap belongs to neither stretch — and open a new one.
    if (openAt.getTime() > this.idleStart.getTime() + COUNTER_RESET_TOLERANCE_MS) {
      const closed = this.closeIdle(this.lastIdleAt ?? openAt);
      this.idleStart = openAt;
      this.lastIdleAt = now;
      return closed;
    }

    this.lastIdleAt = now;
    return null;
  }

  /** Closes an open idle stretch on shutdown, so quitting while away does not erase it. */
  flush(now: Date): IdleEventInput | null {
    return this.closeIdle(now);
  }

  /**
   * Begins an explicit break, returning the idle stretch it truncated, if any.
   *
   * Idle running up to the break is real and is kept; it is closed at the break start
   * so the two never claim the same seconds. A second call while a break is open is
   * ignored rather than restarting it, which would lose the earlier portion.
   */
  startBreak(now: Date): IdleEventInput | null {
    if (this.breakStart !== null) return null;
    this.breakStart = now;
    return this.closeIdle(now);
  }

  /** Closes the open break. Returns null when none is open, so a stray end is harmless. */
  endBreak(now: Date): BreakEventInput | null {
    return this.closeBreak(now);
  }

  /**
   * Closes an open break on shutdown.
   *
   * Separate from `flush` because the two produce different wire shapes; `before-quit`
   * drains both. Without it, quitting during a break drops the break entirely and the
   * span reverts to untracked time.
   */
  flushBreak(now: Date): BreakEventInput | null {
    return this.closeBreak(now);
  }

  private closeBreak(end: Date): BreakEventInput | null {
    const started = this.breakStart;
    if (started === null) return null;
    this.breakStart = null;
    this.lastBreakEnd = end;

    if (end.getTime() <= started.getTime()) return null;

    return {
      clientEventId: randomUUID(),
      breakStartAt: started.toISOString(),
      breakEndAt: end.toISOString(),
    };
  }

  private closeIdle(end: Date): IdleEventInput | null {
    const started = this.idleStart;
    if (started === null) return null;
    this.idleStart = null;
    this.lastIdleAt = null;

    // Clamping against a break end, or a backwards clock step, can leave nothing behind.
    // An empty interval is queue noise the API would happily store forever.
    if (end.getTime() <= started.getTime()) return null;

    return {
      clientEventId: randomUUID(),
      idleStartAt: started.toISOString(),
      idleEndAt: end.toISOString(),
    };
  }
}
