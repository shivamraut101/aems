import { describe, expect, it } from "vitest";

import type { ActivityEvent, IdleEvent } from "@aems/types";

import { difference, merge, totalSeconds } from "./intervals.js";
import { buildTimeline, rankApps, summarisePeriod } from "./productivity.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";
const DEVICE = "33333333-3333-4333-8333-333333333333";

function activity(
  appName: string,
  startedAt: string,
  endedAt: string | null,
  category: string | null = null,
): ActivityEvent {
  return {
    id: 1,
    company_id: COMPANY,
    profile_id: PROFILE,
    device_id: DEVICE,
    work_session_id: null,
    app_name: appName,
    window_title: null,
    url: null,
    domain: null,
    category,
    started_at: startedAt,
    ended_at: endedAt,
    client_event_id: "c",
    created_at: startedAt,
  };
}

function idle(startAt: string, endAt: string | null): IdleEvent {
  return {
    id: 1,
    company_id: COMPANY,
    profile_id: PROFILE,
    device_id: DEVICE,
    idle_start_at: startAt,
    idle_end_at: endAt,
    duration_seconds: null,
    client_event_id: "c",
    created_at: startAt,
  };
}

describe("merge", () => {
  it("collapses overlapping intervals", () => {
    expect(merge([{ start: 0, end: 10 }, { start: 5, end: 20 }])).toEqual([{ start: 0, end: 20 }]);
  });

  it("keeps disjoint intervals apart", () => {
    expect(merge([{ start: 0, end: 10 }, { start: 20, end: 30 }])).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
  });

  it("joins intervals that merely touch", () => {
    expect(merge([{ start: 0, end: 10 }, { start: 10, end: 20 }])).toEqual([{ start: 0, end: 20 }]);
  });

  it("drops zero-length and malformed intervals", () => {
    expect(merge([{ start: 5, end: 5 }, { start: 10, end: 1 }, { start: NaN, end: 4 }])).toEqual([]);
  });
});

describe("difference", () => {
  it("punches a hole in the middle", () => {
    expect(difference([{ start: 0, end: 100 }], [{ start: 40, end: 60 }])).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ]);
  });

  it("removes an interval swallowed whole", () => {
    expect(difference([{ start: 10, end: 20 }], [{ start: 0, end: 100 }])).toEqual([]);
  });

  it("leaves non-overlapping intervals untouched", () => {
    expect(difference([{ start: 0, end: 10 }], [{ start: 50, end: 60 }])).toEqual([
      { start: 0, end: 10 },
    ]);
  });
});

describe("summarisePeriod", () => {
  const periodStart = "2026-08-05T09:00:00.000Z";
  const periodEnd = "2026-08-05T10:00:00.000Z";

  it("counts a single uninterrupted hour as fully active", () => {
    const summary = summarisePeriod({
      profileId: PROFILE,
      periodStart,
      periodEnd,
      activity: [activity("code.exe", periodStart, periodEnd)],
      idle: [],
    });

    expect(summary.activeSeconds).toBe(3600);
    expect(summary.idleSeconds).toBe(0);
    expect(summary.productivityRatio).toBe(1);
  });

  it("subtracts idle time from active rather than adding to it", () => {
    // 20 minutes idle inside a focused hour. Active must be 40min, not 60.
    const summary = summarisePeriod({
      profileId: PROFILE,
      periodStart,
      periodEnd,
      activity: [activity("code.exe", periodStart, periodEnd)],
      idle: [idle("2026-08-05T09:20:00.000Z", "2026-08-05T09:40:00.000Z")],
    });

    expect(summary.activeSeconds).toBe(2400);
    expect(summary.idleSeconds).toBe(1200);
    expect(summary.activeSeconds + summary.idleSeconds).toBe(3600);
    expect(summary.productivityRatio).toBeCloseTo(0.6667, 3);
  });

  it("does not double-count two devices reporting the same span", () => {
    const summary = summarisePeriod({
      profileId: PROFILE,
      periodStart,
      periodEnd,
      activity: [
        activity("code.exe", periodStart, periodEnd),
        activity("slack.exe", periodStart, periodEnd),
      ],
      idle: [],
    });

    expect(summary.activeSeconds).toBe(3600);
  });

  it("clips events that overrun the period", () => {
    const summary = summarisePeriod({
      profileId: PROFILE,
      periodStart,
      periodEnd,
      activity: [activity("code.exe", "2026-08-05T08:00:00.000Z", "2026-08-05T11:00:00.000Z")],
      idle: [],
    });

    expect(summary.activeSeconds).toBe(3600);
  });

  it("treats an unfinished event as running to the end of the period", () => {
    const summary = summarisePeriod({
      profileId: PROFILE,
      periodStart,
      periodEnd,
      activity: [activity("code.exe", "2026-08-05T09:30:00.000Z", null)],
      idle: [],
    });

    expect(summary.activeSeconds).toBe(1800);
  });

  it("reports a zero ratio when nothing was recorded", () => {
    const summary = summarisePeriod({
      profileId: PROFILE,
      periodStart,
      periodEnd,
      activity: [],
      idle: [],
    });

    expect(summary.productivityRatio).toBe(0);
    expect(summary.topApps).toEqual([]);
  });
});

describe("rankApps", () => {
  it("orders by time spent and carries the category", () => {
    const window = {
      start: Date.parse("2026-08-05T09:00:00.000Z"),
      end: Date.parse("2026-08-05T10:00:00.000Z"),
    };

    const ranked = rankApps(
      [
        activity("slack.exe", "2026-08-05T09:00:00.000Z", "2026-08-05T09:10:00.000Z", "communication"),
        activity("code.exe", "2026-08-05T09:10:00.000Z", "2026-08-05T09:50:00.000Z", "development"),
      ],
      window,
    );

    expect(ranked).toEqual([
      { appName: "code.exe", category: "development", seconds: 2400 },
      { appName: "slack.exe", category: "communication", seconds: 600 },
    ]);
  });
});

describe("buildTimeline", () => {
  it("emits one entry per bucket across the period", () => {
    const entries = buildTimeline({
      profileId: PROFILE,
      deviceId: DEVICE,
      periodStart: "2026-08-05T09:00:00.000Z",
      periodEnd: "2026-08-05T12:00:00.000Z",
      activity: [activity("code.exe", "2026-08-05T09:00:00.000Z", "2026-08-05T09:30:00.000Z")],
      idle: [],
    });

    expect(entries).toHaveLength(3);
    expect(entries[0]?.activeSeconds).toBe(1800);
    expect(entries[1]?.activeSeconds).toBe(0);
    expect(entries[0]?.topApp).toBe("code.exe");
    expect(entries[1]?.topApp).toBeNull();
  });

  it("truncates a final partial bucket to the period end", () => {
    const entries = buildTimeline({
      profileId: PROFILE,
      deviceId: DEVICE,
      periodStart: "2026-08-05T09:00:00.000Z",
      periodEnd: "2026-08-05T10:30:00.000Z",
      activity: [],
      idle: [],
    });

    expect(entries).toHaveLength(2);
    expect(entries[1]?.periodEnd).toBe("2026-08-05T10:30:00.000Z");
  });
});

describe("totalSeconds", () => {
  it("rounds to whole seconds", () => {
    expect(totalSeconds([{ start: 0, end: 1500 }])).toBe(2);
  });
});
