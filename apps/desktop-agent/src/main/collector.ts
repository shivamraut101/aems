import type { AgentConfig, DaySpan, DayTotals } from "../shared/types/index.js";
import { emptyTotals, mayCollect } from "../shared/types/index.js";
import type { IdleState } from "./idle.js";
import { IdleWatcher, readIdleSeconds, readIdleState } from "./idle.js";
import type { DayState } from "./persistence.js";
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

/**
 * The slice of `DayStateStore` the loop uses.
 *
 * Narrowed for the same reason `SyncJournal` is: a test of "a restart resumes" should
 * hand over the document the previous process would have left, not build a filesystem.
 */
export interface CollectorDayStore {
  load(): DayState;
  update(patch: Partial<DayState>): DayState;
}

export interface CollectorParts {
  config: CollectorConfigStore;
  queue: SyncQueue;
  sessions: SessionManager;
  tracker: Tracker;
  idle: IdleWatcher;
  screenshots: ScreenshotScheduler;
  /**
   * Where the parts of today that live only in memory are kept across a restart.
   *
   * Optional so a caller that genuinely wants a volatile loop — and every test that
   * does not care — still constructs one. Absent, the agent behaves as it did: a
   * mid-day restart under-reports until the server-side report catches up.
   */
  dayState?: CollectorDayStore;
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
    this.resume();
  }

  /**
   * Re-adopts what the previous process was still timing, before the first tick.
   *
   * Every field restored here is one that exists nowhere but memory until it closes:
   * a focus interval only becomes an event when focus moves away, an idle stretch only
   * when input returns, a break only when the employee ends it. All three fail in the
   * same direction if they are dropped — the day reads as more worked than it was.
   *
   * Order matters: the watchers are seeded before `start()` is ever called, so nothing
   * observed by this process can be overwritten by a stale document.
   */
  private resume(): void {
    const store = this.parts.dayState;
    if (store === undefined) return;

    const restored = store.load();

    if (restored.openFocus !== null) this.parts.tracker.resume(restored.openFocus);

    this.parts.idle.resume({
      idleSince: parseStamp(restored.openIdleSince),
      breakSince: parseStamp(restored.openBreakSince),
    });

    const lastCapture = parseStamp(restored.lastCaptureAt);
    if (lastCapture !== null) this.parts.screenshots.resume(lastCapture);

    this.idleSpans.push(...restored.idleSpans);
    this.breakSpans.push(...restored.breakSpans);
  }

  /**
   * Writes today's volatile half down.
   *
   * Called on every path that can change it rather than on a timer of its own: the
   * window a crash has to land in is the whole point, and a store written once a minute
   * would simply move the loss rather than remove it. The document is a few kilobytes
   * and is published by rename, so this is one small write per five-second tick.
   */
  private persistDay(): void {
    const store = this.parts.dayState;
    if (store === undefined) return;

    try {
      store.update({
        idleSpans: [...this.idleSpans],
        breakSpans: [...this.breakSpans],
        openFocus: this.parts.tracker.openFocus,
        openIdleSince: this.parts.idle.openIdleSince?.toISOString() ?? null,
        openBreakSince: this.parts.idle.openBreakSince?.toISOString() ?? null,
        lastCaptureAt: this.parts.screenshots.lastCaptureAt?.toISOString() ?? null,
      });
    } catch (error) {
      // A full disk or a revoked directory ACL must cost the safety net, not the
      // collection — the same trade `SyncQueue` makes for the event journal.
      this.adapters.log("Could not persist today's collection state", error);
    }
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
    this.persistDay();
    this.adapters.onChanged();
  }

  private async collect(now: Date): Promise<void> {
    const config = this.parts.config.current;
    const threshold = config.policy?.idleThresholdSeconds ?? DEFAULT_IDLE_THRESHOLD_SECONDS;
    const state = this.readState(threshold);

    // A declared break gates the WHOLE observation, not just capture. Both visible
    // signals already say a break collects nothing — the tray reads "on a break,
    // nothing is being collected" and the indicator hides — so sampling the focused
    // window through one would make those signals a lie, and would record exactly
    // the private browsing a break exists for.
    if (!this.parts.idle.onBreak) {
      await this.observeFocus(now);
      this.observeIdle(threshold, now);
    }

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

    // Close the open interval AT the break, not when they come back. Left open it
    // would be reported as one unbroken stretch of work spanning lunch — the break
    // billed as the very thing it is meant to exclude.
    const openInterval = this.parts.tracker.flush(now);
    if (openInterval !== null) this.parts.queue.enqueueActivity(openInterval);

    const truncated = this.parts.idle.startBreak(now);
    if (truncated !== null) {
      this.parts.queue.enqueueIdle(truncated);
      this.idleSpans.push({
        startedAt: truncated.idleStartAt,
        endedAt: truncated.idleEndAt ?? null,
      });
    }

    this.recomputeTotals(now);
    this.persistDay();
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
    this.persistDay();
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
    // A clean exit closed every open stretch, so what is written here is a document with
    // nothing left open — which is exactly what stops the next launch reopening spans
    // that already became events.
    this.persistDay();
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

/** A stamp the store could not vouch for costs its own field, never the launch. */
function parseStamp(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
