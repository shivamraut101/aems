import { describe, expect, it } from "vitest";

import {
  summariseFacts,
  apportion,
  combineFacts,
  ACTIVITY_COLUMNS,
  IDLE_COLUMNS,
} from "./aggregate.ts";
import { difference, merge, totalSeconds } from "./intervals.ts";
import { parseJobRequest, resolvePeriod } from "./period.ts";
import {
  buildDocument,
  buildPrompt,
  formatDuration,
  parseModelOutput,
  SYSTEM_PROMPT,
} from "./content.ts";
import type { ActivityRow, IdleRow } from "./aggregate.ts";

const DAY_START = "2026-08-04T00:00:00.000Z";
const DAY_END = "2026-08-05T00:00:00.000Z";

function activity(
  appName: string,
  startedAt: string,
  endedAt: string | null,
  category: string | null = null,
): ActivityRow {
  return { app_name: appName, category, started_at: startedAt, ended_at: endedAt };
}

function idle(startAt: string, endAt: string | null): IdleRow {
  return { idle_start_at: startAt, idle_end_at: endAt };
}

// ---------------------------------------------------------------------------
// intervals — the worker's copy must stay numerically identical to
// packages/analytics/src/intervals.ts. These cases are lifted from
// packages/analytics/src/productivity.test.ts on purpose: if the port ever
// drifts, the assertion that fails here is the same one that would fail there.
// ---------------------------------------------------------------------------

describe("intervals (parity with @aems/analytics)", () => {
  it("collapses overlapping intervals", () => {
    expect(merge([{ start: 0, end: 10 }, { start: 5, end: 20 }])).toEqual([{ start: 0, end: 20 }]);
  });

  it("joins intervals that merely touch", () => {
    expect(merge([{ start: 0, end: 10 }, { start: 10, end: 20 }])).toEqual([{ start: 0, end: 20 }]);
  });

  it("drops zero-length and malformed intervals", () => {
    expect(merge([{ start: 5, end: 5 }, { start: 10, end: 1 }, { start: NaN, end: 4 }])).toEqual([]);
  });

  it("punches a hole in the middle", () => {
    expect(difference([{ start: 0, end: 100 }], [{ start: 40, end: 60 }])).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ]);
  });

  it("rounds to whole seconds", () => {
    expect(totalSeconds([{ start: 0, end: 1500 }])).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// summariseFacts — must reproduce summarisePeriod() exactly. Every case below
// mirrors a case in packages/analytics/src/productivity.test.ts.
// ---------------------------------------------------------------------------

describe("summariseFacts", () => {
  it("counts a single uninterrupted hour as fully active", () => {
    const facts = summariseFacts({
      periodStart: "2026-08-04T09:00:00.000Z",
      periodEnd: "2026-08-04T10:00:00.000Z",
      activity: [activity("code.exe", "2026-08-04T09:00:00.000Z", "2026-08-04T10:00:00.000Z")],
      idle: [],
    });

    expect(facts.activeSeconds).toBe(3600);
    expect(facts.idleSeconds).toBe(0);
    expect(facts.trackedSeconds).toBe(3600);
  });

  it("subtracts idle time from active rather than adding to it", () => {
    const facts = summariseFacts({
      periodStart: "2026-08-04T09:00:00.000Z",
      periodEnd: "2026-08-04T10:00:00.000Z",
      activity: [activity("code.exe", "2026-08-04T09:00:00.000Z", "2026-08-04T10:00:00.000Z")],
      idle: [idle("2026-08-04T09:20:00.000Z", "2026-08-04T09:40:00.000Z")],
    });

    expect(facts.activeSeconds).toBe(2400);
    expect(facts.idleSeconds).toBe(1200);
    expect(facts.activeSeconds + facts.idleSeconds).toBe(3600);
  });

  it("does not double-count two devices reporting the same span", () => {
    const facts = summariseFacts({
      periodStart: "2026-08-04T09:00:00.000Z",
      periodEnd: "2026-08-04T10:00:00.000Z",
      activity: [
        activity("code.exe", "2026-08-04T09:00:00.000Z", "2026-08-04T10:00:00.000Z"),
        activity("slack.exe", "2026-08-04T09:00:00.000Z", "2026-08-04T10:00:00.000Z"),
      ],
      idle: [],
    });

    expect(facts.activeSeconds).toBe(3600);
  });

  it("clips events that overrun the period", () => {
    const facts = summariseFacts({
      periodStart: "2026-08-04T09:00:00.000Z",
      periodEnd: "2026-08-04T10:00:00.000Z",
      activity: [activity("code.exe", "2026-08-04T08:00:00.000Z", "2026-08-04T11:00:00.000Z")],
      idle: [],
    });

    expect(facts.activeSeconds).toBe(3600);
    expect(facts.topApps).toEqual([{ label: "code.exe", seconds: 3600 }]);
  });

  it("treats an unfinished event as running to the end of the period", () => {
    const facts = summariseFacts({
      periodStart: "2026-08-04T09:00:00.000Z",
      periodEnd: "2026-08-04T10:00:00.000Z",
      activity: [activity("code.exe", "2026-08-04T09:30:00.000Z", null)],
      idle: [],
    });

    expect(facts.activeSeconds).toBe(1800);
  });

  it("clamps an unfinished idle span to the period instead of trusting duration_seconds", () => {
    // The old worker summed idle_events.duration_seconds, which is unbounded by
    // the window and null while the span is open. An idle stretch that starts
    // inside the day and never closes must contribute only the part inside it.
    const facts = summariseFacts({
      periodStart: "2026-08-04T09:00:00.000Z",
      periodEnd: "2026-08-04T10:00:00.000Z",
      activity: [activity("code.exe", "2026-08-04T09:00:00.000Z", "2026-08-04T10:00:00.000Z")],
      idle: [idle("2026-08-04T09:50:00.000Z", null)],
    });

    expect(facts.idleSeconds).toBe(600);
    expect(facts.activeSeconds).toBe(3000);
  });

  it("counts every app, not just the ones that fit in the top list", () => {
    // The defect this replaces: activeSeconds was the top-8 apps summed, so a
    // person using nine apps was under-reported against every other surface.
    const activityRows: ActivityRow[] = [];
    for (let i = 0; i < 12; i += 1) {
      const start = new Date(Date.parse("2026-08-04T09:00:00.000Z") + i * 600_000);
      const end = new Date(start.getTime() + 600_000);
      activityRows.push(activity(`app-${i}.exe`, start.toISOString(), end.toISOString()));
    }

    const facts = summariseFacts({
      periodStart: "2026-08-04T09:00:00.000Z",
      periodEnd: "2026-08-04T11:00:00.000Z",
      activity: activityRows,
      idle: [],
    });

    expect(facts.activeSeconds).toBe(7200);
    expect(facts.topApps).toHaveLength(8);
  });

  it("returns zeroes and an empty breakdown when nothing was recorded", () => {
    const facts = summariseFacts({
      periodStart: DAY_START,
      periodEnd: DAY_END,
      activity: [],
      idle: [],
    });

    expect(facts.activeSeconds).toBe(0);
    expect(facts.topApps).toEqual([]);
    expect(facts.breakdown).toEqual([]);
  });

  it("builds the breakdown from categories when the events carry them", () => {
    const facts = summariseFacts({
      periodStart: "2026-08-04T09:00:00.000Z",
      periodEnd: "2026-08-04T13:00:00.000Z",
      activity: [
        activity("code.exe", "2026-08-04T09:00:00.000Z", "2026-08-04T12:00:00.000Z", "development"),
        activity("slack.exe", "2026-08-04T12:00:00.000Z", "2026-08-04T13:00:00.000Z", "communication"),
      ],
      idle: [],
    });

    expect(facts.breakdown).toEqual([
      { label: "Development", percentage: 75 },
      { label: "Communication", percentage: 25 },
    ]);
  });

  it("falls back to application names when no event has a category", () => {
    const facts = summariseFacts({
      periodStart: "2026-08-04T09:00:00.000Z",
      periodEnd: "2026-08-04T13:00:00.000Z",
      activity: [
        activity("code.exe", "2026-08-04T09:00:00.000Z", "2026-08-04T12:00:00.000Z"),
        activity("slack.exe", "2026-08-04T12:00:00.000Z", "2026-08-04T13:00:00.000Z"),
      ],
      idle: [],
    });

    expect(facts.breakdown).toEqual([
      { label: "code.exe", percentage: 75 },
      { label: "slack.exe", percentage: 25 },
    ]);
  });

  it("gathers the tail into Other so the breakdown still totals 100", () => {
    const activityRows: ActivityRow[] = [];
    for (let i = 0; i < 9; i += 1) {
      const start = new Date(Date.parse("2026-08-04T09:00:00.000Z") + i * 600_000);
      const end = new Date(start.getTime() + 600_000);
      activityRows.push(activity(`app-${i}.exe`, start.toISOString(), end.toISOString(), `cat-${i}`));
    }

    const facts = summariseFacts({
      periodStart: "2026-08-04T09:00:00.000Z",
      periodEnd: "2026-08-04T11:00:00.000Z",
      activity: activityRows,
      breakdownLimit: 4,
      idle: [],
    });

    expect(facts.breakdown).toHaveLength(4);
    expect(facts.breakdown[3]?.label).toBe("Other");
    expect(facts.breakdown.reduce((sum, slice) => sum + slice.percentage, 0)).toBe(100);
  });

  it("never selects window titles, URLs or domains", () => {
    // Non-negotiable: aggregates only leave the database for the model. If a
    // column that identifies *what* was on screen is ever added to the select,
    // this test is the thing that stops it.
    for (const forbidden of ["window_title", "url", "domain"]) {
      expect(ACTIVITY_COLUMNS).not.toContain(forbidden);
      expect(IDLE_COLUMNS).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// combineFacts — a company insight covers many people at once.
// ---------------------------------------------------------------------------

describe("combineFacts", () => {
  const hour = (from: string, to: string, category: string | null = null) =>
    summariseFacts({
      periodStart: "2026-08-04T09:00:00.000Z",
      periodEnd: "2026-08-04T17:00:00.000Z",
      activity: [activity("code.exe", from, to, category)],
      idle: [],
    });

  it("adds people together instead of merging their overlapping spans", () => {
    // Two employees both working 09:00-11:00 is four person-hours, not two. A
    // company-wide interval merge would report two, which is the same class of
    // bug as double-counting one person's two devices, inverted.
    const combined = combineFacts([
      hour("2026-08-04T09:00:00.000Z", "2026-08-04T11:00:00.000Z"),
      hour("2026-08-04T09:00:00.000Z", "2026-08-04T11:00:00.000Z"),
    ]);

    expect(combined.activeSeconds).toBe(14_400);
    expect(combined.trackedSeconds).toBe(14_400);
  });

  it("keeps the period of the parts", () => {
    const combined = combineFacts([hour("2026-08-04T09:00:00.000Z", "2026-08-04T10:00:00.000Z")]);
    expect(combined.periodStart).toBe("2026-08-04T09:00:00.000Z");
    expect(combined.periodEnd).toBe("2026-08-04T17:00:00.000Z");
  });

  it("sums the distribution across people before taking percentages", () => {
    const combined = combineFacts([
      hour("2026-08-04T09:00:00.000Z", "2026-08-04T12:00:00.000Z", "development"),
      hour("2026-08-04T09:00:00.000Z", "2026-08-04T10:00:00.000Z", "communication"),
    ]);

    expect(combined.breakdown).toEqual([
      { label: "Development", percentage: 75 },
      { label: "Communication", percentage: 25 },
    ]);
  });

  it("ranks applications on the company total, not on one person's list", () => {
    const combined = combineFacts([
      hour("2026-08-04T09:00:00.000Z", "2026-08-04T10:00:00.000Z"),
      hour("2026-08-04T10:00:00.000Z", "2026-08-04T12:00:00.000Z"),
    ]);

    expect(combined.topApps).toEqual([{ label: "code.exe", seconds: 10_800 }]);
  });

  it("returns an empty period rather than throwing when nobody worked", () => {
    const combined = combineFacts([], { periodStart: DAY_START, periodEnd: DAY_END });
    expect(combined.activeSeconds).toBe(0);
    expect(combined.breakdown).toEqual([]);
    expect(combined.periodStart).toBe(DAY_START);
  });
});

describe("apportion", () => {
  it("distributes an exact split", () => {
    expect(apportion([2, 1, 1])).toEqual([50, 25, 25]);
  });

  it("uses largest remainders so the parts total 100", () => {
    const parts = apportion([1, 1, 1]);
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it("returns nothing for an empty or zero-weight input", () => {
    expect(apportion([])).toEqual([]);
    expect(apportion([0, 0])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// period — kind is a parameter now, not a hardcoded string.
// ---------------------------------------------------------------------------

describe("resolvePeriod", () => {
  it("uses the previous whole UTC day for a daily summary", () => {
    const period = resolvePeriod("daily", new Date("2026-08-05T13:22:41.000Z"));
    expect(period).toEqual({ kind: "daily", start: DAY_START, end: DAY_END });
  });

  it("uses the last complete Monday-to-Monday week for a weekly summary", () => {
    const period = resolvePeriod("weekly", new Date("2026-08-05T13:22:41.000Z"));
    expect(period).toEqual({
      kind: "weekly",
      start: "2026-07-27T00:00:00.000Z",
      end: "2026-08-03T00:00:00.000Z",
    });
  });

  it("does not treat the in-progress week as complete when run on a Sunday", () => {
    const period = resolvePeriod("weekly", new Date("2026-08-09T23:00:00.000Z"));
    expect(period.start).toBe("2026-07-27T00:00:00.000Z");
    expect(period.end).toBe("2026-08-03T00:00:00.000Z");
  });

  it("closes the week that just ended when run on a Monday morning", () => {
    const period = resolvePeriod("weekly", new Date("2026-08-10T03:00:00.000Z"));
    expect(period.start).toBe("2026-08-03T00:00:00.000Z");
    expect(period.end).toBe("2026-08-10T00:00:00.000Z");
  });

  it("gives a company insight the same window as the weekly summary", () => {
    const insight = resolvePeriod("insight", new Date("2026-08-05T13:22:41.000Z"));
    const weekly = resolvePeriod("weekly", new Date("2026-08-05T13:22:41.000Z"));
    expect(insight.start).toBe(weekly.start);
    expect(insight.end).toBe(weekly.end);
    expect(insight.kind).toBe("insight");
  });
});

describe("parseJobRequest", () => {
  it("defaults to daily when nothing is asked for", () => {
    const job = parseJobRequest("https://x.fn/ai-summary-worker", null);
    expect(job.kind).toBe("daily");
  });

  it("reads the kind from the query string", () => {
    const job = parseJobRequest("https://x.fn/ai-summary-worker?kind=weekly", null);
    expect(job.kind).toBe("weekly");
  });

  it("reads the kind and reference date from a JSON body", () => {
    const job = parseJobRequest("https://x.fn/ai-summary-worker", {
      kind: "insight",
      date: "2026-08-05",
    });
    expect(job.kind).toBe("insight");
    expect(job.reference.toISOString()).toBe("2026-08-05T00:00:00.000Z");
  });

  it("rejects a kind the check constraint would refuse", () => {
    expect(() => parseJobRequest("https://x.fn/w?kind=monthly", null)).toThrow(/daily/);
  });

  it("rejects a date it cannot parse rather than silently summarising today", () => {
    expect(() => parseJobRequest("https://x.fn/w?date=not-a-date", null)).toThrow(/date/i);
  });
});

// ---------------------------------------------------------------------------
// content — prompt in, structured document out.
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("omits the hour component below an hour", () => {
    expect(formatDuration(1800)).toBe("30m");
  });

  it("renders hours and minutes", () => {
    expect(formatDuration(29_700)).toBe("8h 15m");
  });

  it("rolls 60 rounded minutes up into the hour", () => {
    expect(formatDuration(3599)).toBe("1h 0m");
  });
});

describe("buildPrompt", () => {
  const facts = summariseFacts({
    periodStart: "2026-08-04T09:00:00.000Z",
    periodEnd: "2026-08-04T13:00:00.000Z",
    activity: [
      activity("code.exe", "2026-08-04T09:00:00.000Z", "2026-08-04T12:00:00.000Z", "development"),
      activity("slack.exe", "2026-08-04T12:00:00.000Z", "2026-08-04T13:00:00.000Z", "communication"),
    ],
    idle: [idle("2026-08-04T11:00:00.000Z", "2026-08-04T11:20:00.000Z")],
  });

  it("carries aggregates only", () => {
    const prompt = buildPrompt({ facts, kind: "daily", subject: "Ada Lovelace" });

    expect(prompt).toContain("Ada Lovelace");
    expect(prompt).toContain("Active time: 3h 40m");
    expect(prompt).toContain("Idle time: 20m");
    expect(prompt).toContain("- Development: 75%");
    expect(prompt).toContain("- code.exe: 3h 0m");
  });

  it("tells the model the percentages are already computed", () => {
    // The breakdown is recorded fact, not model output. If the model were free
    // to invent it, the AI panel would disagree with the timeline again.
    expect(SYSTEM_PROMPT).toMatch(/do not (invent|recompute|change)/i);
  });

  it("names the company rather than a person for a company insight", () => {
    const prompt = buildPrompt({ facts, kind: "insight", subject: "Northwind Ltd" });
    expect(prompt).toContain("Northwind Ltd");
    expect(prompt).toMatch(/week/i);
  });
});

describe("parseModelOutput", () => {
  it("reads the three prose fields from JSON", () => {
    const parsed = parseModelOutput(
      JSON.stringify({
        summary: "Worked mostly in the editor.",
        observation: "Focused time rose against last week.",
        recommendation: "Protect the morning block.",
      }),
    );

    expect(parsed).toEqual({
      summary: "Worked mostly in the editor.",
      observation: "Focused time rose against last week.",
      recommendation: "Protect the morning block.",
    });
  });

  it("unwraps a fenced code block", () => {
    const parsed = parseModelOutput('```json\n{"summary":"Hello."}\n```');
    expect(parsed.summary).toBe("Hello.");
    expect(parsed.observation).toBeNull();
  });

  it("keeps plain prose as the summary when the model ignores the JSON contract", () => {
    const parsed = parseModelOutput("John worked eight hours across three applications.");
    expect(parsed.summary).toBe("John worked eight hours across three applications.");
    expect(parsed.observation).toBeNull();
    expect(parsed.recommendation).toBeNull();
  });

  it("treats an empty or whitespace-only field as absent", () => {
    const parsed = parseModelOutput(JSON.stringify({ summary: "A.", observation: "   " }));
    expect(parsed.observation).toBeNull();
  });

  it("ignores a non-string summary rather than storing [object Object]", () => {
    const parsed = parseModelOutput(JSON.stringify({ summary: { text: "no" } }));
    expect(parsed.summary).toBe("");
  });

  it("reports nothing to store for empty model output", () => {
    expect(parseModelOutput("   ").summary).toBe("");
  });
});

describe("buildDocument", () => {
  const facts = summariseFacts({
    periodStart: "2026-08-04T09:00:00.000Z",
    periodEnd: "2026-08-04T13:00:00.000Z",
    activity: [
      activity("code.exe", "2026-08-04T09:00:00.000Z", "2026-08-04T12:00:00.000Z", "development"),
      activity("slack.exe", "2026-08-04T12:00:00.000Z", "2026-08-04T13:00:00.000Z", "communication"),
    ],
    idle: [],
  });

  it("matches the props ai-insight.tsx declares", () => {
    const doc = buildDocument(facts, '{"summary":"A steady day.","recommendation":"Keep it."}');

    expect(doc.summary).toBe("A steady day.");
    expect(doc.observation).toBeNull();
    expect(doc.recommendation).toBe("Keep it.");
    expect(doc.breakdown).toEqual([
      { label: "Development", percentage: 75 },
      { label: "Communication", percentage: 25 },
    ]);
  });

  it("takes the breakdown from the measured facts, never from the model", () => {
    const doc = buildDocument(
      facts,
      JSON.stringify({ summary: "x", breakdown: [{ label: "Fabricated", percentage: 99 }] }),
    );

    expect(doc.breakdown).toEqual([
      { label: "Development", percentage: 75 },
      { label: "Communication", percentage: 25 },
    ]);
  });

  it("carries the measured totals so the panel can render them without a second call", () => {
    const doc = buildDocument(facts, '{"summary":"A steady day."}');
    expect(doc.activeSeconds).toBe(14_400);
    expect(doc.idleSeconds).toBe(0);
  });

  it("round-trips through JSON, which is how the content column stores it", () => {
    const doc = buildDocument(facts, '{"summary":"A steady day."}');
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});
