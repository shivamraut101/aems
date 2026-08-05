import type { ReportDocument, ReportRow } from "@aems/analytics";
import { describe, expect, it } from "vitest";

import {
  documentCell,
  documentColumns,
  exportFilename,
  historyView,
  reportFormSchema,
  resolveGrouping,
  scopesForRole,
  toReportSpec,
  type ReportHistoryRow,
  type ReportTypeDto,
} from "./reports";

/* -------------------------------------------------------------------------- */
/* Scope                                                                       */
/* -------------------------------------------------------------------------- */

describe("scopesForRole", () => {
  it("pins an employee to their own data — the API does the same and RLS enforces it", () => {
    expect(scopesForRole("employee").map((scope) => scope.value)).toEqual(["self"]);
  });

  it("offers a manager the three scopes the API resolves", () => {
    expect(scopesForRole("manager").map((scope) => scope.value)).toEqual([
      "company",
      "my_team",
      "self",
    ]);
    expect(scopesForRole("super_admin").map((scope) => scope.value)).toEqual([
      "company",
      "my_team",
      "self",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The form                                                                    */
/* -------------------------------------------------------------------------- */

const validValues = {
  kind: "time_and_activity" as const,
  grouping: "employee" as const,
  scope: "company" as const,
  fromDate: "2026-08-01",
  toDate: "2026-08-05",
  decimalDuration: false,
};

describe("reportFormSchema", () => {
  it("accepts a well-formed range", () => {
    expect(reportFormSchema.safeParse(validValues).success).toBe(true);
  });

  it("accepts a single day, because one day is the commonest report", () => {
    const result = reportFormSchema.safeParse({ ...validValues, toDate: "2026-08-01" });
    expect(result.success).toBe(true);
  });

  it("refuses a range that ends before it starts, rather than letting the API 400", () => {
    const result = reportFormSchema.safeParse({ ...validValues, toDate: "2026-07-30" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/end/i);
    }
  });

  it("refuses a date that is not a date", () => {
    expect(reportFormSchema.safeParse({ ...validValues, fromDate: "01/08/2026" }).success).toBe(false);
  });
});

describe("toReportSpec", () => {
  it("turns two day keys into a half-open window covering both days in full", () => {
    const spec = toReportSpec(validValues);

    expect(Date.parse(spec.periodStart)).toBe(new Date(2026, 7, 1, 0, 0, 0, 0).getTime());
    // Exclusive end: midnight after the 5th, so the 5th is included whole.
    expect(Date.parse(spec.periodEnd)).toBe(new Date(2026, 7, 6, 0, 0, 0, 0).getTime());
  });

  it("carries the rest of the request through unchanged", () => {
    const spec = toReportSpec({ ...validValues, scope: "my_team", decimalDuration: true });
    expect(spec.kind).toBe("time_and_activity");
    expect(spec.grouping).toBe("employee");
    expect(spec.scope).toBe("my_team");
    expect(spec.decimalDuration).toBe(true);
  });

  it("emits instants the API's datetime({ offset: true }) accepts", () => {
    const spec = toReportSpec(validValues);
    expect(spec.periodStart).toMatch(/Z$|[+-]\d{2}:\d{2}$/);
    expect(spec.periodEnd).toMatch(/Z$|[+-]\d{2}:\d{2}$/);
  });
});

const reportType: ReportTypeDto = {
  id: "app_usage",
  label: "Apps",
  description: "Application usage",
  groupings: ["employee", "application", "category"],
  defaultGrouping: "application",
  minRole: "manager",
  columnsByGrouping: {
    application: [{ id: "application", label: "Application", format: "text", align: "left" }],
  },
};

describe("resolveGrouping", () => {
  it("keeps a grouping the type allows", () => {
    expect(resolveGrouping(reportType, "category")).toBe("category");
  });

  it("falls back to the type's default rather than sending one the API will silently swap", () => {
    expect(resolveGrouping(reportType, "domain")).toBe("application");
    expect(resolveGrouping(reportType, undefined)).toBe("application");
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering a document                                                        */
/* -------------------------------------------------------------------------- */

function documentWith(decimalDuration: boolean): ReportDocument {
  return {
    kind: "time_and_activity",
    title: "Time & Activity",
    subtitle: "Whole company",
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-08-06T00:00:00.000Z",
    generatedAt: "2026-08-05T10:00:00.000Z",
    grouping: "employee",
    decimalDuration,
    rowCount: 1,
    truncated: false,
    notes: [],
    sections: [
      {
        heading: "By employee",
        columns: [
          { id: "employee", label: "Employee", format: "text", align: "left" },
          { id: "tracked", label: "Tracked", format: "duration", align: "right" },
          { id: "activeRatio", label: "Active %", format: "percent", align: "right" },
        ],
        rows: [{ cells: { employee: "Ada Lovelace", tracked: 27000, activeRatio: 0.86 } }],
        totals: { cells: { employee: "Total", tracked: 27000, activeRatio: 0.86 } },
      },
    ],
  };
}

describe("documentColumns", () => {
  it("reads the section's own columns rather than a hardcoded list per kind", () => {
    expect(documentColumns(documentWith(false)).map((column) => column.id)).toEqual([
      "employee",
      "tracked",
      "activeRatio",
    ]);
  });

  it("resolves the decimal flag once, at the column, so every cell agrees", () => {
    expect(documentColumns(documentWith(false))[1]?.format).toBe("duration");
    expect(documentColumns(documentWith(true))[1]?.format).toBe("decimalHours");
  });

  it("is empty for a document with no sections instead of throwing", () => {
    const empty = { ...documentWith(false), sections: [] };
    expect(documentColumns(empty)).toEqual([]);
  });
});

describe("documentCell", () => {
  it("renders a duration the way design.md asks for, not as a bare number", () => {
    const columns = documentColumns(documentWith(false));
    const row = documentWith(false).sections[0]?.rows[0] as ReportRow;
    expect(documentCell(row, columns[1]!)).toBe("7h 30m");
  });

  it("renders the same seconds as decimal hours when the flag is set", () => {
    const columns = documentColumns(documentWith(true));
    const row = documentWith(true).sections[0]?.rows[0] as ReportRow;
    expect(documentCell(row, columns[1]!)).toBe("7.50");
  });

  it("renders a missing cell as blank, never as 'undefined'", () => {
    const columns = documentColumns(documentWith(false));
    expect(documentCell({ cells: {} }, columns[0]!)).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* Run history                                                                 */
/* -------------------------------------------------------------------------- */

function historyRow(over: Partial<ReportHistoryRow>): ReportHistoryRow {
  return {
    id: 1,
    company_id: "c1",
    profile_id: null,
    kind: "time_and_activity",
    period_start: "2026-08-01T00:00:00.000Z",
    period_end: "2026-08-06T00:00:00.000Z",
    status: "pending",
    storage_path: null,
    created_at: "2026-08-05T10:00:00.000Z",
    updated_at: "2026-08-05T10:00:00.000Z",
    format: "csv",
    grouping: "employee",
    params: null,
    requested_by: null,
    row_count: null,
    failure_reason: null,
    ...over,
  };
}

describe("historyView", () => {
  it("only offers a download once the file exists", () => {
    expect(historyView(historyRow({ status: "pending" })).downloadable).toBe(false);
    expect(historyView(historyRow({ status: "failed" })).downloadable).toBe(false);
    expect(historyView(historyRow({ status: "ready", storage_path: "x/y.csv" })).downloadable).toBe(true);
  });

  it("shows why a report failed instead of a bare 'failed'", () => {
    const view = historyView(historyRow({ status: "failed", failure_reason: "No rows in range" }));
    expect(view.label).toBe("Failed");
    expect(view.detail).toBe("No rows in range");
  });

  it("says how many rows a finished report holds", () => {
    const view = historyView(historyRow({ status: "ready", storage_path: "x", row_count: 42 }));
    expect(view.detail).toBe("42 rows");
  });

  it("does not invent a reason when the API gave none", () => {
    expect(historyView(historyRow({ status: "failed" })).detail).toBe(null);
  });
});

describe("exportFilename", () => {
  it("names the file after the report and the day it starts", () => {
    expect(exportFilename(toReportSpec(validValues), "csv")).toBe("time_and_activity-2026-08-01.csv");
  });
});
