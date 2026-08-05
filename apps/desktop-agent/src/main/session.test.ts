import { describe, expect, it } from "vitest";

import type { WorkSession } from "@aems/types";

import { SessionManager, summariseDay } from "./session.js";
import type { DaySpan } from "../shared/types/index.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";
const DEVICE = "33333333-3333-4333-8333-333333333333";

function workSession(id: number, clockInAt: string, clockOutAt: string | null = null): WorkSession {
  return {
    id,
    company_id: COMPANY,
    profile_id: PROFILE,
    device_id: DEVICE,
    clock_in_at: clockInAt,
    clock_out_at: clockOutAt,
    created_at: clockInAt,
  };
}

/**
 * Stands in for the API's session routes.
 *
 * Mirrors the two properties the real endpoints have that the state machine depends
 * on: `POST /sessions` hands back the already-open session, and `POST /sessions/:id/end`
 * 404s when there is nothing open to close.
 */
class FakeSessionApi {
  readonly startCalls: string[] = [];
  readonly endCalls: number[] = [];

  private nextId: number;
  private open: WorkSession | null = null;

  clockInAt = "2026-08-05T09:00:00.000Z";
  clockOutAt = "2026-08-05T17:00:00.000Z";
  startError: unknown = null;
  endError: unknown = null;

  constructor(firstId = 7) {
    this.nextId = firstId;
  }

  /** Pre-seeds an open session, as the server would have after an agent crash. */
  seedOpen(session: WorkSession): void {
    this.open = session;
  }

  startWorkSession(deviceId: string): Promise<WorkSession> {
    this.startCalls.push(deviceId);
    if (this.startError !== null) return Promise.reject(this.startError);

    this.open ??= workSession(this.nextId++, this.clockInAt);
    return Promise.resolve(this.open);
  }

  endWorkSession(workSessionId: number): Promise<WorkSession> {
    this.endCalls.push(workSessionId);
    if (this.endError !== null) return Promise.reject(this.endError);

    const open = this.open;
    if (open === null || open.id !== workSessionId) {
      return Promise.reject(apiError("not_found", 404));
    }

    this.open = null;
    return Promise.resolve({ ...open, clock_out_at: this.clockOutAt });
  }
}

/** Shaped like `AemsApiError` without importing it, so a built SDK is not a test dependency. */
function apiError(code: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(code), { code, statusCode });
}

describe("SessionManager.start", () => {
  it("clocks in and exposes the session id the API hands back", async () => {
    const api = new FakeSessionApi(7);
    const manager = new SessionManager(api, DEVICE);

    expect(manager.current).toBeNull();
    await expect(manager.start()).resolves.toBe(7);
    expect(manager.current).toBe(7);
    expect(api.startCalls).toEqual([DEVICE]);
  });

  it("does not clock in twice when a session is already open", async () => {
    const api = new FakeSessionApi(7);
    const manager = new SessionManager(api, DEVICE);

    await manager.start();
    await expect(manager.start()).resolves.toBe(7);

    expect(api.startCalls).toHaveLength(1);
    expect(manager.current).toBe(7);
  });

  it("shares one in-flight clock-in between overlapping callers", async () => {
    const api = new FakeSessionApi(7);
    const manager = new SessionManager(api, DEVICE);

    const both = await Promise.all([manager.start(), manager.start()]);

    expect(both).toEqual([7, 7]);
    expect(api.startCalls).toHaveLength(1);
  });

  it("surfaces a failed clock-in and stays retryable", async () => {
    const api = new FakeSessionApi(7);
    const manager = new SessionManager(api, DEVICE);

    api.startError = apiError("consent_required", 403);
    await expect(manager.start()).rejects.toMatchObject({
      code: "consent_required",
    });
    expect(manager.current).toBeNull();

    api.startError = null;
    await expect(manager.start()).resolves.toBe(7);
  });
});

describe("SessionManager.end", () => {
  it("clocks out the open session and forgets it", async () => {
    const api = new FakeSessionApi(7);
    const manager = new SessionManager(api, DEVICE);

    await manager.start();
    await manager.end();

    expect(api.endCalls).toEqual([7]);
    expect(manager.current).toBeNull();
  });

  it("treats a 404 as already closed rather than a failure", async () => {
    const api = new FakeSessionApi(7);
    const manager = new SessionManager(api, DEVICE);

    await manager.start();
    api.endError = apiError("not_found", 404);

    await expect(manager.end()).resolves.toBeUndefined();
    expect(manager.current).toBeNull();
  });

  it("keeps the session id after a failed clock-out so the close can be retried", async () => {
    const api = new FakeSessionApi(7);
    const manager = new SessionManager(api, DEVICE);

    await manager.start();
    api.endError = apiError("session_failed", 500);
    await expect(manager.end()).rejects.toMatchObject({ statusCode: 500 });

    expect(manager.current).toBe(7);

    api.endError = null;
    await manager.end();
    expect(api.endCalls).toEqual([7, 7]);
    expect(manager.current).toBeNull();
  });

  it("makes no request when there is nothing open to close", async () => {
    const api = new FakeSessionApi(7);
    const manager = new SessionManager(api, DEVICE);

    await expect(manager.end()).resolves.toBeUndefined();
    expect(api.endCalls).toEqual([]);
  });
});

describe("SessionManager across a restart", () => {
  it("clocks in again after a clock-out rather than reusing the closed id", async () => {
    const api = new FakeSessionApi(7);
    const manager = new SessionManager(api, DEVICE);

    await manager.start();
    await manager.end();
    await expect(manager.start()).resolves.toBe(8);

    expect(api.startCalls).toHaveLength(2);
  });

  it("adopts the session the API was already holding open, clock-in time and all", async () => {
    const api = new FakeSessionApi(7);
    api.seedOpen(workSession(42, "2026-08-05T09:00:00.000Z"));

    const manager = new SessionManager(api, DEVICE);
    await manager.start();

    // The agent restarted at lunchtime; the day still starts at 09:00, not now.
    expect(manager.current).toBe(42);
    expect(manager.spans).toEqual([{ startedAt: "2026-08-05T09:00:00.000Z", endedAt: null }]);
  });

  it("closes the recorded span with the clock-out the server stamped", async () => {
    const api = new FakeSessionApi(7);
    api.clockInAt = "2026-08-05T09:00:00.000Z";
    api.clockOutAt = "2026-08-05T12:30:00.000Z";

    const manager = new SessionManager(api, DEVICE);
    await manager.start();
    await manager.end();

    expect(manager.spans).toEqual([
      {
        startedAt: "2026-08-05T09:00:00.000Z",
        endedAt: "2026-08-05T12:30:00.000Z",
      },
    ]);
  });

  it("closes the span at the observed time when the server says it is already closed", async () => {
    const api = new FakeSessionApi(7);
    api.clockInAt = "2026-08-05T09:00:00.000Z";

    const manager = new SessionManager(api, DEVICE);
    await manager.start();
    api.endError = apiError("not_found", 404);
    await manager.end(new Date("2026-08-05T12:00:00.000Z"));

    // Leaving it open would let a session the server has already closed keep
    // accruing tracked time for the rest of the day.
    expect(manager.spans).toEqual([
      {
        startedAt: "2026-08-05T09:00:00.000Z",
        endedAt: "2026-08-05T12:00:00.000Z",
      },
    ]);
  });
});

const DAY_START = new Date("2026-08-05T00:00:00.000Z");

function span(startedAt: string, endedAt: string | null): DaySpan {
  return { startedAt, endedAt };
}

describe("summariseDay", () => {
  it("counts a closed session as tracked time, all of it active", () => {
    const totals = summariseDay({
      sessions: [span("2026-08-05T09:00:00.000Z", "2026-08-05T17:00:00.000Z")],
      idle: [],
      breaks: [],
      dayStart: DAY_START,
      now: new Date("2026-08-05T18:00:00.000Z"),
    });

    expect(totals).toEqual({
      totalSeconds: 8 * 3600,
      activeSeconds: 8 * 3600,
      idleSeconds: 0,
      breakSeconds: 0,
    });
  });

  it("subtracts idle from active instead of adding it to tracked time", () => {
    const totals = summariseDay({
      sessions: [span("2026-08-05T09:00:00.000Z", "2026-08-05T10:00:00.000Z")],
      idle: [span("2026-08-05T09:20:00.000Z", "2026-08-05T09:40:00.000Z")],
      breaks: [],
      dayStart: DAY_START,
      now: new Date("2026-08-05T11:00:00.000Z"),
    });

    expect(totals).toEqual({
      totalSeconds: 3600,
      activeSeconds: 2400,
      idleSeconds: 1200,
      breakSeconds: 0,
    });
  });

  it("carves break time out of active as well", () => {
    const totals = summariseDay({
      sessions: [span("2026-08-05T09:00:00.000Z", "2026-08-05T10:00:00.000Z")],
      idle: [],
      breaks: [span("2026-08-05T09:30:00.000Z", "2026-08-05T09:45:00.000Z")],
      dayStart: DAY_START,
      now: new Date("2026-08-05T11:00:00.000Z"),
    });

    expect(totals).toEqual({
      totalSeconds: 3600,
      activeSeconds: 2700,
      idleSeconds: 0,
      breakSeconds: 900,
    });
  });

  it("counts idle inside a break once, so the parts still sum to the total", () => {
    const totals = summariseDay({
      sessions: [span("2026-08-05T09:00:00.000Z", "2026-08-05T10:00:00.000Z")],
      idle: [span("2026-08-05T09:35:00.000Z", "2026-08-05T09:50:00.000Z")],
      breaks: [span("2026-08-05T09:30:00.000Z", "2026-08-05T09:45:00.000Z")],
      dayStart: DAY_START,
      now: new Date("2026-08-05T11:00:00.000Z"),
    });

    // The ten minutes of overlap are one stretch of not-working, and a declared
    // break is the more specific description of it.
    expect(totals).toEqual({
      totalSeconds: 3600,
      activeSeconds: 2400,
      idleSeconds: 300,
      breakSeconds: 900,
    });
    expect(totals.activeSeconds + totals.idleSeconds + totals.breakSeconds).toBe(
      totals.totalSeconds,
    );
  });

  it("keeps the parts summing to the total when the spans are not whole seconds", () => {
    const totals = summariseDay({
      sessions: [span("2026-08-05T09:00:00.000Z", "2026-08-05T09:00:10.400Z")],
      idle: [span("2026-08-05T09:00:05.000Z", "2026-08-05T09:00:07.500Z")],
      breaks: [span("2026-08-05T09:00:00.000Z", "2026-08-05T09:00:03.500Z")],
      dayStart: DAY_START,
      now: new Date("2026-08-05T11:00:00.000Z"),
    });

    expect(totals.totalSeconds).toBe(10);
    expect(totals.activeSeconds + totals.idleSeconds + totals.breakSeconds).toBe(
      totals.totalSeconds,
    );
    expect(
      Math.min(totals.activeSeconds, totals.idleSeconds, totals.breakSeconds),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe("SessionManager.totalsToday", () => {
  it("reports the day across a clock-out and a second clock-in", async () => {
    const api = new FakeSessionApi(7);
    api.clockInAt = "2026-08-05T09:00:00.000Z";
    api.clockOutAt = "2026-08-05T12:00:00.000Z";

    const manager = new SessionManager(api, DEVICE);
    await manager.start();
    await manager.end();

    api.clockInAt = "2026-08-05T13:00:00.000Z";
    await manager.start();

    const totals = manager.totalsToday({
      idle: [span("2026-08-05T10:00:00.000Z", "2026-08-05T10:30:00.000Z")],
      breaks: [],
      dayStart: DAY_START,
      now: new Date("2026-08-05T14:00:00.000Z"),
    });

    // Three hours before lunch plus one since, minus the half hour idle.
    expect(totals).toEqual({
      totalSeconds: 4 * 3600,
      activeSeconds: 4 * 3600 - 1800,
      idleSeconds: 1800,
      breakSeconds: 0,
    });
  });
});

/**
 * Stands in for `DayStateStore`, which is the real implementation.
 *
 * Copies on the way in and out: `SessionManager` closes the running span by mutating
 * it, and a store that handed back its own array would make the "restored" manager
 * share state with the dead one instead of reloading it.
 */
class FakeSpanStore {
  saved: DaySpan[] = [];
  writes = 0;

  loadSessions(): readonly DaySpan[] {
    return this.saved.map((span) => ({ ...span }));
  }

  saveSessions(spans: readonly DaySpan[]): void {
    this.writes += 1;
    this.saved = spans.map((span) => ({ ...span }));
  }
}

describe("SessionManager durability", () => {
  it("re-adopts the sessions already recorded today, so a restart does not shorten the day", async () => {
    const store = new FakeSpanStore();
    const api = new FakeSessionApi(7);
    api.clockInAt = "2026-08-05T09:00:00.000Z";
    api.clockOutAt = "2026-08-05T12:00:00.000Z";

    const morning = new SessionManager(api, DEVICE, store);
    await morning.start();
    await morning.end();

    // SIGKILL over lunch. Only the *open* session is re-adopted from the API, so
    // without the store the morning simply disappears from the day's total.
    api.clockInAt = "2026-08-05T13:00:00.000Z";
    const afternoon = new SessionManager(api, DEVICE, store);
    await afternoon.start();

    expect(afternoon.spans).toEqual([
      { startedAt: "2026-08-05T09:00:00.000Z", endedAt: "2026-08-05T12:00:00.000Z" },
      { startedAt: "2026-08-05T13:00:00.000Z", endedAt: null },
    ]);
    expect(
      afternoon.totalsToday({
        idle: [],
        breaks: [],
        dayStart: DAY_START,
        now: new Date("2026-08-05T14:00:00.000Z"),
      }).totalSeconds,
    ).toBe(4 * 3600);
  });

  it("does not list the still-open session twice when the API hands the same one back", async () => {
    const store = new FakeSpanStore();
    const api = new FakeSessionApi(7);
    api.seedOpen(workSession(42, "2026-08-05T09:00:00.000Z"));

    const before = new SessionManager(api, DEVICE, store);
    await before.start();

    // The relaunch restores the span from the store *and* re-adopts it from the API.
    const after = new SessionManager(api, DEVICE, store);
    await after.start();

    expect(after.spans).toEqual([{ startedAt: "2026-08-05T09:00:00.000Z", endedAt: null }]);
  });
});

describe("summariseDay boundaries", () => {
  it("counts a still-open session up to now and no further", () => {
    const totals = summariseDay({
      sessions: [span("2026-08-05T09:00:00.000Z", null)],
      idle: [],
      breaks: [],
      dayStart: DAY_START,
      now: new Date("2026-08-05T11:30:00.000Z"),
    });

    expect(totals.totalSeconds).toBe(2.5 * 3600);
  });

  it("counts a session that ran past midnight only from the start of the day", () => {
    const totals = summariseDay({
      sessions: [span("2026-08-04T22:00:00.000Z", "2026-08-05T02:00:00.000Z")],
      idle: [],
      breaks: [],
      dayStart: DAY_START,
      now: new Date("2026-08-05T09:00:00.000Z"),
    });

    expect(totals.totalSeconds).toBe(2 * 3600);
  });

  it("ignores idle observed while clocked out", () => {
    const totals = summariseDay({
      sessions: [span("2026-08-05T09:00:00.000Z", "2026-08-05T10:00:00.000Z")],
      idle: [span("2026-08-05T11:00:00.000Z", "2026-08-05T11:30:00.000Z")],
      breaks: [],
      dayStart: DAY_START,
      now: new Date("2026-08-05T12:00:00.000Z"),
    });

    expect(totals).toEqual({
      totalSeconds: 3600,
      activeSeconds: 3600,
      idleSeconds: 0,
      breakSeconds: 0,
    });
  });

  it("does not let two overlapping sessions inflate the day past the clock", () => {
    const totals = summariseDay({
      sessions: [
        span("2026-08-05T09:00:00.000Z", "2026-08-05T11:00:00.000Z"),
        span("2026-08-05T10:00:00.000Z", "2026-08-05T12:00:00.000Z"),
      ],
      idle: [],
      breaks: [],
      dayStart: DAY_START,
      now: new Date("2026-08-05T13:00:00.000Z"),
    });

    expect(totals.totalSeconds).toBe(3 * 3600);
  });

  it("reports a day with nothing tracked as four zeroes", () => {
    const totals = summariseDay({
      sessions: [],
      idle: [span("2026-08-05T09:00:00.000Z", "2026-08-05T09:30:00.000Z")],
      breaks: [],
      dayStart: DAY_START,
      now: new Date("2026-08-05T12:00:00.000Z"),
    });

    expect(totals).toEqual({
      totalSeconds: 0,
      activeSeconds: 0,
      idleSeconds: 0,
      breakSeconds: 0,
    });
  });
});
