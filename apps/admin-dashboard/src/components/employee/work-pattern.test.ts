import type { DayTimeline, TimelineSpan } from "@aems/types";
import { describe, expect, it } from "vitest";

import { allocate, bucketForCategory, buildWorkPattern, splitActiveByCategory } from "./work-pattern";

function span(over: Partial<TimelineSpan> = {}): TimelineSpan {
  return {
    start: "2026-08-05T09:00:00.000Z",
    end: "2026-08-05T10:00:00.000Z",
    kind: "app",
    appName: "App",
    windowTitle: null,
    category: null,
    seconds: 0,
    appCount: 1,
    topApps: [],
    ...over,
  };
}

function appSpan(category: string | null, seconds: number): TimelineSpan {
  return span({
    category,
    seconds,
    topApps: [{ appName: "App", category, seconds }],
  });
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
      productiveSeconds: 0,
      neutralSeconds: 0,
      unproductiveSeconds: 0,
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

describe("bucketForCategory", () => {
  it("puts Work paths that are not communication into focus", () => {
    expect(bucketForCategory("Work > Development")).toBe("focus");
    expect(bucketForCategory("Work > Design")).toBe("focus");
    expect(bucketForCategory("Work > Documents")).toBe("focus");
    expect(bucketForCategory("Work")).toBe("focus");
  });

  it("puts communication leaves into collaboration whatever their depth", () => {
    expect(bucketForCategory("Work > Communication")).toBe("collaboration");
    expect(bucketForCategory("Work > Meetings")).toBe("collaboration");
    expect(bucketForCategory("Work > Email")).toBe("collaboration");
    expect(bucketForCategory("Communication")).toBe("collaboration");
  });

  it("is case-insensitive, because a company renames its own categories", () => {
    expect(bucketForCategory("work > communication")).toBe("collaboration");
    expect(bucketForCategory("WORK > DEVELOPMENT")).toBe("focus");
  });

  it("treats non-Work roots as other rather than as focus", () => {
    expect(bucketForCategory("Personal > Social")).toBe("other");
    expect(bucketForCategory("System > Utilities")).toBe("other");
  });

  it("treats an absent or unmatched category as uncategorised, never as focus", () => {
    expect(bucketForCategory(null)).toBe("uncategorized");
    expect(bucketForCategory("")).toBe("uncategorized");
    expect(bucketForCategory("   ")).toBe("uncategorized");
    expect(bucketForCategory("Uncategorized")).toBe("uncategorized");
  });
});

describe("allocate", () => {
  it("distributes the total in proportion to the weights", () => {
    expect(allocate([3, 1], 8)).toEqual([6, 2]);
  });

  it("always sums to exactly the total, even when the split does not divide", () => {
    const parts = allocate([1, 1, 1], 10);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10);
    expect(parts).toEqual([4, 3, 3]);
  });

  it("gives the remainder to the largest fractional parts", () => {
    expect(allocate([2, 1, 1], 7)).toEqual([3, 2, 2]);
  });

  it("returns zeros when there is nothing to weigh by", () => {
    expect(allocate([0, 0], 10)).toEqual([0, 0]);
    expect(allocate([], 10)).toEqual([]);
  });

  it("ignores negative weights instead of subtracting time", () => {
    expect(allocate([-5, 10], 10)).toEqual([0, 10]);
  });
});

describe("splitActiveByCategory", () => {
  it("sums application spans into their buckets", () => {
    const split = splitActiveByCategory([
      appSpan("Work > Development", 3600),
      appSpan("Work > Communication", 1200),
      appSpan("Personal > Social", 600),
      appSpan(null, 300),
    ]);

    expect(split.focus).toBe(3600);
    expect(split.collaboration).toBe(1200);
    expect(split.other).toBe(600);
    expect(split.uncategorized).toBe(300);
  });

  it("ignores idle, break and offline spans — they are not active time", () => {
    const split = splitActiveByCategory([
      span({ kind: "idle", seconds: 900 }),
      span({ kind: "break", seconds: 600 }),
      span({ kind: "offline", seconds: 4000 }),
      appSpan("Work > Development", 60),
    ]);

    expect(split.focus).toBe(60);
    expect(split.collaboration + split.other + split.uncategorized).toBe(0);
  });

  it("spreads a switching cluster over the categories of the apps inside it", () => {
    const split = splitActiveByCategory([
      span({
        kind: "switching",
        appName: null,
        seconds: 100,
        appCount: 5,
        topApps: [
          { appName: "Code", category: "Work > Development", seconds: 60 },
          { appName: "X", category: "Personal > Social", seconds: 20 },
        ],
      }),
    ]);

    // The cluster keeps its full duration; topApps is capped for legibility, so the
    // named apps carry the whole 100 seconds in proportion rather than losing 20.
    expect(split.focus).toBe(75);
    expect(split.other).toBe(25);
    expect(split.focus + split.other).toBe(100);
  });

  it("calls a switching cluster with no named apps uncategorised, never focus", () => {
    const split = splitActiveByCategory([
      span({ kind: "switching", appName: null, seconds: 100, appCount: 9, topApps: [] }),
    ]);

    expect(split.uncategorized).toBe(100);
    expect(split.focus).toBe(0);
  });
});

describe("buildWorkPattern", () => {
  const day = timeline({
    spans: [
      appSpan("Work > Development", 3600),
      appSpan("Work > Design", 1800),
      appSpan("Work > Communication", 1200),
      appSpan("Personal > Social", 600),
      appSpan("Uncategorized", 300),
    ],
    totals: {
      activeSeconds: 7500,
      productiveSeconds: 0,
      neutralSeconds: 7500,
      unproductiveSeconds: 0,
      idleSeconds: 900,
      breakSeconds: 600,
      offlineSeconds: 0,
      trackedSeconds: 9000,
      activityRatio: 0.8333,
    },
  });

  it("splits active time by category and takes idle and break from the totals", () => {
    const pattern = buildWorkPattern(day);
    const seconds = Object.fromEntries(pattern.rows.map((row) => [row.key, row.seconds]));

    expect(seconds["focus"]).toBe(5400);
    expect(seconds["collaboration"]).toBe(1200);
    expect(seconds["other"]).toBe(600);
    expect(seconds["uncategorized"]).toBe(300);
    expect(seconds["break"]).toBe(600);
    expect(seconds["idle"]).toBe(900);
  });

  it("adds up to exactly the tracked total, so it cannot disagree with the KPI row", () => {
    const pattern = buildWorkPattern(day);
    const sum = pattern.rows.reduce((total, row) => total + row.seconds, 0);

    expect(sum).toBe(day.totals.trackedSeconds);
    expect(pattern.trackedSeconds).toBe(9000);
  });

  it("scales the span split onto the arithmetic active total rather than trusting it", () => {
    // `spans` is the repaired picture and `totals` is the arithmetic; flood repair can
    // leave the two a few seconds apart. The split is evidence, the total is fact.
    const drifted = timeline({
      spans: day.spans,
      totals: { ...day.totals, activeSeconds: 7503, trackedSeconds: 9003 },
    });

    const pattern = buildWorkPattern(drifted);
    const seconds = Object.fromEntries(pattern.rows.map((row) => [row.key, row.seconds]));

    expect(seconds["focus"]).toBe(5402);
    expect(seconds["collaboration"]).toBe(1201);
    expect(pattern.rows.reduce((total, row) => total + row.seconds, 0)).toBe(9003);
  });

  it("names the busiest categories behind each bucket, busiest first", () => {
    const pattern = buildWorkPattern(day);
    const focus = pattern.rows.find((row) => row.key === "focus");

    expect(focus?.detail).toBe("Development, Design");
  });

  it("keeps the three lines docs/design.md names even when they are zero", () => {
    const pattern = buildWorkPattern(timeline());

    expect(pattern.rows.map((row) => row.key)).toEqual(["focus", "collaboration", "idle"]);
  });

  it("hides other, uncategorised and break when there is none of them", () => {
    const pattern = buildWorkPattern(
      timeline({
        spans: [appSpan("Work > Development", 3600)],
        totals: {
          activeSeconds: 3600,
          productiveSeconds: 0,
          neutralSeconds: 3600,
          unproductiveSeconds: 0,
          idleSeconds: 60,
          breakSeconds: 0,
          offlineSeconds: 0,
          trackedSeconds: 3660,
          activityRatio: 0.9836,
        },
      }),
    );

    expect(pattern.rows.map((row) => row.key)).toEqual(["focus", "collaboration", "idle"]);
  });

  it("reports shares against tracked time, and zero shares when nothing was tracked", () => {
    const pattern = buildWorkPattern(day);
    const focus = pattern.rows.find((row) => row.key === "focus");
    expect(focus?.share).toBeCloseTo(0.6, 5);

    for (const row of buildWorkPattern(timeline()).rows) expect(row.share).toBe(0);
  });

  it("flags a day nothing categorised, so a blank block never reads as a bug", () => {
    const uncategorised = buildWorkPattern(
      timeline({
        spans: [appSpan(null, 3600)],
        totals: {
          activeSeconds: 3600,
          productiveSeconds: 0,
          neutralSeconds: 3600,
          unproductiveSeconds: 0,
          idleSeconds: 0,
          breakSeconds: 0,
          offlineSeconds: 0,
          trackedSeconds: 3600,
          activityRatio: 1,
        },
      }),
    );

    expect(uncategorised.unclassified).toBe(true);
    expect(buildWorkPattern(day).unclassified).toBe(false);
  });

  it("does not flag an empty day as unclassified — there is nothing to classify", () => {
    expect(buildWorkPattern(timeline()).unclassified).toBe(false);
  });

  it("attributes active time to uncategorised when there are no spans at all to weigh by", () => {
    // A truncated response can carry totals with the spans that produced them missing.
    // Dropping those seconds would make the block disagree with the KPI row above it.
    const pattern = buildWorkPattern(
      timeline({
        spans: [],
        totals: {
          activeSeconds: 1800,
          productiveSeconds: 0,
          neutralSeconds: 1800,
          unproductiveSeconds: 0,
          idleSeconds: 0,
          breakSeconds: 0,
          offlineSeconds: 0,
          trackedSeconds: 1800,
          activityRatio: 1,
        },
      }),
    );

    const seconds = Object.fromEntries(pattern.rows.map((row) => [row.key, row.seconds]));
    expect(seconds["uncategorized"]).toBe(1800);
    expect(pattern.rows.reduce((total, row) => total + row.seconds, 0)).toBe(1800);
  });
});
