import { describe, expect, it } from "vitest";

import { buildReportDocument } from "./aggregate.js";
import type { ReportDataset, ReportRequest, ReportSection } from "./types.js";

const ANA = "11111111-1111-1111-1111-111111111111";
const BEN = "22222222-2222-2222-2222-222222222222";

const DAY_START = "2026-08-04T00:00:00.000Z";
const DAY_END = "2026-08-05T00:00:00.000Z";

function dataset(overrides: Partial<ReportDataset> = {}): ReportDataset {
  return {
    profiles: [
      { id: ANA, full_name: "Ana Ruiz", email: "ana@acme.test", department: "Engineering" },
      { id: BEN, full_name: "Ben Okafor", email: "ben@acme.test", department: "Support" },
    ],
    activity: [],
    idle: [],
    breaks: [],
    truncated: false,
    ...overrides,
  };
}

function request(overrides: Partial<ReportRequest> = {}): ReportRequest {
  return {
    kind: "time_and_activity",
    grouping: "employee",
    periodStart: DAY_START,
    periodEnd: DAY_END,
    generatedAt: "2026-08-05T10:00:00.000Z",
    ...overrides,
  };
}

function section(doc: { sections: ReportSection[] }): ReportSection {
  const first = doc.sections[0];
  if (!first) throw new Error("expected a section");
  return first;
}

function cell(row: { cells: Record<string, unknown> } | null, id: string): unknown {
  if (!row) throw new Error("expected a row");
  return row.cells[id];
}

describe("buildReportDocument — document envelope", () => {
  it("labels itself with the report type and the period it covers", () => {
    const doc = buildReportDocument(request(), dataset());

    expect(doc.kind).toBe("time_and_activity");
    expect(doc.title).toBe("Time & Activity");
    expect(doc.periodStart).toBe(DAY_START);
    expect(doc.periodEnd).toBe(DAY_END);
    expect(doc.generatedAt).toBe("2026-08-05T10:00:00.000Z");
    expect(doc.grouping).toBe("employee");
  });

  it("falls back to the type's default grouping when asked for one it does not allow", () => {
    const doc = buildReportDocument(request({ grouping: "domain" }), dataset());
    expect(doc.grouping).toBe("employee");
  });

  it("carries a truncation note into the document so the file admits it", () => {
    const doc = buildReportDocument(request(), dataset({ truncated: true }));
    expect(doc.truncated).toBe(true);
    expect(doc.notes.join(" ")).toMatch(/partial/i);
  });

  it("produces a section with the registry's columns and an empty body for no data", () => {
    const doc = buildReportDocument(request(), dataset());
    const s = section(doc);
    expect(s.columns.map((c) => c.id)).toContain("tracked");
    expect(s.rows).toEqual([]);
    expect(doc.rowCount).toBe(0);
  });
});

describe("buildReportDocument — time_and_activity", () => {
  it("subtracts idle from active rather than counting it alongside", () => {
    const doc = buildReportDocument(
      request(),
      dataset({
        activity: [
          {
            profile_id: ANA,
            app_name: "VS Code",
            category: null,
            domain: null,
            started_at: "2026-08-04T09:00:00.000Z",
            ended_at: "2026-08-04T11:00:00.000Z",
          },
        ],
        idle: [
          {
            profile_id: ANA,
            idle_start_at: "2026-08-04T10:00:00.000Z",
            idle_end_at: "2026-08-04T10:30:00.000Z",
          },
        ],
      }),
    );

    const row = section(doc).rows[0] ?? null;
    expect(cell(row, "employee")).toBe("Ana Ruiz");
    expect(cell(row, "active")).toBe(5_400);
    expect(cell(row, "idle")).toBe(1_800);
    expect(cell(row, "tracked")).toBe(7_200);
    expect(cell(row, "activeRatio")).toBeCloseTo(0.75, 4);
  });

  it("clamps an interval that runs past the end of the window", () => {
    // The old worker used period_end only as a null fallback and never as a cap,
    // so a 16:50-18:20 event was credited 5400s against a window ending at 17:00.
    const doc = buildReportDocument(
      request(),
      dataset({
        activity: [
          {
            profile_id: ANA,
            app_name: "VS Code",
            category: null,
            domain: null,
            started_at: "2026-08-03T23:50:00.000Z",
            ended_at: "2026-08-05T01:20:00.000Z",
          },
        ],
      }),
    );

    expect(cell(section(doc).rows[0] ?? null, "tracked")).toBe(86_400);
  });

  it("counts an event that started before the window but overlaps it", () => {
    // Filtering on started_at >= period_start dropped these entirely.
    const doc = buildReportDocument(
      request(),
      dataset({
        activity: [
          {
            profile_id: ANA,
            app_name: "VS Code",
            category: null,
            domain: null,
            started_at: "2026-08-03T23:00:00.000Z",
            ended_at: "2026-08-04T01:00:00.000Z",
          },
        ],
      }),
    );

    expect(cell(section(doc).rows[0] ?? null, "tracked")).toBe(3_600);
  });

  it("counts one person's two overlapping devices once", () => {
    const doc = buildReportDocument(
      request(),
      dataset({
        activity: [
          {
            profile_id: ANA,
            app_name: "VS Code",
            category: null,
            domain: null,
            started_at: "2026-08-04T09:00:00.000Z",
            ended_at: "2026-08-04T10:00:00.000Z",
          },
          {
            profile_id: ANA,
            app_name: "Chrome",
            category: null,
            domain: null,
            started_at: "2026-08-04T09:00:00.000Z",
            ended_at: "2026-08-04T10:00:00.000Z",
          },
        ],
      }),
    );

    expect(cell(section(doc).rows[0] ?? null, "tracked")).toBe(3_600);
  });

  it("counts two different people's overlapping hours twice", () => {
    // Merging across people would be wrong: two employees really did work that hour.
    const doc = buildReportDocument(
      request({ grouping: "date" }),
      dataset({
        activity: [
          {
            profile_id: ANA,
            app_name: "VS Code",
            category: null,
            domain: null,
            started_at: "2026-08-04T09:00:00.000Z",
            ended_at: "2026-08-04T10:00:00.000Z",
          },
          {
            profile_id: BEN,
            app_name: "Slack",
            category: null,
            domain: null,
            started_at: "2026-08-04T09:00:00.000Z",
            ended_at: "2026-08-04T10:00:00.000Z",
          },
        ],
      }),
    );

    expect(cell(section(doc).rows[0] ?? null, "tracked")).toBe(7_200);
  });

  it("reports declared break time in its own column and keeps it out of active", () => {
    const doc = buildReportDocument(
      request(),
      dataset({
        activity: [
          {
            profile_id: ANA,
            app_name: "VS Code",
            category: null,
            domain: null,
            started_at: "2026-08-04T09:00:00.000Z",
            ended_at: "2026-08-04T11:00:00.000Z",
          },
        ],
        breaks: [
          {
            profile_id: ANA,
            break_start_at: "2026-08-04T10:00:00.000Z",
            break_end_at: "2026-08-04T10:15:00.000Z",
          },
        ],
      }),
    );

    const row = section(doc).rows[0] ?? null;
    expect(cell(row, "break")).toBe(900);
    expect(cell(row, "active")).toBe(6_300);
    expect(cell(row, "tracked")).toBe(7_200);
  });

  it("splits an overnight interval across the days it actually covers", () => {
    const doc = buildReportDocument(
      request({
        grouping: "date",
        periodStart: "2026-08-04T00:00:00.000Z",
        periodEnd: "2026-08-06T00:00:00.000Z",
      }),
      dataset({
        activity: [
          {
            profile_id: ANA,
            app_name: "VS Code",
            category: null,
            domain: null,
            started_at: "2026-08-04T23:00:00.000Z",
            ended_at: "2026-08-05T01:00:00.000Z",
          },
        ],
      }),
    );

    const rows = section(doc).rows;
    expect(rows).toHaveLength(2);
    expect(cell(rows[0] ?? null, "date")).toBe("2026-08-04");
    expect(cell(rows[0] ?? null, "tracked")).toBe(3_600);
    expect(cell(rows[1] ?? null, "date")).toBe("2026-08-05");
    expect(cell(rows[1] ?? null, "tracked")).toBe(3_600);
  });

  it("adds a totals row that sums the people rather than merging them", () => {
    const doc = buildReportDocument(
      request(),
      dataset({
        activity: [
          {
            profile_id: ANA,
            app_name: "VS Code",
            category: null,
            domain: null,
            started_at: "2026-08-04T09:00:00.000Z",
            ended_at: "2026-08-04T10:00:00.000Z",
          },
          {
            profile_id: BEN,
            app_name: "Slack",
            category: null,
            domain: null,
            started_at: "2026-08-04T09:00:00.000Z",
            ended_at: "2026-08-04T10:00:00.000Z",
          },
        ],
      }),
    );

    expect(cell(section(doc).totals, "tracked")).toBe(7_200);
    expect(cell(section(doc).totals, "active")).toBe(7_200);
  });

  it("omits a person with no recorded time rather than padding the report with zeros", () => {
    const doc = buildReportDocument(
      request(),
      dataset({
        activity: [
          {
            profile_id: ANA,
            app_name: "VS Code",
            category: null,
            domain: null,
            started_at: "2026-08-04T09:00:00.000Z",
            ended_at: "2026-08-04T10:00:00.000Z",
          },
        ],
      }),
    );

    expect(section(doc).rows).toHaveLength(1);
  });

  it("names an unknown profile id rather than printing a bare UUID", () => {
    const doc = buildReportDocument(
      request(),
      dataset({
        profiles: [],
        activity: [
          {
            profile_id: ANA,
            app_name: "VS Code",
            category: null,
            domain: null,
            started_at: "2026-08-04T09:00:00.000Z",
            ended_at: "2026-08-04T10:00:00.000Z",
          },
        ],
      }),
    );

    expect(cell(section(doc).rows[0] ?? null, "employee")).toBe("Unknown employee");
  });
});

describe("buildReportDocument — app_usage", () => {
  const data = dataset({
    activity: [
      {
        profile_id: ANA,
        app_name: "VS Code",
        category: "development",
        domain: null,
        started_at: "2026-08-04T09:00:00.000Z",
        ended_at: "2026-08-04T11:00:00.000Z",
      },
      {
        profile_id: BEN,
        app_name: "VS Code",
        category: "development",
        domain: null,
        started_at: "2026-08-04T09:00:00.000Z",
        ended_at: "2026-08-04T10:00:00.000Z",
      },
      {
        profile_id: BEN,
        app_name: "Slack",
        category: "communication",
        domain: null,
        started_at: "2026-08-04T10:00:00.000Z",
        ended_at: "2026-08-04T10:30:00.000Z",
      },
    ],
  });

  it("totals one row per application, busiest first", () => {
    const doc = buildReportDocument(request({ kind: "app_usage", grouping: "application" }), data);
    const rows = section(doc).rows;

    expect(rows).toHaveLength(2);
    expect(cell(rows[0] ?? null, "application")).toBe("VS Code");
    expect(cell(rows[0] ?? null, "duration")).toBe(10_800);
    expect(cell(rows[1] ?? null, "application")).toBe("Slack");
    expect(cell(rows[1] ?? null, "duration")).toBe(1_800);
  });

  it("expresses each row's share of the whole", () => {
    const doc = buildReportDocument(request({ kind: "app_usage", grouping: "application" }), data);
    const rows = section(doc).rows;
    expect(cell(rows[0] ?? null, "share")).toBeCloseTo(10_800 / 12_600, 4);
  });

  it("splits per employee when grouped by employee", () => {
    const doc = buildReportDocument(request({ kind: "app_usage", grouping: "employee" }), data);
    const rows = section(doc).rows;

    expect(rows).toHaveLength(3);
    expect(cell(rows[0] ?? null, "employee")).toBe("Ana Ruiz");
    expect(cell(rows[0] ?? null, "application")).toBe("VS Code");
  });

  it("rolls up by category when grouped by category", () => {
    const doc = buildReportDocument(request({ kind: "app_usage", grouping: "category" }), data);
    const rows = section(doc).rows;

    expect(rows).toHaveLength(2);
    expect(cell(rows[0] ?? null, "category")).toBe("development");
    expect(cell(rows[0] ?? null, "duration")).toBe(10_800);
  });

  it("labels an uncategorised event rather than leaving the cell blank", () => {
    const doc = buildReportDocument(
      request({ kind: "app_usage", grouping: "category" }),
      dataset({
        activity: [
          {
            profile_id: ANA,
            app_name: "VS Code",
            category: null,
            domain: null,
            started_at: "2026-08-04T09:00:00.000Z",
            ended_at: "2026-08-04T10:00:00.000Z",
          },
        ],
      }),
    );

    expect(cell(section(doc).rows[0] ?? null, "category")).toBe("Uncategorized");
  });

  it("makes simultaneous per-device app time visible in a note instead of silently double-counting", () => {
    // Two apps focused at once on two devices sum to more than the clock contains.
    const doc = buildReportDocument(
      request({ kind: "app_usage", grouping: "application" }),
      dataset({
        activity: [
          {
            profile_id: ANA,
            app_name: "VS Code",
            category: null,
            domain: null,
            started_at: "2026-08-04T09:00:00.000Z",
            ended_at: "2026-08-04T10:00:00.000Z",
          },
          {
            profile_id: ANA,
            app_name: "Chrome",
            category: null,
            domain: null,
            started_at: "2026-08-04T09:00:00.000Z",
            ended_at: "2026-08-04T10:00:00.000Z",
          },
        ],
      }),
    );

    // The totals row reports merged wall-clock time, not the sum of the rows.
    expect(cell(section(doc).totals, "duration")).toBe(3_600);
    expect(doc.notes.join(" ")).toMatch(/overlap/i);
  });
});

describe("buildReportDocument — website_usage", () => {
  const data = dataset({
    activity: [
      {
        profile_id: ANA,
        app_name: "Chrome",
        category: null,
        domain: "github.com",
        started_at: "2026-08-04T09:00:00.000Z",
        ended_at: "2026-08-04T10:00:00.000Z",
      },
      {
        profile_id: ANA,
        app_name: "Chrome",
        category: null,
        domain: "github.com",
        started_at: "2026-08-04T11:00:00.000Z",
        ended_at: "2026-08-04T11:30:00.000Z",
      },
      {
        profile_id: ANA,
        app_name: "Chrome",
        category: null,
        domain: null,
        started_at: "2026-08-04T12:00:00.000Z",
        ended_at: "2026-08-04T13:00:00.000Z",
      },
    ],
  });

  it("groups by domain with a visit count and ignores events that carry no domain", () => {
    const doc = buildReportDocument(request({ kind: "website_usage", grouping: "domain" }), data);
    const rows = section(doc).rows;

    expect(rows).toHaveLength(1);
    expect(cell(rows[0] ?? null, "domain")).toBe("github.com");
    expect(cell(rows[0] ?? null, "duration")).toBe(5_400);
    expect(cell(rows[0] ?? null, "visits")).toBe(2);
  });

  it("sums visit counts in the totals row", () => {
    const doc = buildReportDocument(request({ kind: "website_usage", grouping: "domain" }), data);
    expect(cell(section(doc).totals, "visits")).toBe(2);
  });
});

describe("buildReportDocument — work_breaks", () => {
  const data = dataset({
    breaks: [
      {
        profile_id: ANA,
        break_start_at: "2026-08-04T12:00:00.000Z",
        break_end_at: "2026-08-04T12:30:00.000Z",
      },
      {
        profile_id: ANA,
        break_start_at: "2026-08-04T15:00:00.000Z",
        break_end_at: "2026-08-04T15:10:00.000Z",
      },
      {
        profile_id: BEN,
        break_start_at: "2026-08-04T13:00:00.000Z",
        break_end_at: null,
      },
    ],
  });

  it("lists one row per break with a start, an end and a duration", () => {
    const doc = buildReportDocument(request({ kind: "work_breaks", grouping: "event" }), data);
    const rows = section(doc).rows;

    expect(rows).toHaveLength(3);
    expect(cell(rows[0] ?? null, "employee")).toBe("Ana Ruiz");
    expect(cell(rows[0] ?? null, "breakStart")).toBe("2026-08-04T12:00:00.000Z");
    expect(cell(rows[0] ?? null, "duration")).toBe(1_800);
  });

  it("leaves the end of an unfinished break blank rather than inventing one", () => {
    const doc = buildReportDocument(request({ kind: "work_breaks", grouping: "event" }), data);
    const open = section(doc).rows.find((r) => r.cells["employee"] === "Ben Okafor");
    expect(cell(open ?? null, "breakEnd")).toBeNull();
  });

  it("rolls up per employee with a count, a total and the longest break", () => {
    const doc = buildReportDocument(request({ kind: "work_breaks", grouping: "employee" }), data);
    const ana = section(doc).rows.find((r) => r.cells["employee"] === "Ana Ruiz");

    expect(cell(ana ?? null, "breaks")).toBe(2);
    expect(cell(ana ?? null, "duration")).toBe(2_400);
    expect(cell(ana ?? null, "longest")).toBe(1_800);
  });

  it("counts breaks in the totals row", () => {
    const doc = buildReportDocument(request({ kind: "work_breaks", grouping: "employee" }), data);
    expect(cell(section(doc).totals, "breaks")).toBe(3);
  });
});
