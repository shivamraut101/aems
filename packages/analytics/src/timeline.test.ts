import { describe, expect, it } from "vitest";

import type { Productivity } from "./categorize.js";

import type { ActivityEvent, BreakEvent, IdleEvent, TimelineScreenshot, WorkSession } from "@aems/types";

import type { Interval } from "./intervals.js";
import {
  buildDayTimeline,
  clusterShort,
  dayGrid,
  floodGaps,
  mergeAdjacent,
  toReducedSpans,
  type AppInterval,
  type KeyedSpan,
  type ReducedSpan,
} from "./timeline.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";
const DEVICE = "33333333-3333-4333-8333-333333333333";

const DAY = "2026-08-05";

/** Epoch ms for a UTC time on the fixture day. */
function t(hour: number, minute = 0, second = 0): number {
  return Date.parse(
    `${DAY}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`,
  );
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function span(appName: string, start: number, end: number, windowTitle: string | null = null): KeyedSpan {
  return { start, end, key: appName, appName, windowTitle, category: null };
}

function activity(
  appName: string,
  startedAt: number,
  endedAt: number | null,
  extra: Partial<ActivityEvent> = {},
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
    category: null,
    started_at: iso(startedAt),
    ended_at: endedAt === null ? null : iso(endedAt),
    client_event_id: "c",
    created_at: iso(startedAt),
    ...extra,
  };
}

function idleEvent(startAt: number, endAt: number | null): IdleEvent {
  return {
    id: 1,
    company_id: COMPANY,
    profile_id: PROFILE,
    device_id: DEVICE,
    idle_start_at: iso(startAt),
    idle_end_at: endAt === null ? null : iso(endAt),
    duration_seconds: null,
    client_event_id: "c",
    created_at: iso(startAt),
  };
}

function breakEvent(startAt: number, endAt: number | null): BreakEvent {
  return {
    id: 1,
    company_id: COMPANY,
    profile_id: PROFILE,
    device_id: DEVICE,
    work_session_id: null,
    break_start_at: iso(startAt),
    break_end_at: endAt === null ? null : iso(endAt),
    duration_seconds: null,
    client_event_id: "c",
    created_at: iso(startAt),
  };
}

function workSession(clockIn: number, clockOut: number | null): WorkSession {
  return {
    id: 7,
    company_id: COMPANY,
    profile_id: PROFILE,
    device_id: DEVICE,
    clock_in_at: iso(clockIn),
    clock_out_at: clockOut === null ? null : iso(clockOut),
    created_at: iso(clockIn),
  };
}

function shot(id: number, capturedAt: number): TimelineScreenshot {
  return {
    id,
    capturedAt: iso(capturedAt),
    url: `https://example.test/${id}`,
    thumbnailUrl: `https://example.test/${id}-thumb`,
    blurred: false,
    workSessionId: null,
  };
}

/** Total wall-clock covered by a set of spans, in ms. Spans here are always disjoint. */
function coveredMs(spans: readonly { start: number; end: number }[]): number {
  return spans.reduce((sum, s) => sum + (s.end - s.start), 0);
}

// ---------------------------------------------------------------------------

describe("floodGaps", () => {
  it("closes a sub-threshold gap between adjacent identical events", () => {
    // The agent samples every 5s, so a 3s hole between two Code intervals is jitter,
    // not a moment of not-working.
    const out = floodGaps([span("Code", t(9), t(9, 10)), span("Code", t(9, 10, 3), t(9, 20))]);

    expect(out).toHaveLength(1);
    expect(out[0]?.start).toBe(t(9));
    expect(out[0]?.end).toBe(t(9, 20));
  });

  it("leaves a gap wider than the pulse alone", () => {
    const out = floodGaps([span("Code", t(9), t(9, 10)), span("Code", t(9, 10, 30), t(9, 20))]);

    expect(out).toHaveLength(2);
    expect(out[0]?.end).toBe(t(9, 10));
    expect(out[1]?.start).toBe(t(9, 10, 30));
  });

  it("splits a sub-threshold gap between different apps at the midpoint", () => {
    // Splitting evenly is the only rule that does not systematically favour the
    // longer neighbour.
    const out = floodGaps([span("Code", t(9), t(9, 10)), span("Chrome", t(9, 10, 4), t(9, 20))]);

    expect(out).toHaveLength(2);
    expect(out[0]?.end).toBe(t(9, 10, 2));
    expect(out[1]?.start).toBe(t(9, 10, 2));
  });

  it("merges an overlap between identical apps", () => {
    const out = floodGaps([span("Code", t(9), t(9, 12)), span("Code", t(9, 10), t(9, 20))]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ start: t(9), end: t(9, 20) });
  });

  it("gives an overlap between different apps to the later one", () => {
    // Two windows cannot both be focused; the newer report is the better evidence.
    const out = floodGaps([span("Code", t(9), t(9, 12)), span("Chrome", t(9, 10), t(9, 20))]);

    expect(out).toHaveLength(2);
    expect(out[0]?.end).toBe(t(9, 10));
    expect(out[1]?.start).toBe(t(9, 10));
  });

  it("returns a single event unchanged", () => {
    const only = span("Code", t(9), t(17));
    expect(floodGaps([only])).toEqual([only]);
  });

  it("returns nothing for no events", () => {
    expect(floodGaps([])).toEqual([]);
  });

  it("sorts its output by start time regardless of input order", () => {
    const out = floodGaps([
      span("Chrome", t(11), t(12)),
      span("Code", t(9), t(10)),
      span("Slack", t(10), t(11)),
    ]);

    expect(out.map((s) => s.appName)).toEqual(["Code", "Slack", "Chrome"]);
  });

  it("is idempotent", () => {
    const input = [
      span("Code", t(9), t(9, 10)),
      span("Code", t(9, 10, 3), t(9, 20)),
      span("Chrome", t(9, 20, 4), t(9, 30)),
      span("Slack", t(10), t(10, 5)),
    ];

    const once = floodGaps(input);
    expect(floodGaps(once)).toEqual(once);
  });

  it("never destroys covered time — it only adds the gaps it closes", () => {
    const input = [
      span("Code", t(9), t(9, 10)),
      span("Code", t(9, 10, 3), t(9, 20)),
      span("Chrome", t(9, 20, 4), t(9, 30)),
    ];

    // 3s closed by the same-app merge + 4s closed by the midpoint split.
    expect(coveredMs(floodGaps(input))).toBe(coveredMs(input) + 3_000 + 4_000);
  });
});

describe("mergeAdjacent", () => {
  it("collapses the agent's five-minute fragments back into one session", () => {
    // MAX_ACTIVITY_INTERVAL_MS is 5 minutes, so a two-hour session arrives as 24
    // rows and renders as 24 seams unless they are put back together.
    const fragments: KeyedSpan[] = [];
    for (let i = 0; i < 24; i += 1) {
      fragments.push(span("Code", t(9) + i * 300_000, t(9) + (i + 1) * 300_000));
    }

    const out = mergeAdjacent(fragments);

    expect(out).toHaveLength(1);
    expect(out[0]?.start).toBe(t(9));
    expect(out[0]?.end).toBe(t(11));
  });

  it("does not merge across a real gap", () => {
    const out = mergeAdjacent([span("Code", t(9), t(9, 30)), span("Code", t(10), t(10, 30))]);
    expect(out).toHaveLength(2);
  });

  it("does not merge different apps that touch", () => {
    const out = mergeAdjacent([span("Code", t(9), t(9, 30)), span("Chrome", t(9, 30), t(10))]);
    expect(out).toHaveLength(2);
  });

  it("creates and destroys no time", () => {
    const input = [
      span("Code", t(9), t(9, 5)),
      span("Code", t(9, 5), t(9, 10)),
      span("Chrome", t(9, 10), t(9, 40)),
      span("Code", t(10), t(10, 30)),
    ];

    expect(coveredMs(mergeAdjacent(input))).toBe(coveredMs(input));
  });

  it("is idempotent", () => {
    const input = [
      span("Code", t(9), t(9, 5)),
      span("Code", t(9, 5), t(9, 10)),
      span("Chrome", t(9, 10), t(9, 40)),
    ];

    const once = mergeAdjacent(input);
    expect(mergeAdjacent(once)).toEqual(once);
  });

  it("keeps a window title only when every fragment agreed on it", () => {
    const same = mergeAdjacent([
      span("Code", t(9), t(9, 5), "project-alpha"),
      span("Code", t(9, 5), t(9, 10), "project-alpha"),
    ]);
    expect(same[0]?.windowTitle).toBe("project-alpha");

    const differing = mergeAdjacent([
      span("Code", t(9), t(9, 5), "project-alpha"),
      span("Code", t(9, 5), t(9, 10), "project-beta"),
    ]);
    expect(differing[0]?.windowTitle).toBeNull();
  });

  it("handles a single span and no spans", () => {
    const only = span("Code", t(9), t(17));
    expect(mergeAdjacent([only])).toEqual([only]);
    expect(mergeAdjacent([])).toEqual([]);
  });
});

describe("clusterShort", () => {
  const short = (app: string, start: number, seconds: number): ReducedSpan =>
    toReducedSpans([span(app, start, start + seconds * 1000)])[0]!;

  it("folds a run of tiny spans into one switching span", () => {
    const out = clusterShort([
      short("Chrome", t(9), 20),
      short("Slack", t(9, 0, 20), 15),
      short("Teams", t(9, 0, 35), 25),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("switching");
    expect(out[0]?.appCount).toBe(3);
    expect(out[0]?.seconds).toBe(60);
  });

  it("never discards a second — total time is conserved", () => {
    const input = [
      short("Chrome", t(9), 20),
      short("Slack", t(9, 0, 20), 15),
      short("Teams", t(9, 0, 35), 25),
      toReducedSpans([span("Code", t(9, 1), t(10))])[0]!,
    ];

    const before = input.reduce((sum, s) => sum + s.seconds, 0);
    const after = clusterShort(input).reduce((sum, s) => sum + s.seconds, 0);

    expect(after).toBe(before);
  });

  it("leaves a lone short span as itself", () => {
    // Absorbing it into a neighbour would credit its seconds to an app that was not
    // focused. One short span is legible; a run of them is not.
    const out = clusterShort([
      toReducedSpans([span("Code", t(9), t(9, 30))])[0]!,
      short("Slack", t(9, 30), 20),
      toReducedSpans([span("Code", t(9, 30, 20), t(10))])[0]!,
    ]);

    expect(out).toHaveLength(3);
    expect(out[1]?.kind).toBe("app");
    expect(out[1]?.appName).toBe("Slack");
  });

  it("leaves long spans untouched", () => {
    const input = [
      toReducedSpans([span("Code", t(9), t(9, 30))])[0]!,
      toReducedSpans([span("Chrome", t(9, 30), t(10))])[0]!,
    ];

    expect(clusterShort(input)).toEqual(input);
  });

  it("ranks the apps it folded in, longest first", () => {
    const out = clusterShort([
      short("Chrome", t(9), 20),
      short("Slack", t(9, 0, 20), 15),
      short("Chrome", t(9, 0, 35), 25),
    ]);

    expect(out[0]?.topApps.map((a) => a.appName)).toEqual(["Chrome", "Slack"]);
    expect(out[0]?.topApps[0]?.seconds).toBe(45);
    expect(out[0]?.appCount).toBe(2);
  });

  it("does not fold an existing cluster into a neighbouring short span", () => {
    // A cluster can itself be under a minute. Re-reducing it would swallow a distinct
    // span into a bracket that already closed.
    const cluster = clusterShort([short("Chrome", t(9), 20), short("Slack", t(9, 0, 20), 15)])[0]!;
    expect(cluster.kind).toBe("switching");
    expect(cluster.seconds).toBeLessThan(60);

    const out = clusterShort([cluster, short("Teams", t(9, 0, 35), 25)]);

    expect(out).toHaveLength(2);
    expect(out[0]).toBe(cluster);
    expect(out[1]?.appName).toBe("Teams");
  });

  it("is idempotent", () => {
    const input = [
      short("Chrome", t(9), 20),
      short("Slack", t(9, 0, 20), 15),
      short("Teams", t(9, 0, 35), 10),
      toReducedSpans([span("Code", t(9, 1), t(10))])[0]!,
    ];

    const once = clusterShort(input);
    expect(once[0]?.seconds).toBeLessThan(60);
    expect(clusterShort(once)).toEqual(once);
  });
});

describe("dayGrid", () => {
  const emptyGrid = {
    active: [] as Interval[],
    idle: [] as Interval[],
    breaks: [] as Interval[],
    apps: [] as AppInterval[],
  };

  it("anchors slots to the wall clock and clips the ends to the window", () => {
    // A caller asking for 09:05-09:25 must still get the same 09:10 and 09:20
    // boundaries the screenshot review and the app list use.
    const slots = dayGrid({
      ...emptyGrid,
      windowStart: t(9, 5),
      windowEnd: t(9, 25),
      slotSeconds: 600,
    });

    expect(slots.map((s) => [s.start, s.end])).toEqual([
      [iso(t(9, 5)), iso(t(9, 10))],
      [iso(t(9, 10)), iso(t(9, 20))],
      [iso(t(9, 20)), iso(t(9, 25))],
    ]);
  });

  it("makes the four state columns sum to the slot length exactly", () => {
    const slots = dayGrid({
      windowStart: t(9),
      windowEnd: t(9, 10),
      slotSeconds: 600,
      active: [{ start: t(9), end: t(9, 4) }],
      idle: [{ start: t(9, 4), end: t(9, 6) }],
      breaks: [{ start: t(9, 6), end: t(9, 7) }],
      apps: [],
    });

    const slot = slots[0]!;
    expect(slot.activeSeconds).toBe(240);
    expect(slot.idleSeconds).toBe(120);
    expect(slot.breakSeconds).toBe(60);
    expect(slot.offlineSeconds).toBe(180);
    expect(
      slot.activeSeconds + slot.idleSeconds + slot.breakSeconds + slot.offlineSeconds,
    ).toBe(600);
  });

  it("reports a null ratio for a slot with nothing tracked", () => {
    const slots = dayGrid({ ...emptyGrid, windowStart: t(3), windowEnd: t(3, 10), slotSeconds: 600 });

    expect(slots[0]?.activityRatio).toBeNull();
    expect(slots[0]?.offlineSeconds).toBe(600);
  });

  it("keeps every screenshot in a slot, not just the first", () => {
    // At scope §2.3's one-minute option the old .find() discarded 59 of every 60.
    const slots = dayGrid({
      ...emptyGrid,
      windowStart: t(9),
      windowEnd: t(9, 20),
      slotSeconds: 600,
      screenshots: [shot(1, t(9, 1)), shot(2, t(9, 5)), shot(3, t(9, 12))],
    });

    expect(slots[0]?.screenshots.map((s) => s.id)).toEqual([1, 2]);
    expect(slots[1]?.screenshots.map((s) => s.id)).toEqual([3]);
  });

  it("ranks apps within each slot independently", () => {
    const slots = dayGrid({
      windowStart: t(9),
      windowEnd: t(9, 20),
      slotSeconds: 600,
      active: [{ start: t(9), end: t(9, 20) }],
      idle: [],
      breaks: [],
      apps: [
        { start: t(9), end: t(9, 8), appName: "Code", category: null },
        { start: t(9, 8), end: t(9, 10), appName: "Chrome", category: null },
        { start: t(9, 10), end: t(9, 20), appName: "Chrome", category: null },
      ],
    });

    expect(slots[0]?.topApps.map((a) => a.appName)).toEqual(["Code", "Chrome"]);
    expect(slots[0]?.topApps[0]?.seconds).toBe(480);
    expect(slots[1]?.topApps.map((a) => a.appName)).toEqual(["Chrome"]);
  });

  it("handles a day with a single event", () => {
    const slots = dayGrid({
      windowStart: t(9),
      windowEnd: t(9, 10),
      slotSeconds: 600,
      active: [{ start: t(9, 2), end: t(9, 3) }],
      idle: [],
      breaks: [],
      apps: [{ start: t(9, 2), end: t(9, 3), appName: "Code", category: null }],
    });

    expect(slots).toHaveLength(1);
    expect(slots[0]?.activeSeconds).toBe(60);
    expect(slots[0]?.topApps).toEqual([{ appName: "Code", category: null, seconds: 60 }]);
  });

  it("returns nothing for an inverted or empty window", () => {
    expect(dayGrid({ ...emptyGrid, windowStart: t(10), windowEnd: t(9), slotSeconds: 600 })).toEqual([]);
    expect(dayGrid({ ...emptyGrid, windowStart: t(9), windowEnd: t(9), slotSeconds: 600 })).toEqual([]);
  });
});

describe("buildDayTimeline", () => {
  const base = {
    profileId: PROFILE,
    periodStart: iso(t(9)),
    periodEnd: iso(t(12)),
  };

  it("renders the agent's 24 fragments as one span", () => {
    const fragments = Array.from({ length: 24 }, (_, i) =>
      activity("Code", t(9) + i * 300_000, t(9) + (i + 1) * 300_000),
    );

    const timeline = buildDayTimeline({ ...base, activity: fragments, idle: [] });
    const appSpans = timeline.spans.filter((s) => s.kind === "app");

    expect(appSpans).toHaveLength(1);
    expect(appSpans[0]?.appName).toBe("Code");
    expect(appSpans[0]?.seconds).toBe(7200);
  });

  it("tiles the window with contiguous, non-overlapping spans", () => {
    const timeline = buildDayTimeline({
      ...base,
      activity: [activity("Code", t(9), t(10)), activity("Chrome", t(10, 30), t(11))],
      idle: [idleEvent(t(9, 20), t(9, 30))],
      breaks: [breakEvent(t(11), t(11, 15))],
    });

    expect(timeline.spans[0]?.start).toBe(iso(t(9)));
    expect(timeline.spans[timeline.spans.length - 1]?.end).toBe(iso(t(12)));

    for (let i = 1; i < timeline.spans.length; i += 1) {
      expect(timeline.spans[i]?.start).toBe(timeline.spans[i - 1]?.end);
    }
  });

  it("shows idle over the app that was focused, never alongside it", () => {
    const timeline = buildDayTimeline({
      ...base,
      activity: [activity("Code", t(9), t(10))],
      idle: [idleEvent(t(9, 20), t(9, 30))],
    });

    const kinds = timeline.spans.slice(0, 3).map((s) => s.kind);
    expect(kinds).toEqual(["app", "idle", "app"]);
    expect(timeline.totals.activeSeconds).toBe(3000);
    expect(timeline.totals.idleSeconds).toBe(600);
  });

  it("keeps a declared break out of both active and idle", () => {
    const timeline = buildDayTimeline({
      ...base,
      activity: [activity("Code", t(9), t(10))],
      idle: [],
      breaks: [breakEvent(t(9, 30), t(9, 45))],
    });

    expect(timeline.totals.breakSeconds).toBe(900);
    expect(timeline.totals.activeSeconds).toBe(2700);
    expect(timeline.totals.idleSeconds).toBe(0);
  });

  it("makes the totals equal the sum of the grid", () => {
    const timeline = buildDayTimeline({
      ...base,
      activity: [activity("Code", t(9), t(10, 20)), activity("Chrome", t(10, 20), t(11))],
      idle: [idleEvent(t(9, 40), t(9, 55))],
      breaks: [breakEvent(t(11), t(11, 20))],
    });

    const summed = timeline.slots.reduce(
      (acc, s) => ({
        active: acc.active + s.activeSeconds,
        idle: acc.idle + s.idleSeconds,
        brk: acc.brk + s.breakSeconds,
        offline: acc.offline + s.offlineSeconds,
      }),
      { active: 0, idle: 0, brk: 0, offline: 0 },
    );

    expect(summed.active).toBe(timeline.totals.activeSeconds);
    expect(summed.idle).toBe(timeline.totals.idleSeconds);
    expect(summed.brk).toBe(timeline.totals.breakSeconds);
    expect(summed.offline).toBe(timeline.totals.offlineSeconds);
    expect(summed.active + summed.idle + summed.brk + summed.offline).toBe(3 * 3600);
  });

  it("emits scope 2.7's moments in time order", () => {
    const timeline = buildDayTimeline({
      ...base,
      activity: [activity("Code", t(9, 5), t(10))],
      idle: [idleEvent(t(10, 30), t(10, 45))],
      breaks: [breakEvent(t(11), t(11, 15))],
      sessions: [workSession(t(9), t(11, 50))],
      screenshots: [shot(1, t(10))],
    });

    expect(timeline.markers.map((m) => m.kind)).toEqual([
      "clock-in",
      "screenshot",
      "idle-start",
      "active-again",
      "break-start",
      "break-end",
      "clock-out",
    ]);
    expect(timeline.markers[0]?.at).toBe(iso(t(9)));
    expect(timeline.markers[1]?.screenshotId).toBe(1);
  });

  it("does not emit a marker for an instant outside the window", () => {
    const timeline = buildDayTimeline({
      ...base,
      activity: [],
      idle: [],
      sessions: [workSession(t(7), t(8))],
    });

    expect(timeline.markers).toEqual([]);
  });

  it("treats an unfinished idle stretch as running to the end of the window", () => {
    const timeline = buildDayTimeline({
      ...base,
      activity: [activity("Code", t(11), null)],
      idle: [idleEvent(t(11, 30), null)],
    });

    expect(timeline.totals.idleSeconds).toBe(1800);
    expect(timeline.markers.map((m) => m.kind)).toEqual(["idle-start"]);
  });

  it("describes an empty day as entirely offline rather than as an empty list", () => {
    // A 90-minute hole is information. Filtering it out was the old behaviour and it
    // made two hours of nothing look like two adjacent rows of work.
    const timeline = buildDayTimeline({ ...base, activity: [], idle: [] });

    expect(timeline.slots).toHaveLength(18);
    expect(timeline.totals.offlineSeconds).toBe(3 * 3600);
    expect(timeline.totals.activityRatio).toBeNull();
    expect(timeline.spans).toEqual([
      expect.objectContaining({ kind: "offline", start: iso(t(9)), end: iso(t(12)) }),
    ]);
  });

  it("handles a day with a single event", () => {
    const timeline = buildDayTimeline({
      ...base,
      activity: [activity("Code", t(9, 30), t(9, 40))],
      idle: [],
    });

    expect(timeline.totals.activeSeconds).toBe(600);
    expect(timeline.topApps).toEqual([{ appName: "Code", category: null, seconds: 600 }]);
    expect(timeline.spans.map((s) => s.kind)).toEqual(["offline", "app", "offline"]);
  });

  it("does not double-count one app reported by two devices at once", () => {
    const timeline = buildDayTimeline({
      ...base,
      activity: [activity("Code", t(9), t(10)), activity("Code", t(9), t(10))],
      idle: [],
    });

    expect(timeline.topApps).toEqual([{ appName: "Code", category: null, seconds: 3600 }]);
    expect(timeline.totals.activeSeconds).toBe(3600);
  });

  it("ranks a steady background app that never tops a single slot", () => {
    // Slot rankings are capped for legibility. Summing the capped lists would erase an
    // app that ran all day without ever placing — the app list would then disagree
    // with the ribbon it sits beside.
    const events = [];
    for (let slot = 0; slot < 18; slot += 1) {
      const base10 = t(9) + slot * 600_000;
      events.push(activity("Code", base10, base10 + 300_000));
      events.push(activity("Chrome", base10 + 300_000, base10 + 480_000));
      events.push(activity("Slack", base10 + 480_000, base10 + 570_000));
      events.push(activity("Notes", base10 + 570_000, base10 + 600_000));
    }

    const timeline = buildDayTimeline({ ...base, activity: events, idle: [] });

    expect(timeline.slots[0]?.topApps.map((a) => a.appName)).toEqual(["Code", "Chrome", "Slack"]);
    expect(timeline.topApps.map((a) => a.appName)).toContain("Notes");
    expect(timeline.topApps.find((a) => a.appName === "Notes")?.seconds).toBe(18 * 30);
  });

  it("clips events that overrun the window", () => {
    const timeline = buildDayTimeline({
      ...base,
      activity: [activity("Code", t(7), t(14))],
      idle: [],
    });

    expect(timeline.totals.activeSeconds).toBe(3 * 3600);
  });

  it("carries the truncation flag through", () => {
    const timeline = buildDayTimeline({ ...base, activity: [], idle: [], truncated: true });
    expect(timeline.truncated).toBe(true);
  });

  it("rejects a slot width outside the shared set", () => {
    const timeline = buildDayTimeline({ ...base, activity: [], idle: [], slotSeconds: 137 });
    expect(timeline.slotSeconds).toBe(600);
  });

  it("stays linear as the slot count grows", () => {
    // The old buildTimeline re-scanned every event and re-ranked every app inside the
    // slot loop, so 1440 one-minute slots cost 60x an hourly grid for the same day.
    const events = Array.from({ length: 2000 }, (_, i) =>
      activity(`app-${i % 40}`, t(0) + i * 40_000, t(0) + (i + 1) * 40_000),
    );

    const started = Date.now();
    const timeline = buildDayTimeline({
      profileId: PROFILE,
      periodStart: iso(t(0)),
      periodEnd: iso(t(0) + 86_400_000),
      slotSeconds: 60,
      activity: events,
      idle: [],
    });
    const elapsed = Date.now() - started;

    expect(timeline.slots).toHaveLength(1440);
    expect(elapsed).toBeLessThan(1500);
  });
});

/**
 * Splitting active time three ways.
 *
 * `docs/inspiration.md` argues that forcing every worked second into productive-or-idle
 * is unfair, and that neutral is the honest bucket for "in use, and we cannot call it
 * either way". The property that makes it safe to display is that the three parts are
 * a partition of `activeSeconds` — a breakdown that does not add up to its own total
 * is worse than no breakdown, because a reader cannot tell which number to believe.
 */
describe("productivity split", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 7, 6, 9, m)).toISOString();

  const build = (productivityOf?: (c: string | null) => Productivity) =>
    buildDayTimeline({
      profileId: "p1",
      periodStart: at(0),
      periodEnd: at(60),
      activity: [
        { app_name: "Code", window_title: null, category: "Development", started_at: at(0), ended_at: at(20) },
        { app_name: "Chrome", window_title: null, category: "Social", started_at: at(20), ended_at: at(30) },
        { app_name: "Notes", window_title: null, category: null, started_at: at(30), ended_at: at(40) },
      ],
      idle: [],
      // Active time is clipped to work sessions — activity observed while clocked out
      // is not the employee's time. Without this the whole window reports as offline.
      sessions: [{ clock_in_at: at(0), clock_out_at: at(60) }],
      productivityOf,
    });

  const rules = (c: string | null): Productivity =>
    c === "Development" ? "productive" : c === "Social" ? "unproductive" : "neutral";

  it("partitions active time exactly", () => {
    const { totals } = build(rules);
    expect(totals.productiveSeconds + totals.neutralSeconds + totals.unproductiveSeconds).toBe(
      totals.activeSeconds,
    );
  });

  it("credits each category to its own bucket", () => {
    const { totals } = build(rules);
    expect(totals.productiveSeconds).toBe(20 * 60);
    expect(totals.unproductiveSeconds).toBe(10 * 60);
    // Notes has no category, and uncategorised is never counted against anyone.
    expect(totals.neutralSeconds).toBe(10 * 60);
  });

  it("reports everything as neutral when no rules are supplied", () => {
    // The honest answer for a caller with no rule set — not a silent zero, which would
    // read as "nobody did any productive work today".
    const { totals } = build();
    expect(totals.neutralSeconds).toBe(totals.activeSeconds);
    expect(totals.productiveSeconds).toBe(0);
    expect(totals.unproductiveSeconds).toBe(0);
  });
});
