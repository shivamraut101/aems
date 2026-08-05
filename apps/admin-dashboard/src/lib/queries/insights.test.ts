import { describe, expect, it } from "vitest";

import { NetworkError, apiErrorFor } from "@/lib/api";

import {
  isInsightsUnavailable,
  kindOptionsForRole,
  periodLabel,
  readInsight,
  sortByPeriodDesc,
  type AiSummaryRow,
} from "./insights";

/* -------------------------------------------------------------------------- */
/* Parsing what the worker stored                                              */
/* -------------------------------------------------------------------------- */

const structured = JSON.stringify({
  version: 1,
  summary: "Ada spent most of the day in development work.",
  breakdown: [
    { label: "Development", percentage: 62 },
    { label: "Communication", percentage: 38 },
  ],
  observation: "Focus blocks were longer than last week.",
  recommendation: "Keep the morning free of meetings.",
  activeSeconds: 27000,
  idleSeconds: 1800,
  trackedSeconds: 28800,
  topApps: [{ label: "Code", seconds: 20000 }],
});

describe("readInsight", () => {
  it("reads a version 1 document straight into the panel's props", () => {
    const view = readInsight(structured);

    expect(view.structured).toBe(true);
    expect(view.summary).toBe("Ada spent most of the day in development work.");
    expect(view.breakdown).toEqual([
      { label: "Development", percentage: 62 },
      { label: "Communication", percentage: 38 },
    ]);
    expect(view.observation).toBe("Focus blocks were longer than last week.");
    expect(view.recommendation).toBe("Keep the morning free of meetings.");
  });

  it("keeps the measured seconds apart from the model's prose", () => {
    // The numbers are recorded fact and the sentences are a model's reading of them.
    // The panel renders them differently, so the split has to survive parsing.
    const view = readInsight(structured);

    expect(view.measured).toEqual({
      activeSeconds: 27000,
      idleSeconds: 1800,
      trackedSeconds: 28800,
      topApps: [{ label: "Code", seconds: 20000 }],
    });
  });

  it("degrades a pre-JSON prose row instead of breaking the panel", () => {
    const view = readInsight("John worked 8h 15m. Productivity was steady.");

    expect(view.structured).toBe(false);
    expect(view.summary).toBe("John worked 8h 15m. Productivity was steady.");
    expect(view.breakdown).toEqual([]);
    expect(view.measured).toBe(null);
  });

  it("takes the summary from a future version rather than guessing at its shape", () => {
    const view = readInsight(JSON.stringify({ version: 2, summary: "Something new.", breakdown: [] }));

    expect(view.structured).toBe(false);
    expect(view.summary).toBe("Something new.");
  });

  it("never renders raw JSON at a person when the document is unreadable", () => {
    const view = readInsight(JSON.stringify({ version: 1, breakdown: [] }));

    expect(view.summary).toBe("");
    expect(view.structured).toBe(false);
  });

  it("drops breakdown entries that cannot be rendered", () => {
    const view = readInsight(
      JSON.stringify({
        version: 1,
        summary: "ok",
        breakdown: [
          { label: "Development", percentage: 60 },
          { label: "", percentage: 20 },
          { label: "Broken" },
          "nonsense",
        ],
      }),
    );

    expect(view.breakdown).toEqual([{ label: "Development", percentage: 60 }]);
  });

  it("treats a non-array breakdown as no breakdown", () => {
    const view = readInsight(JSON.stringify({ version: 1, summary: "ok", breakdown: "62%" }));
    expect(view.breakdown).toEqual([]);
  });

  it("has no measured block when the document omits the numbers", () => {
    const view = readInsight(JSON.stringify({ version: 1, summary: "ok" }));
    expect(view.measured).toBe(null);
  });
});

/* -------------------------------------------------------------------------- */
/* Periods                                                                     */
/* -------------------------------------------------------------------------- */

describe("periodLabel", () => {
  it("names the day a daily summary covers", () => {
    expect(periodLabel("daily", "2026-08-04T00:00:00Z", "2026-08-05T00:00:00Z")).toBe("4 Aug 2026");
  });

  it("names the week a weekly summary opens on", () => {
    expect(periodLabel("weekly", "2026-08-03T00:00:00Z", "2026-08-10T00:00:00Z")).toBe(
      "Week of 3 Aug 2026",
    );
  });

  it("labels a company insight by its week too", () => {
    expect(periodLabel("insight", "2026-08-03T00:00:00Z", "2026-08-10T00:00:00Z")).toBe(
      "Week of 3 Aug 2026",
    );
  });
});

function row(over: Partial<AiSummaryRow> & { period_start: string }): AiSummaryRow {
  return {
    id: 1,
    company_id: "c1",
    profile_id: null,
    kind: "insight",
    period_end: "2026-08-10T00:00:00Z",
    provider: "claude",
    model: "claude-sonnet-4",
    content: "{}",
    created_at: "2026-08-10T02:00:00Z",
    ...over,
  };
}

describe("sortByPeriodDesc", () => {
  it("puts the newest period first whatever order the API used", () => {
    const sorted = sortByPeriodDesc([
      row({ period_start: "2026-07-27T00:00:00Z" }),
      row({ period_start: "2026-08-10T00:00:00Z" }),
      row({ period_start: "2026-08-03T00:00:00Z" }),
    ]);

    expect(sorted.map((entry) => entry.period_start)).toEqual([
      "2026-08-10T00:00:00Z",
      "2026-08-03T00:00:00Z",
      "2026-07-27T00:00:00Z",
    ]);
  });

  it("does not mutate the query cache's array", () => {
    const input = [row({ period_start: "2026-07-27T00:00:00Z" }), row({ period_start: "2026-08-10T00:00:00Z" })];
    sortByPeriodDesc(input);
    expect(input[0]?.period_start).toBe("2026-07-27T00:00:00Z");
  });
});

/* -------------------------------------------------------------------------- */
/* Role gating and availability                                                */
/* -------------------------------------------------------------------------- */

describe("kindOptionsForRole", () => {
  it("does not offer an employee the company row, which RLS refuses them", () => {
    expect(kindOptionsForRole("employee").map((option) => option.value)).toEqual(["daily", "weekly"]);
  });

  it("leads a manager with the company insight", () => {
    expect(kindOptionsForRole("manager").map((option) => option.value)).toEqual([
      "insight",
      "weekly",
      "daily",
    ]);
  });
});

describe("isInsightsUnavailable", () => {
  it("is true for a 404 — the read path is not deployed, which is not the reader's problem", () => {
    expect(isInsightsUnavailable(apiErrorFor(404, { error: "not_found" }))).toBe(true);
  });

  it("is false for anything the reader can act on", () => {
    expect(isInsightsUnavailable(apiErrorFor(403, { error: "forbidden" }))).toBe(false);
    expect(isInsightsUnavailable(apiErrorFor(500, { error: "boom" }))).toBe(false);
    expect(isInsightsUnavailable(new NetworkError("offline"))).toBe(false);
  });
});
