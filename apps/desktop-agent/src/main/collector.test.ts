import type {
  ActivityBatch,
  ActivityBatchResult,
  ActivityEventInput,
  BreakEventInput,
  HeartbeatInput,
  IdleEventInput,
  ScreenshotUploadResult,
  WorkSession,
} from "@aems/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "../shared/types/index.js";
import { emptyConfig } from "../shared/types/index.js";
import {
  Collector,
  FLUSH_INTERVAL_MS,
  MAX_ACTIVITY_INTERVAL_MS,
  TICK_INTERVAL_MS,
} from "./collector.js";
import type { CollectorAdapters } from "./collector.js";
import { IdleWatcher } from "./idle.js";
import type { DayState } from "./persistence.js";
import { emptyDayState } from "./persistence.js";
import type { CapturedFrame, Capturer } from "./screenshot.js";
import { ScreenshotScheduler } from "./screenshot.js";
import { SessionManager } from "./session.js";
import { SyncQueue } from "./sync.js";
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
  logs: string[];
  /** What the next focus read returns. Reassign between ticks to move the focus. */
  focus: { sample: FocusSample | null; error: unknown };
  idleSeconds: { value: number };
  lockState: { locked: boolean };
}

function harness(config: AgentConfig = consented(), dayState?: FakeDayStore): Harness {
  const api = new FakeApi();
  const store = new FakeStore(config);
  const queue = new SyncQueue(api, DEVICE);
  const sessions = new SessionManager(api, DEVICE);
  const capturer = new FakeCapturer();

  const focus: Harness["focus"] = {
    sample: { appName: "Code", windowTitle: "collector.ts", url: null },
    error: null,
  };
  const idleSeconds = { value: 0 };
  const lockState = { locked: false };
  const logs: string[] = [];

  const adapters: Partial<CollectorAdapters> = {
    sampleFocus: () =>
      focus.error === null ? Promise.resolve(focus.sample) : Promise.reject(focus.error),
    readIdleSeconds: () => idleSeconds.value,
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
