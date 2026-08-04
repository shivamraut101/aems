import type { AgentConfig, DaySpan, DayTotals } from "../shared/types/index.js";
import { emptyTotals, mayCollect } from "../shared/types/index.js";
import type { IdleState } from "./idle.js";
import { IdleWatcher, readIdleSeconds, readIdleState } from "./idle.js";
import { ScreenshotScheduler } from "./screenshot.js";
import { SessionManager } from "./session.js";
import { classifyError, SyncQueue } from "./sync.js";
import type { FocusSample } from "./tracker.js";
import { sampleFocus, Tracker } from "./tracker.js";

/**
 * How often the frontmost window and the OS idle counter are read.
 *
 * Five seconds is the resolution of every interval the agent reports, so it is also
 * the worst-case error on any one of them. Polling faster buys accuracy nobody reads
 * off a timeline and costs a wakeup on a laptop battery.
 */
export const TICK_INTERVAL_MS = 5_000;

/** Ceiling on how long a single focus interval may run before it is closed and reopened. */
export const MAX_ACTIVITY_INTERVAL_MS = 5 * 60_000;

export const FLUSH_INTERVAL_MS = 60_000;
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** Used when a policy arrived without one, matching the API's own default. */
export const DEFAULT_IDLE_THRESHOLD_SECONDS = 300;

/** The two `ConfigStore` members the loop needs, narrowed so tests need no disk. */
export interface CollectorConfigStore {
  readonly current: AgentConfig;
  update(patch: Partial<AgentConfig>): AgentConfig;
}

/**
 * Everything the loop reads from outside itself.
 *
 * The OS readers and the clock are injected rather than imported at the call site, so
 * the whole wiring — consent gate, session lifecycle, stop signals — is exercisable in
 * a plain Node process. The defaults are the real ones, so `index.ts` supplies none.
 */
export interface CollectorAdapters {
  sampleFocus: () => Promise<FocusSample | null>;
  readIdleSeconds: () => number;
  readIdleState: (thresholdSeconds: number) => IdleState;
  now: () => Date;
  /** Called whenever the loop changes anything the tray or the renderer displays. */
  onChanged: () => void;
  log: (message: string, error?: unknown) => void;
}

export interface CollectorParts {
  config: CollectorConfigStore;
  queue: SyncQueue;
  sessions: SessionManager;
  tracker: Tracker;
  idle: IdleWatcher;
  screenshots: ScreenshotScheduler;
}

const DEFAULT_ADAPTERS: CollectorAdapters = {
  sampleFocus,
  readIdleSeconds,
  readIdleState,
  now: () => new Date(),
  onChanged: () => {},
  log: (message, error) => {
    console.error(`[aems] ${message}`, error);
  },
};

/**
 * The collection loop: the thing that makes every other module in `main/` do anything.
 *
 * It owns three responsibilities the modules deliberately do not. It re-reads the
 * consent gate on every tick, so consent withdrawn from the dashboard stops collection
 * without a restart. It drives the work session, so events land against a clock-in
 * rather than a null `work_session_id` — the single biggest gap in the previous agent.
 * And it acts on the sync engine's stop signals, which the engine reports but
 * deliberately does not obey on its own.
 *
 * Nothing here reads a clock or the OS directly; both arrive through `CollectorAdapters`.
 */
export class Collector {
  private readonly parts: CollectorParts;
  private readonly adapters: CollectorAdapters;

  private timer: ReturnType<typeof setInterval> | null = null;
  /** A slow flush must not let ticks stack up behind it and send the same slice twice. */
  private running = false;

  private lastFlushAt: Date | null = null;
  private lastHeartbeatAt: Date | null = null;

  /**
   * Closed idle stretches and breaks observed today.
   *
   * Held here rather than in the watchers because they are only needed to compute the
   * day's totals, which is this loop's job. In-memory only: a restart re-adopts the
   * open work session but not the stretches carved out of it, so the totals read high
   * until the server-side report catches up.
   */
  private readonly idleSpans: DaySpan[] = [];
  private readonly breakSpans: DaySpan[] = [];

  private totals: DayTotals = emptyTotals();

  constructor(parts: CollectorParts, adapters: Partial<CollectorAdapters> = {}) {
    this.parts = parts;
    this.adapters = { ...DEFAULT_ADAPTERS, ...adapters };
  }

  get dayTotals(): DayTotals {
    return this.totals;
  }

  get onBreak(): boolean {
    return this.parts.idle.onBreak;
  }

  start(): void {
    if (this.timer !== null) return;
    // `unref` is deliberately not called: this timer is the reason the process stays
    // alive between windows being closed.
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Public so a test can drive the loop without waiting for real seconds. */
  async tick(now: Date = this.adapters.now()): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await this.run(now);
    } catch (error) {
      // A tick that throws would kill the interval and leave the agent alive but blind,
      // which looks exactly like an employee who stopped working.
      this.adapters.log("Collection tick failed", error);
    } finally {
      this.running = false;
    }
  }

  private async run(now: Date): Promise<void> {
    const collecting = mayCollect(this.parts.config.current);

    if (collecting) {
      await this.ensureSession();
      await this.collect(now);
      await this.maybeFlush(now);
    } else {
      await this.pause(now);
    }

    // Heartbeats are not collection: `last_seen_at` drives online/offline in the
    // dashboard, and the route has no consent gate. An enrolled but unconsented
    // device that stopped heartbeating would read as one that had vanished.
    await this.maybeHeartbeat(now);

    this.recomputeTotals(now);
    this.adapters.onChanged();
  }

  private async collect(now: Date): Promise<void> {
    const config = this.parts.config.current;
    const threshold = config.policy?.idleThresholdSeconds ?? DEFAULT_IDLE_THRESHOLD_SECONDS;
    const state = this.readState(threshold);

    await this.observeFocus(now);
    this.observeIdle(threshold, now);
    await this.capture(config, now, state === "locked");
  }

  private readState(threshold: number): IdleState {
    try {
      return this.adapters.readIdleState(threshold);
    } catch (error) {
      this.adapters.log("Could not read the session lock state", error);
      return "unknown";
    }
  }

  private async observeFocus(now: Date): Promise<void> {
    let sample: FocusSample | null;

    try {
      sample = await this.adapters.sampleFocus();
    } catch (error) {
      // A missing native binding throws here on every tick. Reported rather than
      // swallowed, because silent failure is indistinguishable from an idle machine.
      this.adapters.log("Could not read the focused window", error);
      return;
    }

    this.rollLongInterval(now);

    const event = this.parts.tracker.observeFocus(sample, now);
    if (event !== null) this.parts.queue.enqueueActivity(event);
  }

  /**
   * Closes an interval that has run past the cap and lets the same tick reopen it.
   *
   * Closing at `now` and reopening at `now` leaves no gap, so a day spent in one editor
   * becomes a row of five-minute intervals instead of one event that exists nowhere
   * until shutdown — and that a crash would take with it.
   */
  private rollLongInterval(now: Date): void {
    const openedAt = this.parts.tracker.openedAt;
    if (openedAt === null) return;
    if (now.getTime() - openedAt.getTime() < MAX_ACTIVITY_INTERVAL_MS) return;

    const rolled = this.parts.tracker.flush(now);
    if (rolled !== null) this.parts.queue.enqueueActivity(rolled);
  }

  private observeIdle(threshold: number, now: Date): void {
    let seconds: number;

    try {
      seconds = this.adapters.readIdleSeconds();
    } catch (error) {
      this.adapters.log("Could not read the OS idle counter", error);
      return;
    }

    const event = this.parts.idle.observeIdle(seconds, threshold, now);
    if (event === null) return;

    this.parts.queue.enqueueIdle(event);
    this.idleSpans.push({
      startedAt: event.idleStartAt,
      endedAt: event.idleEndAt ?? null,
    });
  }

  private async capture(config: AgentConfig, now: Date, locked: boolean): Promise<void> {
    // A declared break is time the employee has told us they are not working. Capturing
    // through it would record their screen for a span the report already excludes.
    if (this.parts.idle.onBreak) return;

    try {
      const shots = await this.parts.screenshots.tick(
        {
          config,
          sessionLocked: locked,
          workSessionId: this.parts.sessions.current,
        },
        now,
      );
      for (const shot of shots) this.parts.queue.enqueueScreenshot(shot);
    } catch (error) {
      this.adapters.log("Screen capture failed", error);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.parts.sessions.current !== null) return;

    try {
      await this.parts.sessions.start();
    } catch (error) {
      // The route gates on consent too, so a clock-in is another place the server can
      // tell us to stop. Everything else is a transient the next tick retries.
      this.applyOutcome(classifyError(error), this.adapters.now());
      this.adapters.log("Could not start a work session", error);
    }
  }

  /**
   * Winds collection down when the gate closes, exactly once.
   *
   * Consent withdrawn mid-day must not leave an open interval and an open session
   * behind: the interval would be attributed to whenever the agent next started, and
   * the session would stay open until an administrator closed it by hand.
   */
  private async pause(now: Date): Promise<void> {
    const revoked = this.parts.config.current.revoked;

    // Revocation is immediate, so what was observed before the server said stop is
    // dropped rather than replayed if the device is ever re-enrolled.
    this.drain(now, { keep: !revoked });
    if (revoked) this.parts.queue.discard();

    if (this.parts.sessions.current === null) return;

    if (revoked) {
      this.parts.sessions.abandon(now);
      return;
    }

    // Consent lapsing is not revocation: the clock-out route has no consent gate, so
    // the session can still be closed properly.
    await this.endSession(now);
  }

  /** Closes the open focus interval, idle stretch and break, buffering them or not. */
  private drain(now: Date, options: { keep: boolean }): void {
    const activity = this.parts.tracker.flush(now);
    const idle = this.parts.idle.flush(now);
    const taken = this.parts.idle.flushBreak(now);

    if (!options.keep) return;

    if (activity !== null) this.parts.queue.enqueueActivity(activity);
    if (idle !== null) {
      this.parts.queue.enqueueIdle(idle);
      this.idleSpans.push({
        startedAt: idle.idleStartAt,
        endedAt: idle.idleEndAt ?? null,
      });
    }
    if (taken !== null) {
      this.parts.queue.enqueueBreak(taken);
      this.breakSpans.push({
        startedAt: taken.breakStartAt,
        endedAt: taken.breakEndAt ?? null,
      });
    }
  }

  private async endSession(now: Date): Promise<void> {
    try {
      await this.parts.sessions.end(now);
    } catch (error) {
      this.adapters.log("Could not close the work session", error);
    }
  }

  private async maybeFlush(now: Date): Promise<void> {
    if (!this.due(this.lastFlushAt, FLUSH_INTERVAL_MS, now)) return;

    // Stamped before the attempt: a flush that hangs or fails must not be retried on
    // every tick, because the failure is usually the network being gone.
    this.lastFlushAt = now;
    this.applyOutcome(await this.parts.queue.flush(this.parts.sessions.current, now), now);
  }

  private async maybeHeartbeat(now: Date): Promise<void> {
    if (!this.due(this.lastHeartbeatAt, HEARTBEAT_INTERVAL_MS, now)) return;

    this.lastHeartbeatAt = now;
    this.applyOutcome(await this.parts.queue.heartbeat(this.parts.sessions.current), now);
  }

  /** A clock that jumped backwards must not suspend syncing until it catches up. */
  private due(last: Date | null, intervalMs: number, now: Date): boolean {
    if (last === null) return true;
    const elapsed = now.getTime() - last.getTime();
    return elapsed < 0 || elapsed >= intervalMs;
  }

  /**
   * Acts on what the server said, which the sync engine reports but does not obey.
   *
   * Both signals are written to the config rather than held in memory, so the gate is
   * still closed after a restart and the renderer sees the same state the loop does.
   */
  private applyOutcome(outcome: string, now: Date): void {
    if (outcome === "revoked") {
      this.parts.config.update({ revoked: true });
      this.parts.queue.discard();
      this.parts.sessions.abandon(now);
      this.adapters.log("This device has been revoked; collection has stopped");
      return;
    }

    if (outcome === "consent-required") {
      // Clearing the accepted version is what closes `mayCollect` and puts the consent
      // gate back in front of the employee. The buffer is kept: consent may return.
      this.parts.config.update({ consentedPolicyVersion: null });
      this.adapters.log("Consent is no longer on file; collection has paused");
    }
  }

  /** Declares a break. Idle running up to it is kept and closed at the break start. */
  startBreak(now: Date = this.adapters.now()): void {
    if (!mayCollect(this.parts.config.current)) return;

    const truncated = this.parts.idle.startBreak(now);
    if (truncated !== null) {
      this.parts.queue.enqueueIdle(truncated);
      this.idleSpans.push({
        startedAt: truncated.idleStartAt,
        endedAt: truncated.idleEndAt ?? null,
      });
    }

    this.recomputeTotals(now);
    this.adapters.onChanged();
  }

  endBreak(now: Date = this.adapters.now()): void {
    const taken = this.parts.idle.endBreak(now);
    if (taken !== null) {
      this.parts.queue.enqueueBreak(taken);
      this.breakSpans.push({
        startedAt: taken.breakStartAt,
        endedAt: taken.breakEndAt ?? null,
      });
    }

    this.recomputeTotals(now);
    this.adapters.onChanged();
  }

  /**
   * Drains everything and clocks out, in that order.
   *
   * Flushing before the clock-out is what gives the last events a session to hang off;
   * closing the session first would leave them with a null `work_session_id`, which is
   * the state scope §2.2 cannot aggregate over.
   */
  async shutdown(now: Date = this.adapters.now()): Promise<void> {
    this.stop();

    const collecting = mayCollect(this.parts.config.current);
    this.drain(now, { keep: collecting });

    if (collecting) {
      this.applyOutcome(await this.parts.queue.flush(this.parts.sessions.current, now), now);
    }

    if (this.parts.sessions.current !== null) await this.endSession(now);
    this.recomputeTotals(now);
  }

  /**
   * Scope §2.2's headline block, recomputed from what has been observed today.
   *
   * The still-open idle stretch and break are included as unterminated spans so the
   * readout keeps moving during a long break instead of freezing at its start.
   */
  private recomputeTotals(now: Date): void {
    const dayStart = startOfDay(now);
    this.prune(dayStart);

    const openIdle = this.parts.idle.openIdleSince;
    const openBreak = this.parts.idle.openBreakSince;

    this.totals = this.parts.sessions.totalsToday({
      idle: openIdle === null ? this.idleSpans : [...this.idleSpans, open(openIdle)],
      breaks: openBreak === null ? this.breakSpans : [...this.breakSpans, open(openBreak)],
      dayStart,
      now,
    });
  }

  /** Yesterday's spans cannot affect today's totals, and an agent runs for weeks. */
  private prune(dayStart: Date): void {
    discardBefore(this.idleSpans, dayStart);
    discardBefore(this.breakSpans, dayStart);
  }
}

function open(since: Date): DaySpan {
  return { startedAt: since.toISOString(), endedAt: null };
}

function discardBefore(spans: DaySpan[], dayStart: Date): void {
  const kept = spans.filter((span) => {
    const end = span.endedAt === null ? Number.POSITIVE_INFINITY : Date.parse(span.endedAt);
    return !Number.isFinite(end) || end >= dayStart.getTime();
  });

  if (kept.length === spans.length) return;
  spans.length = 0;
  spans.push(...kept);
}

/** Local midnight — the day boundary an employee and their manager both mean. */
function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
