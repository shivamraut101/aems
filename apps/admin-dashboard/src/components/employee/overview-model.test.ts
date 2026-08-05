import type { DayTimeline, TimelineMarker, TimelineSpan } from "@aems/types";
import { describe, expect, it } from "vitest";

import { buildOverviewKpis, summariseDay, topApplications } from "./overview-model";
import { buildWorkPattern } from "./work-pattern";

function appSpan(category: string | null, seconds: number): TimelineSpan {
  return {
    start: "2026-08-05T09:00:00.000Z",
    end: "2026-08-05T10:00:00.000Z",
    kind: "app",
    appName: "App",
    windowTitle: null,
    category,
    seconds,
    appCount: 1,
    topApps: [{ appName: "App", category, seconds }],
  };
}

function marker(over: Partial<TimelineMarker> & Pick<TimelineMarker, "at" | "kind">): TimelineMarker {
  return { label: "", detail: null, screenshotId: null, ...over };
}

function timeline(over: Partial<DayTimeline> = {}): DayTimeline {
  return {
    profileId: "p1",
    periodStart: "2026-08-05T00:00:00.000Z",
    periodEnd: "2026-08-06T00:00:00.000Z",
    slotSeconds: 600,
    slots: [],
    spans: [],
    markers: [],
    totals: {
      activeSeconds: 0,
      idleSeconds: 0,
      breakSeconds: 0,
      offlineSeconds: 0,
      trackedSeconds: 0,
      activityRatio: null,
    },
    topApps: [],
    truncated: false,
    ...over,
  };
}

const day = timeline({
  spans: [
    appSpan("Work > Development", 3600),
    appSpan("Work > Design", 1800),
    appSpan("Work > Communication", 1200),
    appSpan("Personal > Social", 600),
    appSpan("Uncategorized", 300),
  ],
  markers: [
    marker({ at: "2026-08-05T09:05:00.000Z", kind: "clock-in" }),
    marker({ at: "2026-08-05T10:00:00.000Z", kind: "screenshot" }),
    marker({ at: "2026-08-05T10:10:00.000Z", kind: "screenshot" }),
    marker({ at: "2026-08-05T17:20:00.000Z", kind: "clock-out" }),
  ],
  totals: {
    activeSeconds: 7500,
    idleSeconds: 900,
    breakSeconds: 600,
    offlineSeconds: 0,
    trackedSeconds: 9000,
    activityRatio: 0.8333,
  },
  topApps: [
    { appName: "Code", category: "Work > Development", seconds: 3600 },
    { appName: "Slack", category: "Work > Communication", seconds: 1200 },
    { appName: "Chrome", category: null, seconds: 900 },
  ],
});

describe("summariseDay", () => {
  it("reads clock-in and clock-out off the markers", () => {
    const summary = summariseDay(day);

    expect(summary.clockInAt).toBe("2026-08-05T09:05:00.000Z");
    expect(summary.clockOutAt).toBe("2026-08-05T17:20:00.000Z");
  });

  it("takes the first clock-in and the last clock-out across several sessions", () => {
    const summary = summariseDay(
      timeline({
        markers: [
          marker({ at: "2026-08-05T09:05:00.000Z", kind: "clock-in" }),
          marker({ at: "2026-08-05T12:00:00.000Z", kind: "clock-out" }),
          marker({ at: "2026-08-05T13:00:00.000Z", kind: "clock-in" }),
          marker({ at: "2026-08-05T17:20:00.000Z", kind: "clock-out" }),
        ],
      }),
    );

    expect(summary.clockInAt).toBe("2026-08-05T09:05:00.000Z");
    expect(summary.clockOutAt).toBe("2026-08-05T17:20:00.000Z");
  });

  it("calls a session still open rather than inventing a clock-out", () => {
    const summary = summariseDay(
      timeline({ markers: [marker({ at: "2026-08-05T09:05:00.000Z", kind: "clock-in" })] }),
    );

    expect(summary.clockOutAt).toBeNull();
    expect(summary.openSession).toBe(true);
  });

  it("counts captures so the page can say how much evidence the day holds", () => {
    expect(summariseDay(day).screenshotCount).toBe(2);
    expect(summariseDay(timeline()).screenshotCount).toBe(0);
  });

  it("has nothing to report on an empty day", () => {
    const summary = summariseDay(timeline());

    expect(summary.clockInAt).toBeNull();
    expect(summary.openSession).toBe(false);
  });
});

describe("buildOverviewKpis", () => {
  const kpis = buildOverviewKpis(day, buildWorkPattern(day));

  it("is scope 4.4's block with Focused time in place of a bare score", () => {
    expect(kpis.map((kpi) => kpi.label)).toEqual(["Work time", "Active", "Idle", "Focused time"]);
  });

  it("renders every figure as a duration, never as a percentage", () => {
    expect(kpis.map((kpi) => kpi.value)).toEqual(["2h 30m", "2h 5m", "15m", "1h 30m"]);
    for (const kpi of kpis) expect(kpi.value).not.toMatch(/%/);
  });

  it("says when work started, and says so plainly when no session was recorded", () => {
    expect(kpis[0]?.hint).toMatch(/^Started /);
    expect(buildOverviewKpis(timeline(), buildWorkPattern(timeline()))[0]?.hint).toBe(
      "No session recorded",
    );
  });

  it("mentions break time beside idle only when a break was taken", () => {
    expect(kpis[2]?.hint).toBe("10m break");

    const noBreak = timeline({
      totals: { ...day.totals, breakSeconds: 0, trackedSeconds: 8400 },
    });
    expect(buildOverviewKpis(noBreak, buildWorkPattern(noBreak))[2]?.hint).toBeUndefined();
  });

  it("names the work behind Focused time instead of scoring it", () => {
    expect(kpis[3]?.hint).toBe("Development, Design");
  });

  it("survives a day with nothing in it", () => {
    const empty = buildOverviewKpis(timeline(), buildWorkPattern(timeline()));

    expect(empty.map((kpi) => kpi.value)).toEqual(["0m", "0m", "0m", "0m"]);
  });
});

describe("topApplications", () => {
  it("keeps the API's order and shares each against active time", () => {
    const apps = topApplications(day);

    expect(apps.map((app) => app.appName)).toEqual(["Code", "Slack", "Chrome"]);
    expect(apps[0]?.share).toBeCloseTo(3600 / 7500, 5);
  });

  it("shows the category leaf, and says Uncategorised rather than showing a blank", () => {
    const apps = topApplications(day);

    expect(apps[0]?.categoryLabel).toBe("Development");
    expect(apps[2]?.categoryLabel).toBe("Uncategorized");
  });

  it("takes only as many as asked for", () => {
    expect(topApplications(day, 2)).toHaveLength(2);
  });

  it("reports a zero share rather than dividing by nothing", () => {
    const apps = topApplications(
      timeline({ topApps: [{ appName: "Code", category: null, seconds: 60 }] }),
    );

    expect(apps[0]?.share).toBe(0);
  });
});
