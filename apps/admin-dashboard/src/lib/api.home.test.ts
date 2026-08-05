import type { ReportDocument, ReportRow } from "@aems/analytics";
import { describe, expect, it } from "vitest";

import {
  ApiError,
  NetworkError,
  apiErrorFor,
  appUsageBars,
  reportTotal,
  retryUnlessRefused,
  todaySoFar,
  trailingDays,
  trailingUtcDays,
  workPatternDays,
} from "./api";

/**
 * The dashboard home's data layer.
 *
 * Everything here is the pure half of what the home page renders — the retry
 * policy, the reporting windows, and the two transforms that turn a
 * `ReportDocument` into a chart. The components around them are thin by design so
 * that the parts which can be wrong are the parts that are tested.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function row(cells: Record<string, string | number | null>): ReportRow {
  return { cells };
}

function document(
  partial: Partial<ReportDocument> & { rows?: ReportRow[]; totals?: ReportRow | null },
): ReportDocument {
  const { rows = [], totals = null, ...rest } = partial;

  return {
    kind: "time_and_activity",
    title: "Time & Activity",
    subtitle: "Whole company",
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-08-04T00:00:00.000Z",
    generatedAt: "2026-08-04T00:00:00.000Z",
    grouping: "date",
    decimalDuration: false,
    sections: [{ heading: "Time & Activity", columns: [], rows, totals }],
    rowCount: rows.length,
    truncated: false,
    notes: [],
    ...rest,
  };
}

/* -------------------------------------------------------------------------- */
/* Retry policy                                                                */
/* -------------------------------------------------------------------------- */

describe("retryUnlessRefused", () => {
  it("never retries an answer the API already settled", () => {
    // Each of these is the API's considered decision. Resending changes none of
    // them, and the doubled round trip is spent showing a loading state that reads
    // as "working" while the truth is "refused".
    for (const status of [401, 403, 404, 429]) {
      expect(retryUnlessRefused(0, apiErrorFor(status, null))).toBe(false);
    }
  });

  it("does not retry a 500 either, because the ApiError split is by answered-ness", () => {
    // Deliberate: a 500 IS an answer, and React Query's own refetch-on-focus plus
    // the retry button cover the "try again in a moment" case that its copy names.
    expect(retryUnlessRefused(0, apiErrorFor(500, null))).toBe(false);
  });

  it("retries a request that never landed, twice", () => {
    const offline = new NetworkError("fetch failed");
    expect(retryUnlessRefused(0, offline)).toBe(true);
    expect(retryUnlessRefused(1, offline)).toBe(true);
    expect(retryUnlessRefused(2, offline)).toBe(false);
  });

  it("retries an unrecognised failure rather than assuming it is settled", () => {
    expect(retryUnlessRefused(0, new Error("kaboom"))).toBe(true);
    expect(retryUnlessRefused(0, undefined)).toBe(true);
  });

  it("keys off the class, not the shape, so a lookalike is not mistaken for a refusal", () => {
    const impostor = new Error("Your session expired. Sign in again.");
    expect(impostor).not.toBeInstanceOf(ApiError);
    expect(retryUnlessRefused(0, impostor)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Reporting windows                                                           */
/* -------------------------------------------------------------------------- */

describe("trailingDays", () => {
  it("starts at local midnight, days - 1 days back, and ends now", () => {
    const now = new Date(2026, 7, 5, 14, 30, 0);

    expect(trailingDays(7, now)).toEqual({
      from: new Date(2026, 6, 30, 0, 0, 0, 0).toISOString(),
      to: now.toISOString(),
    });
  });

  it("uses local midnight, not UTC midnight", () => {
    // The reader picked neither; they opened a page. "The last seven days" means
    // seven of their days, so the boundary has to be their midnight.
    const now = new Date(2026, 7, 5, 14, 30, 0);
    const from = new Date(trailingDays(7, now).from);

    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
    expect(from.getDate()).toBe(30);
    expect(from.getMonth()).toBe(6);
  });

  it("crosses a month boundary by calendar day, not by subtracting milliseconds", () => {
    const now = new Date(2026, 7, 2, 9, 0, 0);
    expect(new Date(trailingDays(7, now).from).getMonth()).toBe(6);
    expect(new Date(trailingDays(7, now).from).getDate()).toBe(27);
  });

  it("never produces a zero-width window at midnight, which the API answers 400", () => {
    const midnight = new Date(2026, 7, 5, 0, 0, 0, 0);
    const period = todaySoFar(midnight);

    expect(Date.parse(period.to)).toBeGreaterThan(Date.parse(period.from));
    expect(Date.parse(period.to) - Date.parse(period.from)).toBe(1000);
  });

  it("treats a single day as today so far", () => {
    const now = new Date(2026, 7, 5, 11, 15, 0);
    expect(todaySoFar(now)).toEqual(trailingDays(1, now));
    expect(new Date(todaySoFar(now).from).getDate()).toBe(5);
  });
});

describe("trailingUtcDays", () => {
  it("starts on a UTC day boundary so the report's own grid is not straddled", () => {
    const now = new Date("2026-08-05T14:30:00.000Z");

    expect(trailingUtcDays(7, now)).toEqual({
      from: "2026-07-30T00:00:00.000Z",
      to: "2026-08-05T14:30:00.000Z",
    });
  });

  it("asks for exactly as many UTC buckets as the panel claims to show", () => {
    // The bug this exists to stop: seven *local* days spans eight UTC buckets for
    // any reader east of UTC, and the first held five and a half hours — a sliver
    // drawn next to seven whole days, which reads as a quiet Wednesday.
    const now = new Date("2026-08-05T14:30:00.000Z");
    const period = trailingUtcDays(7, now);

    const days = workPatternDays(
      document({ periodStart: period.from, periodEnd: period.to }),
    );

    expect(days).toHaveLength(7);
    expect(days[0]?.key).toBe("2026-07-30");
    expect(days[6]?.key).toBe("2026-08-05");
  });

  it("never produces a zero-width window at the UTC day boundary", () => {
    const period = trailingUtcDays(7, new Date("2026-08-05T00:00:00.000Z"));
    expect(Date.parse(period.to)).toBeGreaterThan(Date.parse(period.from));
  });
});

/* -------------------------------------------------------------------------- */
/* Totals                                                                      */
/* -------------------------------------------------------------------------- */

describe("reportTotal", () => {
  it("reads the merged totals row, not the sum of the rows above it", () => {
    // The rows can legitimately sum past the total: two devices reporting the same
    // hour count once in the merged figure. Adding the table up would inflate it.
    const doc = document({
      rows: [row({ date: "2026-08-01", active: 3600 }), row({ date: "2026-08-02", active: 3600 })],
      totals: row({ active: 5400, tracked: 7200 }),
    });

    expect(reportTotal(doc, "active")).toBe(5400);
    expect(reportTotal(doc, "tracked")).toBe(7200);
  });

  it("is zero for a missing document, a missing totals row and a non-numeric cell", () => {
    expect(reportTotal(undefined, "active")).toBe(0);
    expect(reportTotal(document({ rows: [] }), "active")).toBe(0);
    expect(reportTotal(document({ totals: row({ active: null }) }), "active")).toBe(0);
    expect(reportTotal(document({ totals: row({ active: "8h" }) }), "active")).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* App usage                                                                   */
/* -------------------------------------------------------------------------- */

describe("appUsageBars", () => {
  const usage = (rows: ReportRow[]) => document({ kind: "app_usage", grouping: "application", rows });

  it("reads application, duration and share from the report", () => {
    const bars = appUsageBars(
      usage([row({ application: "Code.exe", duration: 9000, share: 0.625 })]),
    );

    expect(bars).toEqual([{ label: "Code.exe", seconds: 9000, share: 0.625 }]);
  });

  it("sorts busiest first without depending on the API having done it", () => {
    const bars = appUsageBars(
      usage([
        row({ application: "slack.exe", duration: 1800, share: 0.125 }),
        row({ application: "Code.exe", duration: 9000, share: 0.625 }),
        row({ application: "chrome.exe", duration: 3600, share: 0.25 }),
      ]),
    );

    expect(bars.map((bar) => bar.label)).toEqual(["Code.exe", "chrome.exe", "slack.exe"]);
  });

  it("drops rows that would render as a bar of nothing", () => {
    const bars = appUsageBars(
      usage([
        row({ application: "Code.exe", duration: 60, share: 1 }),
        row({ application: "", duration: 600, share: 0 }),
        row({ application: "idle.exe", duration: 0, share: 0 }),
      ]),
    );

    expect(bars.map((bar) => bar.label)).toEqual(["Code.exe"]);
  });

  it("folds the tail into one row rather than truncating it", () => {
    // Truncating implies the visible bars are the whole period. Folding says how
    // much was left out and how many applications it took.
    const rows = Array.from({ length: 9 }, (_, index) =>
      row({ application: `app-${index}`, duration: (9 - index) * 100, share: 0.1 }),
    );

    const bars = appUsageBars(usage(rows), 4);

    expect(bars).toHaveLength(4);
    expect(bars.slice(0, 3).map((bar) => bar.label)).toEqual(["app-0", "app-1", "app-2"]);
    expect(bars[3]?.label).toBe("6 other apps");
    // 600 + 500 + 400 + 300 + 200 + 100
    expect(bars[3]?.seconds).toBe(2100);
    expect(bars[3]?.share).toBeCloseTo(0.6, 10);
  });

  it("does not fold when everything already fits", () => {
    const rows = Array.from({ length: 4 }, (_, index) =>
      row({ application: `app-${index}`, duration: 100, share: 0.25 }),
    );

    expect(appUsageBars(usage(rows), 4).map((bar) => bar.label)).toEqual([
      "app-0",
      "app-1",
      "app-2",
      "app-3",
    ]);
  });

  it("is empty for a document that has not arrived", () => {
    expect(appUsageBars(undefined)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Work pattern                                                                */
/* -------------------------------------------------------------------------- */

describe("workPatternDays", () => {
  it("emits one entry per day in the period, including days nobody worked", () => {
    // The aggregator drops a zero day, which is right for a table and wrong for a
    // trend: without this, Saturday sits next to Monday and the chart draws a
    // continuous week out of two working days.
    const days = workPatternDays(
      document({
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-04T00:00:00.000Z",
        rows: [row({ date: "2026-08-03", tracked: 16800, active: 13500, idle: 900, break: 2400 })],
      }),
    );

    expect(days.map((day) => day.key)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(days[0]).toEqual({
      key: "2026-08-01",
      label: "Sat 1",
      focusedSeconds: 0,
      idleSeconds: 0,
      breakSeconds: 0,
      trackedSeconds: 0,
    });
    expect(days[2]).toEqual({
      key: "2026-08-03",
      label: "Mon 3",
      focusedSeconds: 13500,
      idleSeconds: 900,
      breakSeconds: 2400,
      trackedSeconds: 16800,
    });
  });

  it("labels from UTC parts, so a key is never shifted a day by the reader's zone", () => {
    const days = workPatternDays(
      document({ periodStart: "2026-08-02T00:00:00.000Z", periodEnd: "2026-08-03T00:00:00.000Z" }),
    );

    expect(days.map((day) => day.label)).toEqual(["Sun 2"]);
  });

  it("floors a partial first day onto the same UTC grid the aggregator bucketed by", () => {
    // A local-midnight period start lands mid-UTC-day for most of the world. The
    // grid has to match the keys the aggregator emitted or every row misses.
    const days = workPatternDays(
      document({
        periodStart: "2026-08-01T18:30:00.000Z",
        periodEnd: "2026-08-03T04:00:00.000Z",
        rows: [row({ date: "2026-08-01", tracked: 3600, active: 3600, idle: 0, break: 0 })],
      }),
    );

    expect(days.map((day) => day.key)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(days[0]?.focusedSeconds).toBe(3600);
  });

  it("is empty for no document and for a period that ends before it starts", () => {
    expect(workPatternDays(undefined)).toEqual([]);
    expect(
      workPatternDays(
        document({ periodStart: "2026-08-04T00:00:00.000Z", periodEnd: "2026-08-01T00:00:00.000Z" }),
      ),
    ).toEqual([]);
    expect(
      workPatternDays(document({ periodStart: "not a date", periodEnd: "also not a date" })),
    ).toEqual([]);
  });

  it("refuses to build an unbounded number of bars from an absurd period", () => {
    const days = workPatternDays(
      document({ periodStart: "2020-01-01T00:00:00.000Z", periodEnd: "2026-01-01T00:00:00.000Z" }),
    );

    expect(days).toHaveLength(92);
  });
});
