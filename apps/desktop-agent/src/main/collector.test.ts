import type {
  ActivityBatch,
  ActivityBatchResult,
  ActivityEventInput,
  BreakEventInput,
  HeartbeatInput,
  WebsiteBlockEventsInput,
  IdleEventInput,
  ScreenshotUploadResult,
  WorkSession,
} from "@aems/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig, DayTotals } from "../shared/types/index.js";
import { emptyConfig } from "../shared/types/index.js";
import {
  Collector,
  FLUSH_INTERVAL_MS,
  MAX_ACTIVITY_INTERVAL_MS,
  TICK_INTERVAL_MS,
} from "./collector.js";
import type { CollectorAdapters } from "./collector.js";
import { DEFAULT_MAX_OPEN_BREAK_SECONDS } from "./collector.js";
import { IdleWatcher } from "./idle.js";
import type { DayState } from "./persistence.js";
import { emptyDayState } from "./persistence.js";
import type { CapturedFrame, Capturer } from "./screenshot.js";
import { ScreenshotScheduler } from "./screenshot.js";
import { SessionManager } from "./session.js";
import type { SyncOutcome } from "./sync.js";
import { SyncQueue } from "./sync.js";
import { TELEMETRY_INTERVAL_MS } from "./telemetry.js";
import type { FocusSample } from "./tracker.js";
import { Tracker } from "./tracker.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";
const DEVICE = "33333333-3333-4333-8333-333333333333";

const EPOCH = Date.parse("2026-08-05T09:00:00.000Z");

function at(seconds: number): Date {
  return new Date(EPOCH + seconds * 1000);
}

/**
 * Stands in for `AemsApiError`.
 *
 * Built by hand rather than imported: the repo's vitest alias rewrites relative `.js`
 * specifiers to `.ts`, which breaks a value import of the SDK's compiled bundle.
 */
class ApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "AemsApiError";
  }
}

/** One fake for both roles, because the loop drives one `AemsClient` through both. */
class FakeApi {
  readonly batches: ActivityBatch[] = [];
  readonly heartbeats: HeartbeatInput[] = [];
  readonly blockReports: WebsiteBlockEventsInput[] = [];

  async reportWebsiteBlocks(
    body: WebsiteBlockEventsInput,
  ): Promise<{ accepted: number; rejected: number }> {
    this.blockReports.push(body);
    return { accepted: body.events.length, rejected: 0 };
  }

  readonly uploads: FormData[] = [];
  readonly startCalls: string[] = [];
  readonly endCalls: number[] = [];

  ingestError: unknown = null;
  heartbeatError: unknown = null;
  startError: unknown = null;

  private open: WorkSession | null = null;
  private nextId = 7;

  ingestActivity(batch: ActivityBatch): Promise<ActivityBatchResult> {
    this.batches.push(batch);
    if (this.ingestError !== null) return Promise.reject(this.ingestError);
    return Promise.resolve({
      acceptedActivity: 0,
      acceptedIdle: 0,
      acceptedBreaks: 0,
      acceptedLocations: 0,
      duplicates: 0,
    });
  }

  uploadScreenshot(form: FormData): Promise<ScreenshotUploadResult> {
    this.uploads.push(form);
    return Promise.resolve({ screenshotId: this.uploads.length });
  }

  heartbeat(body: HeartbeatInput): Promise<{ ok: true }> {
    this.heartbeats.push(body);
    if (this.heartbeatError !== null) return Promise.reject(this.heartbeatError);
    return Promise.resolve({ ok: true });
  }

  startWorkSession(deviceId: string): Promise<WorkSession> {
    this.startCalls.push(deviceId);
    if (this.startError !== null) return Promise.reject(this.startError);

    this.open ??= {
      id: this.nextId++,
      company_id: COMPANY,
      profile_id: PROFILE,
      device_id: DEVICE,
      clock_in_at: at(0).toISOString(),
      clock_out_at: null,
      created_at: at(0).toISOString(),
    };
    return Promise.resolve(this.open);
  }

  endWorkSession(workSessionId: number): Promise<WorkSession> {
    this.endCalls.push(workSessionId);
    const open = this.open;
    if (open === null) return Promise.reject(new ApiError("Not found", 404, "not_found"));

    this.open = null;
    return Promise.resolve({ ...open, clock_out_at: at(600).toISOString() });
  }
}

class FakeStore {
  current: AgentConfig;

  constructor(config: AgentConfig) {
    this.current = config;
  }

  update(patch: Partial<AgentConfig>): AgentConfig {
    this.current = { ...this.current, ...patch };
    return this.current;
  }
}

/** Records what the loop asked for, and can refuse on demand like the real route does. */
class FakeTelemetry {
  readonly samples: DayTotals[] = [];
  outcome: SyncOutcome = "sent";
  error: unknown = null;

  report(totals: DayTotals): Promise<SyncOutcome> {
    this.samples.push({ ...totals });
    if (this.error !== null) return Promise.reject(this.error);
    return Promise.resolve(this.outcome);
  }
}

class FakeCapturer implements Capturer {
  calls = 0;

  capture(): Promise<CapturedFrame[]> {
    this.calls += 1;
    return Promise.resolve([{ displayId: "1", image: Buffer.from("jpeg") }]);
  }
}

function consented(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...emptyConfig("http://localhost:3001"),
    deviceId: DEVICE,
    deviceToken: "device-token",
    consentedPolicyVersion: "2026-01",
    policy: {
      version: "2026-01",
      name: "Standard",
      screenshotIntervalSeconds: 300,
      idleThresholdSeconds: 120,
      trackedCategories: [],
    },
    ...overrides,
  };
}

interface Harness {
  collector: Collector;
  api: FakeApi;
  store: FakeStore;
  queue: SyncQueue;
  sessions: SessionManager;
  capturer: FakeCapturer;
  telemetry: FakeTelemetry;
  logs: string[];
  /**
   * What the next focus read returns. Reassign between ticks to move the focus.
   *
   * `reads` counts the OS calls rather than the events they produce, because a
   * switched-off data type must not be *observed* — the tray and the indicator claim
   * what is being collected, and sampling something the employee was told is off makes
   * those claims false whether or not the sample is ever sent.
   */
  focus: { sample: FocusSample | null; error: unknown; reads: number };
  idleSeconds: { value: number; reads: number };
  lockState: { locked: boolean };
}

function harness(config: AgentConfig = consented(), dayState?: FakeDayStore): Harness {
  const api = new FakeApi();
  const store = new FakeStore(config);
  const queue = new SyncQueue(api, DEVICE);
  const sessions = new SessionManager(api, DEVICE);
  const capturer = new FakeCapturer();
  const telemetry = new FakeTelemetry();

  const focus: Harness["focus"] = {
    sample: { appName: "Code", windowTitle: "collector.ts", url: null },
    error: null,
    reads: 0,
  };
  const idleSeconds = { value: 0, reads: 0 };
  const lockState = { locked: false };
  const logs: string[] = [];

  const adapters: Partial<CollectorAdapters> = {
    sampleFocus: () => {
      focus.reads += 1;
      return focus.error === null ? Promise.resolve(focus.sample) : Promise.reject(focus.error);
    },
    readIdleSeconds: () => {
      idleSeconds.reads += 1;
      return idleSeconds.value;
    },
    readIdleState: () => (lockState.locked ? "locked" : "active"),
    now: () => at(0),
    log: (message) => logs.push(message),
  };

  const collector = new Collector(
    {
      config: store,
      queue,
      sessions,
      tracker: new Tracker(),
      idle: new IdleWatcher(),
      screenshots: new ScreenshotScheduler(capturer),
      telemetry,
      dayState,
    },
    adapters,
  );

  return {
    collector,
    api,
    store,
    queue,
    sessions,
    capturer,
    telemetry,
    logs,
    focus,
    idleSeconds,
    lockState,
  };
}

/** Everything the API was actually handed, across however many flushes it took. */
function sentActivity(h: Harness): ActivityEventInput[] {
  return h.api.batches.flatMap((batch) => batch.activity ?? []);
}

function sentIdle(h: Harness): IdleEventInput[] {
  return h.api.batches.flatMap((batch) => batch.idle ?? []);
}

function sentBreaks(h: Harness): BreakEventInput[] {
  return h.api.batches.flatMap((batch) => batch.breaks ?? []);
}

describe("Collector work session lifecycle", () => {
  it("clocks in on the first permitted tick, which is what gives every event a session", async () => {
    const h = harness();

    await h.collector.tick(at(0));

    expect(h.api.startCalls).toEqual([DEVICE]);
    expect(h.sessions.current).toBe(7);
  });

  it("does not open a second session on later ticks", async () => {
    const h = harness();

    await h.collector.tick(at(0));
    await h.collector.tick(at(5));
    await h.collector.tick(at(10));

    expect(h.api.startCalls).toHaveLength(1);
  });

  it("never clocks in or collects while consent is missing", async () => {
    const h = harness(consented({ consentedPolicyVersion: null }));

    await h.collector.tick(at(0));
    await h.collector.tick(at(5));

    expect(h.api.startCalls).toHaveLength(0);
    expect(h.queue.pending).toBe(0);
    expect(h.capturer.calls).toBe(0);
  });

  it("still heartbeats when it may not collect, so the device does not read as offline", async () => {
    const h = harness(consented({ consentedPolicyVersion: null }));

    await h.collector.tick(at(0));

    expect(h.api.heartbeats).toEqual([{ deviceId: DEVICE, workSessionId: null }]);
  });

  it("clocks out when consent is withdrawn mid-day rather than leaving a session open", async () => {
    const h = harness();
    await h.collector.tick(at(0));

    h.store.update({ consentedPolicyVersion: null });
    await h.collector.tick(at(300));

    expect(h.api.endCalls).toEqual([7]);
    expect(h.sessions.current).toBeNull();
  });

  it("drains the open intervals and flushes before it clocks out on shutdown", async () => {
    const h = harness();
    await h.collector.tick(at(0));

    await h.collector.shutdown(at(600));

    // The final batch has to carry the session id: closing the session first would
    // land the last events with a null work_session_id.
    const last = h.api.batches[h.api.batches.length - 1];
    expect(last?.workSessionId).toBe(7);
    expect(last?.activity).toHaveLength(1);
    expect(h.api.endCalls).toEqual([7]);
  });
});

describe("Collector collection", () => {
  it("buffers an activity event when the focus moves", async () => {
    const h = harness();

    await h.collector.tick(at(0));
    h.focus.sample = {
      appName: "Chrome",
      windowTitle: "github.com",
      url: null,
    };
    await h.collector.tick(at(30));

    expect(h.queue.pending).toBe(1);
  });

  it("closes an interval that has run past the cap, so a whole day is not one event", async () => {
    const h = harness();
    await h.collector.tick(at(0));

    await h.collector.tick(new Date(EPOCH + MAX_ACTIVITY_INTERVAL_MS));

    expect(sentActivity(h)).toHaveLength(1);
  });

  it("reopens the rolled interval at the same instant, leaving no untracked gap", async () => {
    const h = harness();
    await h.collector.tick(at(0));
    const rollAt = new Date(EPOCH + MAX_ACTIVITY_INTERVAL_MS);

    await h.collector.tick(rollAt);
    await h.collector.shutdown(new Date(rollAt.getTime() + 60_000));

    const activity = sentActivity(h);
    expect(activity).toHaveLength(2);
    expect(activity[0]?.endedAt).toBe(rollAt.toISOString());
    expect(activity[1]?.startedAt).toBe(rollAt.toISOString());
  });

  it("buffers an idle stretch once the OS counter crosses the policy threshold", async () => {
    const h = harness();
    await h.collector.tick(at(0));

    h.idleSeconds.value = 130;
    await h.collector.tick(at(130));
    h.idleSeconds.value = 5;
    await h.collector.tick(at(135));

    await h.collector.shutdown(at(300));
    expect(sentIdle(h)).toHaveLength(1);
  });

  it("skips capture on a locked screen, because a black frame is worse than a gap", async () => {
    const h = harness();
    h.lockState.locked = true;

    await h.collector.tick(at(0));

    expect(h.capturer.calls).toBe(0);
  });

  it("captures on the first permitted tick and uploads one event per display", async () => {
    const h = harness();

    await h.collector.tick(at(0));

    expect(h.capturer.calls).toBe(1);
    expect(h.api.uploads).toHaveLength(1);
  });

  it("stamps the open session onto the captured frame, not onto the upload", async () => {
    const h = harness();

    await h.collector.tick(at(0));
    await h.collector.shutdown(at(600));

    expect(h.api.uploads[0]?.get("workSessionId")).toBe("7");
  });

  it("keeps ticking when the focus reader throws, rather than going blind", async () => {
    const h = harness();
    h.focus.error = new Error("native binding missing");

    await h.collector.tick(at(0));

    expect(h.logs).toContain("Could not read the focused window");
    expect(h.api.startCalls).toHaveLength(1);
  });
});

describe("Collector sleep", () => {
  it("does not bill a three-hour sleep as work", async () => {
    // The lid closes at 60s and reopens three hours later. Without a suspend hook the
    // next sample simply closes the interval that was open when the machine went to
    // sleep, and the whole sleep is reported as one span of focused work — the single
    // largest way this product could overstate somebody's day.
    const h = harness();
    await h.collector.tick(at(0));

    h.collector.suspend(at(60));
    h.collector.wake(at(10_860));
    await h.collector.tick(at(10_920));
    await h.collector.shutdown(at(11_000));

    // Work after waking is real and may be any length, so the assertion is not "no
    // long interval" — it is that nothing STRADDLES the sleep. An interval opened
    // before the lid shut and closed after it reopened is the three hours being
    // billed, whatever its duration happens to be.
    const straddling = sentActivity(h).filter((event) => {
      const start = Date.parse(event.startedAt);
      const end = event.endedAt == null ? Number.POSITIVE_INFINITY : Date.parse(event.endedAt);
      return start <= at(60).getTime() && end >= at(10_860).getTime();
    });

    expect(straddling).toEqual([]);
  });

  it("closes the interval at the moment of suspend, keeping the work before it", async () => {
    const h = harness();
    await h.collector.tick(at(0));

    h.collector.suspend(at(60));
    await h.collector.shutdown(at(120));

    const ended = sentActivity(h)
      .map((event) => event.endedAt)
      .filter((value): value is string => value !== null && value !== undefined);

    expect(ended).toContain(at(60).toISOString());
  });
});

describe("Collector breaks", () => {
  it("reports a declared break as its own event", async () => {
    const h = harness();
    await h.collector.tick(at(0));

    h.collector.startBreak(at(60));
    h.collector.endBreak(at(360));
    await h.collector.shutdown(at(600));

    expect(sentBreaks(h)).toEqual([
      {
        clientEventId: expect.any(String) as unknown as string,
        breakStartAt: at(60).toISOString(),
        breakEndAt: at(360).toISOString(),
      },
    ]);
  });

  it("pauses capture for the length of a break", async () => {
    const h = harness();
    await h.collector.tick(at(0));
    h.collector.startBreak(at(10));

    await h.collector.tick(at(400));

    expect(h.capturer.calls).toBe(1);
  });

  it("records nothing about what is on screen during a declared break", async () => {
    // Both visible signals already tell the employee a break collects nothing: the
    // tray reads "on a break, nothing is being collected" and the indicator hides.
    // Recording the focused window anyway makes those signals a lie, and captures
    // exactly the private browsing a break is for.
    const h = harness();
    await h.collector.tick(at(0));

    h.collector.startBreak(at(10));
    h.focus.sample = {
      appName: "chrome",
      windowTitle: "Barclays | Personal Banking",
      url: "https://bank.example.com/accounts",
    };
    await h.collector.tick(at(300));
    h.collector.endBreak(at(600));
    await h.collector.shutdown(at(900));

    const leaked = sentActivity(h).filter(
      (event) =>
        event.appName === "chrome" ||
        event.windowTitle?.includes("Barclays") === true ||
        event.domain !== null,
    );
    expect(leaked).toEqual([]);
  });

  it("closes the open interval at the moment the break starts", async () => {
    // The span before the break is real work and must be kept — but it ends when the
    // break begins, not when the employee comes back, or the break is billed as work.
    const h = harness();
    await h.collector.tick(at(0));

    h.collector.startBreak(at(60));
    await h.collector.tick(at(300));
    h.collector.endBreak(at(600));
    await h.collector.shutdown(at(900));

    const ended = sentActivity(h)
      .map((event) => event.endedAt)
      .filter((value): value is string => value !== null && value !== undefined);

    expect(ended).toContain(at(60).toISOString());
  });

  it("refuses to start a break when nothing may be collected", () => {
    const h = harness(consented({ consentedPolicyVersion: null }));

    h.collector.startBreak(at(0));

    expect(h.collector.onBreak).toBe(false);
  });

  it("counts the break against the day, and out of active time", async () => {
    const h = harness();
    await h.collector.tick(at(0));

    h.collector.startBreak(at(60));
    h.collector.endBreak(at(360));
    await h.collector.tick(at(600));

    const totals = h.collector.dayTotals;
    expect(totals.breakSeconds).toBe(300);
    expect(totals.activeSeconds).toBe(totals.totalSeconds - 300);
  });
});

describe("Collector stop signals", () => {
  it("stops and discards the buffer when the API says the device is revoked", async () => {
    const h = harness();
    await h.collector.tick(at(0));
    h.api.ingestError = new ApiError("Device revoked", 403, "device_revoked");
    h.focus.sample = { appName: "Chrome", windowTitle: null, url: null };

    await h.collector.tick(new Date(EPOCH + FLUSH_INTERVAL_MS));

    expect(h.store.current.revoked).toBe(true);
    expect(h.queue.pending).toBe(0);
    expect(h.sessions.current).toBeNull();
  });

  it("does not clock out over the network once revoked, since every call would fail", async () => {
    const h = harness();
    await h.collector.tick(at(0));
    h.api.ingestError = new ApiError("Device revoked", 403, "device_revoked");
    h.focus.sample = { appName: "Chrome", windowTitle: null, url: null };

    await h.collector.tick(new Date(EPOCH + FLUSH_INTERVAL_MS));
    await h.collector.tick(new Date(EPOCH + FLUSH_INTERVAL_MS + 5_000));

    expect(h.api.endCalls).toHaveLength(0);
  });

  it("puts the consent gate back when the API says consent is required", async () => {
    const h = harness();
    await h.collector.tick(at(0));
    h.api.ingestError = new ApiError("Consent required", 403, "consent_required");
    h.focus.sample = { appName: "Chrome", windowTitle: null, url: null };

    await h.collector.tick(new Date(EPOCH + FLUSH_INTERVAL_MS));

    expect(h.store.current.consentedPolicyVersion).toBeNull();
    expect(h.store.current.revoked).toBe(false);
  });

  it("keeps the buffer on consent_required, because consent can come back", async () => {
    const h = harness();
    await h.collector.tick(at(0));
    h.api.ingestError = new ApiError("Consent required", 403, "consent_required");
    h.focus.sample = { appName: "Chrome", windowTitle: null, url: null };

    await h.collector.tick(new Date(EPOCH + FLUSH_INTERVAL_MS));

    expect(h.queue.pending).toBeGreaterThan(0);
  });

  it("acts on a revocation reported by the heartbeat, not only by ingestion", async () => {
    const h = harness(consented({ consentedPolicyVersion: null }));
    h.api.heartbeatError = new ApiError("Device revoked", 403, "device_revoked");

    await h.collector.tick(at(0));

    expect(h.store.current.revoked).toBe(true);
  });
});

describe("Collector day totals", () => {
  it("counts tracked time from the clock-in the server reported", async () => {
    const h = harness();

    await h.collector.tick(at(0));
    await h.collector.tick(at(600));

    expect(h.collector.dayTotals.totalSeconds).toBe(600);
  });

  it("carves an observed idle stretch out of active time", async () => {
    const h = harness();
    await h.collector.tick(at(0));

    h.idleSeconds.value = 300;
    await h.collector.tick(at(300));
    // Input resumed just before this tick, so the OS counter has restarted: the
    // stretch closes at `now - idleSeconds` rather than at `now`.
    h.idleSeconds.value = 5;
    await h.collector.tick(at(305));
    await h.collector.tick(at(600));

    const totals = h.collector.dayTotals;
    expect(totals.idleSeconds).toBe(300);
    expect(totals.activeSeconds).toBe(300);
  });

  it("includes the still-open idle stretch, so the readout does not freeze", async () => {
    const h = harness();
    await h.collector.tick(at(0));

    h.idleSeconds.value = 300;
    await h.collector.tick(at(300));

    expect(h.collector.dayTotals.idleSeconds).toBe(300);
  });
});

const SAMPLE: FocusSample = { appName: "Code", windowTitle: "collector.ts", url: null };

interface Deferred<T> {
  promise: Promise<T>;
  settle: (value: T) => void;
}

/** A promise the test settles by hand, so a tick can be frozen part-way through. */
function deferred<T>(): Deferred<T> {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });

  return { promise, settle };
}

interface TimerHarness {
  collector: Collector;
  api: FakeApi;
  logs: string[];
  /**
   * `focusReads` is the tick counter.
   *
   * It is incremented by the first OS read of a collecting tick, so it counts ticks
   * that actually did the work rather than callbacks that merely fired. `changes` is
   * the other end of the same tick — the loop only reports a change once a pass has
   * run to completion.
   */
  counts: { focusReads: number; changes: number };
  /** When set, the next focus read hangs on it, leaving that tick in flight. */
  hold: { next: Deferred<FocusSample | null> | null };
  /** Makes every pass throw on its way out, standing in for a dead tray or window. */
  failChange: { value: boolean };
}

/**
 * A harness whose clock is the faked one, rather than a constant.
 *
 * The other harness pins `now` so hand-driven ticks are deterministic. Here the loop
 * supplies its own `now`, so the clock has to move with the timers or every automatic
 * tick would be stamped at the same instant and no interval would ever have a length.
 */
function timerHarness(config: AgentConfig = consented()): TimerHarness {
  const api = new FakeApi();
  const store = new FakeStore(config);
  const counts = { focusReads: 0, changes: 0 };
  const hold: TimerHarness["hold"] = { next: null };
  const failChange = { value: false };
  const logs: string[] = [];

  const adapters: Partial<CollectorAdapters> = {
    sampleFocus: () => {
      counts.focusReads += 1;

      const held = hold.next;
      if (held === null) return Promise.resolve(SAMPLE);

      hold.next = null;
      return held.promise;
    },
    readIdleSeconds: () => 0,
    readIdleState: () => "active",
    now: () => new Date(),
    onChanged: () => {
      counts.changes += 1;
      if (failChange.value) throw new Error("tray update failed");
    },
    log: (message) => logs.push(message),
  };

  const collector = new Collector(
    {
      config: store,
      queue: new SyncQueue(api, DEVICE),
      sessions: new SessionManager(api, DEVICE),
      tracker: new Tracker(),
      idle: new IdleWatcher(),
      screenshots: new ScreenshotScheduler(new FakeCapturer()),
    },
    adapters,
  );

  return { collector, api, logs, counts, hold, failChange };
}

/**
 * The interval that makes the agent collect unattended.
 *
 * Every test above hands `tick()` a date, which proves what a pass does and nothing
 * about whether one ever happens on its own. An agent that only collects when
 * something calls it collects nothing at all, so the timer is driven here instead.
 */
describe("Collector interval", () => {
  beforeEach(() => {
    // The clock is faked alongside the timers because an automatic tick takes its `now`
    // from the adapter: a frozen clock would give every interval zero length.
    vi.useFakeTimers({ now: EPOCH });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collects on its own once started, on the tick interval and not before", async () => {
    const h = timerHarness();

    h.collector.start();
    expect(h.counts.focusReads).toBe(0);

    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS - 1);
    expect(h.counts.focusReads).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    // Not merely a callback firing: the first unattended tick clocked in, which is what
    // everything it goes on to collect hangs off.
    expect(h.counts.focusReads).toBe(1);
    expect(h.api.startCalls).toEqual([DEVICE]);

    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 2);
    expect(h.counts.focusReads).toBe(3);
  });

  it("stamps its own ticks from the moving clock, so an unattended interval has a length", async () => {
    const h = timerHarness();

    h.collector.start();
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 6);
    await h.collector.shutdown();

    // Opened by the first automatic tick at +5s and closed by the shutdown at +30s. A
    // loop that passed a fixed date instead would report a 0-second interval, which is
    // an employee who used an application for no time at all.
    const [interval] = h.api.batches.flatMap((batch) => batch.activity ?? []);
    expect(interval?.startedAt).toBe(new Date(EPOCH + TICK_INTERVAL_MS).toISOString());
    expect(interval?.endedAt).toBe(new Date(EPOCH + TICK_INTERVAL_MS * 6).toISOString());
  });

  it("ignores a second start(), because two timers would collect the same day twice", async () => {
    const h = timerHarness();

    h.collector.start();
    h.collector.start();

    // Asserted on the timer itself as well as on the collection: two intervals firing
    // in lockstep are hidden by the re-entrancy latch on some schedules and not others.
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
    expect(h.counts.focusReads).toBe(1);
  });

  it("stops dead on stop(): nothing is collected afterwards", async () => {
    const h = timerHarness();

    h.collector.start();
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 2);
    expect(h.counts.focusReads).toBe(2);

    h.collector.stop();
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 20);

    // Consent withdrawn, a revoked device, an employee who quit for the day: every one
    // of them ends at stop(), so a timer left running here is collection without consent.
    expect(h.counts.focusReads).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps ticking after a tick throws, since a dead loop looks like an idle employee", async () => {
    const h = timerHarness();
    h.failChange.value = true;

    h.collector.start();
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 2);

    // Reported rather than swallowed: two ticks failed and the agent still says so.
    expect(h.logs.filter((line) => line === "Collection tick failed")).toHaveLength(2);

    h.failChange.value = false;
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);

    expect(h.counts.focusReads).toBe(3);
  });

  it("does not let a slow tick overlap itself, which would collect the same slice twice", async () => {
    const h = timerHarness();
    const held = deferred<FocusSample | null>();
    h.hold.next = held;

    h.collector.start();
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 3);

    // Three fires, one collection: a flush over a slow uplink outlasts the interval
    // routinely, and the ticks that land on top of it have to be dropped rather than
    // queued behind it.
    expect(h.counts.focusReads).toBe(1);

    held.settle(SAMPLE);
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);

    expect(h.counts.focusReads).toBe(2);
  });

  it("lets an in-flight tick finish when stop() lands mid-pass, and releases the loop", async () => {
    const h = timerHarness();
    const held = deferred<FocusSample | null>();
    h.hold.next = held;

    h.collector.start();
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
    h.collector.stop();

    held.settle(SAMPLE);
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 3);

    // The frozen pass ran to its end instead of being abandoned half-collected, and no
    // later one started behind it.
    expect(h.counts.changes).toBe(1);
    expect(h.counts.focusReads).toBe(1);

    // The re-entrancy latch came back too, so the loop is restartable rather than wedged
    // shut by whichever tick happened to be running when the tray said stop.
    await h.collector.tick();
    expect(h.counts.focusReads).toBe(2);
  });
});

/**
 * The durable store, in memory.
 *
 * The point of the seam is that a restart is testable without a crash: the same
 * document the previous process would have left on disk is simply handed to the next
 * `Collector`.
 */
class FakeDayStore {
  state: DayState;

  constructor(initial: Partial<DayState> = {}) {
    this.state = { ...emptyDayState(), ...initial };
  }

  load(): DayState {
    return this.state;
  }

  update(patch: Partial<DayState>): DayState {
    this.state = { ...this.state, ...patch };
    return this.state;
  }
}

function restarted(store: FakeDayStore, config: AgentConfig = consented()): Harness {
  return harness(config, store);
}

describe("Collector durability", () => {
  it("reopens the focus interval a crash interrupted at the moment it actually began", async () => {
    const store = new FakeDayStore({
      openFocus: {
        appName: "Chrome",
        windowTitle: "AEMS",
        url: null,
        domain: null,
        startedAt: at(-600).toISOString(),
      },
    });
    const h = restarted(store);

    // A different app is in focus now, so the restored interval closes and is emitted.
    h.focus.sample = { appName: "Code", windowTitle: "collector.ts", url: null };
    await h.collector.tick(at(0));

    expect(sentActivity(h)).toEqual([
      expect.objectContaining({ appName: "Chrome", startedAt: at(-600).toISOString() }),
    ]);
  });

  it("writes the open focus interval down on every tick, so the next launch can reopen it", async () => {
    const store = new FakeDayStore();
    const h = restarted(store);

    await h.collector.tick(at(0));

    expect(store.state.openFocus).toEqual(
      expect.objectContaining({ appName: "Code", startedAt: at(0).toISOString() }),
    );
  });

  it("keeps yesterday's crash from crediting a restarted day as fully active", async () => {
    const store = new FakeDayStore({
      idleSpans: [{ startedAt: at(60).toISOString(), endedAt: at(120).toISOString() }],
    });
    const h = restarted(store);

    await h.collector.tick(at(300));

    // The session runs from at(0); without the restored carve-out the whole 300s reads
    // as worked, which is the direction that flatters the employee's numbers.
    expect(h.collector.dayTotals.idleSeconds).toBe(60);
  });

  it("resumes a break the agent was killed during, rather than billing lunch as work", async () => {
    const store = new FakeDayStore({ openBreakSince: at(-1_800).toISOString() });
    const h = restarted(store);

    expect(h.collector.onBreak).toBe(true);
  });

  it("restores the capture schedule, so a restart loop cannot outpace the consented interval", async () => {
    const store = new FakeDayStore({ lastCaptureAt: at(-10).toISOString() });
    const h = restarted(store);

    await h.collector.tick(at(0));

    // The policy says every 300s and a frame was taken 10s ago. A launch that read
    // "never captured" would fire immediately on every reboot.
    expect(h.capturer.calls).toBe(0);
  });

  it("records the open idle stretch and break, which exist nowhere else until they close", async () => {
    const store = new FakeDayStore();
    const h = restarted(store);

    h.idleSeconds.value = 600;
    await h.collector.tick(at(0));

    expect(store.state.openIdleSince).toBe(at(-600).toISOString());
  });
});

describe("device telemetry", () => {
  it("sends a sample on the first tick, so a device row is never blank for a minute", async () => {
    const h = harness();

    await h.collector.tick(at(0));

    expect(h.telemetry.samples).toHaveLength(1);
  });

  it("sends on the heartbeat cadence rather than on every five-second tick", async () => {
    const h = harness();

    await h.collector.tick(at(0));
    await h.collector.tick(at(5));
    await h.collector.tick(at(30));
    expect(h.telemetry.samples).toHaveLength(1);

    await h.collector.tick(at(TELEMETRY_INTERVAL_MS / 1000));
    expect(h.telemetry.samples).toHaveLength(2);
  });

  it("carries today's active seconds, which is the honest reading for screen-active time", async () => {
    const h = harness();

    await h.collector.tick(at(0));
    await h.collector.tick(at(TELEMETRY_INTERVAL_MS / 1000));

    // A session opened at tick one, so by the second sample the day has run.
    expect(h.telemetry.samples[1]?.activeSeconds).toBeGreaterThan(0);
  });

  it("sends nothing while the consent gate is closed, because the route is consent-gated", async () => {
    const h = harness(consented({ consentedPolicyVersion: null }));

    await h.collector.tick(at(0));

    expect(h.telemetry.samples).toHaveLength(0);
    // The heartbeat still goes, which is the whole distinction between the two.
    expect(h.api.heartbeats).toHaveLength(1);
  });

  it("stops collecting when the telemetry route reports the device revoked", async () => {
    const h = harness();
    h.telemetry.outcome = "revoked";

    await h.collector.tick(at(0));

    expect(h.store.current.revoked).toBe(true);
  });

  it("reopens the consent gate when the telemetry route says consent has lapsed", async () => {
    const h = harness();
    h.telemetry.outcome = "consent-required";

    await h.collector.tick(at(0));

    expect(h.store.current.consentedPolicyVersion).toBeNull();
  });

  it("logs a throwing reporter rather than killing the tick it runs inside", async () => {
    const h = harness();
    h.telemetry.error = new Error("statfs exploded");

    await h.collector.tick(at(0));

    expect(h.logs).toContain("Could not report device telemetry");
    // The rest of the tick still happened.
    expect(h.api.heartbeats).toHaveLength(1);
  });
});

/**
 * Clocking out for the day.
 *
 * The control exists so an employee can stop being monitored without quitting the
 * agent — an app somebody has to quit to get their evening back is one they will quit
 * permanently, and a monitoring agent that is not running is worse for everybody than
 * one that is running and honestly idle.
 *
 * So the property under test is not "endDay sets a flag". It is that the answer
 * *sticks*: nothing is observed afterwards, a restart does not undo it, and it lifts by
 * itself when the day actually rolls over rather than needing anyone to remember.
 */
describe("ending the day", () => {
  it("closes the work session and stops observing", async () => {
    const h = harness();
    await h.collector.tick(at(0));
    expect(h.sessions.current).not.toBeNull();

    await h.collector.endDay(at(60));

    expect(h.collector.dayEnded).toBe(true);
    expect(h.sessions.current).toBeNull();

    // The tick after clock-out must not reopen anything. This is the assertion that
    // matters: a flag that every other code path ignores is not a clock-out.
    h.focus.sample = { appName: "Code", windowTitle: "after hours", url: null };
    await h.collector.tick(at(120));
    expect(h.sessions.current).toBeNull();
  });

  it("records nothing at all once the day is over — screen, keyboard or camera", async () => {
    // The button says "End day" and the tray says "finished for today, nothing is being
    // collected". This is the test that those two sentences are true, rather than a
    // session id going null while the watchers keep running. The sibling assertion for
    // a break ("records nothing about what is on screen during a declared break")
    // existed; the same one for a finished day did not, which is how three surfaces
    // came to claim monitoring over a stopped loop without a single test failing.
    const h = harness();
    await h.collector.tick(at(0));

    const capturesBefore = h.capturer.calls;
    await h.collector.endDay(at(60));

    h.focus.sample = {
      appName: "chrome",
      windowTitle: "Barclays | Personal Banking",
      url: "https://bank.example.com/accounts",
    };
    h.idleSeconds.value = 9_999;

    const idleBefore = sentIdle(h).length;

    await h.collector.tick(at(120));
    await h.collector.tick(at(600));
    await h.collector.shutdown(at(900));

    const leaked = sentActivity(h).filter(
      (event) => event.appName === "chrome" || event.windowTitle?.includes("Barclays") === true,
    );

    expect(leaked).toEqual([]);
    expect(h.capturer.calls).toBe(capturesBefore);
    expect(sentIdle(h).length).toBe(idleBefore);
  });

  it("is idempotent, so a double click cannot close a second session", async () => {
    const h = harness();
    await h.collector.tick(at(0));
    await h.collector.endDay(at(60));
    const sessionCalls = h.api.endCalls.length;

    await h.collector.endDay(at(90));
    expect(h.api.endCalls.length).toBe(sessionCalls);
  });

  it("survives a restart on the same day", () => {
    // The whole point of persisting it. Someone who clocks out at 18:00 and reboots at
    // 21:00 must not find themselves being recorded again.
    const store = new FakeDayStore({ dayEndedAt: at(60).toISOString() });
    const h = harness(consented(), store);
    expect(h.collector.dayEnded).toBe(true);
  });

  it("lifts by itself the next day", async () => {
    // Yesterday's clock-out must not silence today, and nobody should have to remember
    // to switch monitoring back on.
    const yesterday = new Date(at(0).getTime() - 26 * 3600 * 1000);
    const store = new FakeDayStore({ dayEndedAt: yesterday.toISOString() });
    const h = harness(consented(), store);

    expect(h.collector.dayEnded).toBe(false);
    await h.collector.tick(at(0));
    expect(h.sessions.current).not.toBeNull();
  });

  it("starts a fresh session when someone carries on working", async () => {
    const h = harness();
    await h.collector.tick(at(0));
    await h.collector.endDay(at(60));

    h.collector.startDay(at(120));
    expect(h.collector.dayEnded).toBe(false);

    // A new session, not the old one reopened — an afternoon after a false clock-out is
    // honestly two sessions, and that is the shape the reports already understand.
    await h.collector.tick(at(180));
    expect(h.sessions.current).not.toBeNull();
  });
});

/**
 * A break nobody came back from.
 *
 * Observed in the field: 7h 51m of "break" beside 1h 06m of active work. An open break
 * has no natural end — the day summary resolves an unterminated span at the current
 * instant — so someone who declares a break and shuts the lid banks the whole night as
 * tracked time. A manager reading that dashboard cannot tell it from a real day.
 */
describe("an abandoned break", () => {
  it("ends the day, at the moment the break started", async () => {
    const h = harness();
    await h.collector.tick(at(0));
    h.collector.startBreak(at(60));

    // Still a plausible break: nothing happens.
    await h.collector.tick(at(60 + DEFAULT_MAX_OPEN_BREAK_SECONDS - 60));
    expect(h.collector.dayEnded).toBe(false);

    // Past the ceiling: the person went home.
    await h.collector.tick(at(60 + DEFAULT_MAX_OPEN_BREAK_SECONDS + 60));
    expect(h.collector.dayEnded).toBe(true);
    expect(h.sessions.current).toBeNull();
  });

  it("does not bank the abandoned hours as tracked time", async () => {
    const h = harness();
    await h.collector.tick(at(0));
    h.collector.startBreak(at(60));
    await h.collector.tick(at(60 + DEFAULT_MAX_OPEN_BREAK_SECONDS + 60));

    // The whole point. Ending at `now` would count every hour of the break as tracked;
    // ending at the break start says what happened — work stopped there.
    expect(h.collector.dayTotals.breakSeconds).toBeLessThan(DEFAULT_MAX_OPEN_BREAK_SECONDS);
  });

  /*
   * The limit is an admin's, not the agent's. A workforce that takes a two-hour site
   * visit and one that never breaks past lunch want different numbers, and the agent is
   * a binary on someone's laptop — the wrong place to decide it.
   */
  it("obeys the policy's limit over its own default", async () => {
    const policy = consented().policy!;
    const h = harness(consented({ policy: { ...policy, maxOpenBreakSeconds: 3600 } }));
    await h.collector.tick(at(0));
    h.collector.startBreak(at(60));

    // Past the policy's hour but nowhere near the five-hour default. A collector still
    // reading its own constant would leave the day open here.
    await h.collector.tick(at(60 + 3600 + 60));
    expect(h.collector.dayEnded).toBe(true);
  });

  /*
   * A policy stored before the field existed carries no value for it. Reading that
   * absence as "no limit" would restore the overnight-billing bug the guard was added
   * for, which is the expensive direction to be wrong in.
   */
  it("falls back to its default when the policy does not say", async () => {
    const h = harness();
    // What the case rests on, asserted rather than assumed: the harness policy predates
    // the field, so the two tests above are exercising the fallback too. Setting it in
    // `consented()` would quietly turn all three into tests of the policy path.
    expect(consented().policy?.maxOpenBreakSeconds).toBeUndefined();

    await h.collector.tick(at(0));
    h.collector.startBreak(at(60));

    await h.collector.tick(at(60 + DEFAULT_MAX_OPEN_BREAK_SECONDS - 60));
    expect(h.collector.dayEnded).toBe(false);

    await h.collector.tick(at(60 + DEFAULT_MAX_OPEN_BREAK_SECONDS + 60));
    expect(h.collector.dayEnded).toBe(true);
  });

  it("leaves a short break alone", async () => {
    const h = harness();
    await h.collector.tick(at(0));
    h.collector.startBreak(at(60));
    await h.collector.tick(at(60 + 45 * 60));

    // Lunch is not an abandoned day.
    expect(h.collector.dayEnded).toBe(false);
    expect(h.sessions.current).not.toBeNull();
  });
});

/**
 * The per-device collection scope, at the loop that acts on it.
 *
 * The rule these defend is stricter than "do not send it": a switched-off type must
 * never be *observed*. The tray tooltip and the always-on-top indicator both claim what
 * is being collected, so an agent that samples the focused window while the employee
 * has been told applications are off is making those two signals false — and they are
 * what non-negotiable #2 is made of.
 *
 * Each was verified by mutation: every `mayCollectType` call below was replaced with
 * `mayCollect`, the corresponding case was confirmed to fail, and the call restored.
 */
describe("Collector per-device collection scope", () => {
  const EVERYTHING = [
    "applications",
    "websites",
    "screenshots",
    "idle",
    "telemetry",
    "installed_apps",
  ] as const;

  it("behaves exactly as before on a device with no scope of its own", async () => {
    // The deploy case. Zero settings rows exist, so every enrolled device holds a null
    // scope and must go on collecting precisely what it collected yesterday.
    const h = harness(consented({ collection: null }));

    await h.collector.tick(at(0));

    expect(h.focus.reads).toBe(1);
    expect(h.idleSeconds.reads).toBe(1);
    expect(h.capturer.calls).toBe(1);
    expect(h.telemetry.samples).toHaveLength(1);
  });

  it("collects the same four things when the scope names everything", async () => {
    const h = harness(consented({ collection: [...EVERYTHING] }));

    await h.collector.tick(at(0));

    expect(h.focus.reads).toBe(1);
    expect(h.idleSeconds.reads).toBe(1);
    expect(h.capturer.calls).toBe(1);
    expect(h.telemetry.samples).toHaveLength(1);
  });

  it("never reads the focused window when applications are switched off", async () => {
    const h = harness(consented({ collection: ["idle", "screenshots", "telemetry"] }));

    await h.collector.tick(at(0));
    h.focus.sample = { appName: "Chrome", windowTitle: "github.com", url: null };
    await h.collector.tick(at(30));
    await h.collector.shutdown(at(60));

    expect(h.focus.reads).toBe(0);
    expect(sentActivity(h)).toHaveLength(0);
  });

  it("never reads the OS idle counter when idle is switched off", async () => {
    const h = harness(consented({ collection: ["applications", "screenshots", "telemetry"] }));

    h.idleSeconds.value = 600;
    await h.collector.tick(at(0));
    await h.collector.tick(at(300));
    await h.collector.shutdown(at(600));

    expect(h.idleSeconds.reads).toBe(0);
    expect(sentIdle(h)).toHaveLength(0);
  });

  it("takes no frame when screenshots are switched off", async () => {
    const h = harness(consented({ collection: ["applications", "idle", "telemetry"] }));

    await h.collector.tick(at(0));
    await h.collector.tick(at(600));

    expect(h.capturer.calls).toBe(0);
  });

  it("sends no battery or network sample when telemetry is switched off", async () => {
    const h = harness(consented({ collection: ["applications", "idle", "screenshots"] }));

    await h.collector.tick(at(0));
    await h.collector.tick(new Date(EPOCH + TELEMETRY_INTERVAL_MS));

    expect(h.telemetry.samples).toHaveLength(0);
  });

  it("keeps heartbeating with everything switched off, so the device is not read as gone", async () => {
    // A scope of nothing is still an enrolled, consented device. `last_seen_at` drives
    // online/offline in the dashboard and carries no observation, which is why the
    // heartbeat is not a switchable type.
    const h = harness(consented({ collection: [] }));

    await h.collector.tick(at(0));

    expect(h.api.heartbeats).toEqual([{ deviceId: DEVICE, workSessionId: 7 }]);
    expect(h.focus.reads).toBe(0);
    expect(h.capturer.calls).toBe(0);
  });

  it("closes the interval that was open when applications were switched off, once", async () => {
    // Left open it would be flushed hours later as one unbroken stretch of focused
    // work — an event produced by a type the employee had been told was off.
    const h = harness();

    await h.collector.tick(at(0));
    h.store.update({ collection: ["idle"] });
    await h.collector.tick(at(30));
    await h.collector.tick(at(60));
    await h.collector.shutdown(at(90));

    const activity = sentActivity(h);
    expect(activity).toHaveLength(1);
    expect(activity[0]?.endedAt).toBe(at(30).toISOString());
  });

  it("closes the idle stretch that was open when idle was switched off, once", async () => {
    const h = harness();

    h.idleSeconds.value = 600;
    await h.collector.tick(at(0));
    h.store.update({ collection: ["applications"] });
    await h.collector.tick(at(30));
    await h.collector.tick(at(60));
    await h.collector.shutdown(at(90));

    const idle = sentIdle(h);
    expect(idle).toHaveLength(1);
    expect(idle[0]?.idleEndAt).toBe(at(30).toISOString());
  });

  it("resumes collecting a type an administrator switches back on, without a restart", async () => {
    const h = harness(consented({ collection: ["idle"] }));

    await h.collector.tick(at(0));
    expect(h.capturer.calls).toBe(0);

    h.store.update({ collection: ["idle", "screenshots"] });
    await h.collector.tick(at(5));

    expect(h.capturer.calls).toBe(1);
  });
});
