import type { ReportDocument } from "@aems/analytics";
import { describe, expect, it } from "vitest";

import {
  cellOf,
  compareCells,
  devicesForProfile,
  gigabytes,
  numericFormat,
  osLabel,
  personReports,
  rangeLabel,
  renderCell,
  reportBadgeVariant,
  reportKindLabel,
  sectionOf,
  sharePercent,
  tableColumns,
  websiteCoverage,
  type PersonReportRow,
} from "./usage";

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

function appUsageDocument(overrides: Partial<ReportDocument> = {}): ReportDocument {
  return {
    kind: "app_usage",
    title: "Apps & URLs",
    subtitle: "1 selected person",
    periodStart: "2026-08-05T00:00:00.000Z",
    periodEnd: "2026-08-05T17:00:00.000Z",
    generatedAt: "2026-08-05T17:00:00.000Z",
    grouping: "application",
    decimalDuration: false,
    rowCount: 2,
    truncated: false,
    notes: [],
    sections: [
      {
        heading: "Application usage",
        columns: [
          { id: "application", label: "Application", format: "text", align: "left" },
          { id: "category", label: "Category", format: "text", align: "left" },
          { id: "duration", label: "Duration", format: "duration", align: "right" },
          { id: "share", label: "Share", format: "percent", align: "right" },
        ],
        rows: [
          { cells: { application: "Code.exe", category: "Work > Development", duration: 4500, share: 0.62 } },
          { cells: { application: "chrome.exe", category: "Uncategorized", duration: 1800, share: 0.24 } },
        ],
        totals: { cells: { application: null, category: null, duration: 7200, share: null } },
      },
    ],
    ...overrides,
  };
}

function report(overrides: Partial<PersonReportRow> = {}): PersonReportRow {
  return {
    id: 1,
    company_id: "company-1",
    profile_id: null,
    kind: "time_and_activity",
    period_start: "2026-08-04T00:00:00.000Z",
    period_end: "2026-08-05T00:00:00.000Z",
    status: "ready",
    storage_path: "company-1/company/reports/time_and_activity-1.csv",
    created_at: "2026-08-05T09:00:00.000Z",
    updated_at: "2026-08-05T09:00:10.000Z",
    format: "csv",
    grouping: "employee",
    params: null,
    requested_by: "manager-1",
    row_count: 12,
    failure_reason: null,
    ...overrides,
  };
}

interface DeviceLike {
  id: string;
  profile_id: string;
  platform: "windows" | "macos" | "android";
  status: "active" | "offline" | "revoked";
  last_seen_at: string | null;
}

function device(overrides: Partial<DeviceLike> = {}): DeviceLike {
  return {
    id: "device-1",
    profile_id: "person-1",
    platform: "windows",
    status: "active",
    last_seen_at: "2026-08-05T16:00:00.000Z",
    ...overrides,
  };
}

/* ------------------------------------------------------------------------- */
/* The window every tab reports on                                            */
/* ------------------------------------------------------------------------- */

describe("rangeLabel", () => {
  const now = new Date(2026, 7, 5, 14, 30, 0, 0);
  const todayStart = new Date(2026, 7, 5, 0, 0, 0, 0).toISOString();

  it("names the day in progress rather than printing its date twice", () => {
    expect(rangeLabel(todayStart, now.toISOString(), now)).toBe("Today");
  });

  it("prints one date for a single past day", () => {
    const from = new Date(2026, 7, 1, 0, 0, 0, 0).toISOString();
    const to = new Date(2026, 7, 1, 23, 59, 59, 0).toISOString();

    expect(rangeLabel(from, to, now)).not.toContain("–");
    expect(rangeLabel(from, to, now)).not.toBe("Today");
  });

  it("treats a window ending at midnight as the day before it, not as two days", () => {
    // The "yesterday" preset every screen uses: 00:00 → 00:00. The end is exclusive.
    const from = new Date(2026, 7, 4, 0, 0, 0, 0).toISOString();
    const to = new Date(2026, 7, 5, 0, 0, 0, 0).toISOString();

    expect(rangeLabel(from, to, now)).not.toContain("–");
  });

  it("prints both ends of a multi-day window", () => {
    const from = new Date(2026, 6, 29, 0, 0, 0, 0).toISOString();
    const to = new Date(2026, 7, 5, 0, 0, 0, 0).toISOString();

    expect(rangeLabel(from, to, now)).toContain("–");
  });
});

/* ------------------------------------------------------------------------- */
/* Report document → dense table                                              */
/* ------------------------------------------------------------------------- */

describe("sectionOf", () => {
  it("returns the one section a usage report carries", () => {
    expect(sectionOf(appUsageDocument())?.heading).toBe("Application usage");
  });

  it("returns null rather than an undefined index when a document has no sections", () => {
    expect(sectionOf(appUsageDocument({ sections: [] }))).toBeNull();
    expect(sectionOf(undefined)).toBeNull();
  });
});

describe("numericFormat", () => {
  it("treats every quantity as numeric so a column sorts by value, not by its label", () => {
    expect(numericFormat("duration")).toBe(true);
    expect(numericFormat("decimalHours")).toBe(true);
    expect(numericFormat("percent")).toBe(true);
    expect(numericFormat("count")).toBe(true);
    expect(numericFormat("seconds")).toBe(true);
  });

  it("treats text and instants as non-numeric", () => {
    expect(numericFormat("text")).toBe(false);
    expect(numericFormat("date")).toBe(false);
    expect(numericFormat("time")).toBe(false);
  });
});

describe("tableColumns", () => {
  it("carries the document's own columns through with an alignment and a sort kind", () => {
    const columns = tableColumns(appUsageDocument());

    expect(columns.map((column) => column.id)).toEqual([
      "application",
      "category",
      "duration",
      "share",
    ]);
    expect(columns[2]).toMatchObject({ format: "duration", align: "right", numeric: true });
    expect(columns[0]).toMatchObject({ format: "text", align: "left", numeric: false });
  });

  it("honours the decimal-duration flag, so the screen and the CSV read alike", () => {
    const columns = tableColumns(appUsageDocument({ decimalDuration: true }));

    expect(columns[2]?.format).toBe("decimalHours");
    // Only durations change reading; a percentage is a percentage either way.
    expect(columns[3]?.format).toBe("percent");
  });

  it("returns nothing to render when there is no document yet", () => {
    expect(tableColumns(undefined)).toEqual([]);
  });
});

describe("cellOf / renderCell", () => {
  it("reads a cell as null rather than undefined when the row does not carry it", () => {
    const section = sectionOf(appUsageDocument());
    expect(cellOf(section?.rows[0], "nothing")).toBeNull();
    expect(cellOf(undefined, "duration")).toBeNull();
  });

  it("renders a duration the way docs/design.md asks for, not as a bare number", () => {
    const document = appUsageDocument();
    const columns = tableColumns(document);
    const row = sectionOf(document)?.rows[0];

    expect(renderCell(row, columns[2]!)).toBe("1h 15m");
    expect(renderCell(row, columns[3]!)).toBe("62%");
  });

  it("renders a missing cell as empty rather than as the string 'null'", () => {
    const columns = tableColumns(appUsageDocument());
    expect(renderCell({ cells: {} }, columns[2]!)).toBe("");
  });
});

describe("compareCells", () => {
  it("sorts a quantity by its value, not by the text it renders as", () => {
    // "1h 15m" precedes "45m" alphabetically. A column of durations sorted as text
    // is not sorted at all.
    expect(compareCells(4500, 2700, true)).toBeGreaterThan(0);
    expect(compareCells(0.09, 0.62, true)).toBeLessThan(0);
  });

  it("sorts text case-insensitively, so Chrome and chrome.exe do not split the list", () => {
    expect(compareCells("Code.exe", "chrome.exe", false)).toBeGreaterThan(0);
  });

  it("treats a missing quantity as zero and missing text as empty", () => {
    expect(compareCells(null, 10, true)).toBeLessThan(0);
    expect(compareCells(null, null, true)).toBe(0);
    expect(compareCells(null, "a", false)).toBeLessThan(0);
  });
});

describe("sharePercent", () => {
  it("turns a 0..1 share into a bar width", () => {
    expect(sharePercent(0.4321)).toBe(43);
    expect(sharePercent(1)).toBe(100);
  });

  it("refuses to draw a bar wider than the track or narrower than nothing", () => {
    expect(sharePercent(1.4)).toBe(100);
    expect(sharePercent(-0.2)).toBe(0);
    expect(sharePercent(null)).toBe(0);
    expect(sharePercent("n/a")).toBe(0);
  });
});

/* ------------------------------------------------------------------------- */
/* Website coverage — scope §2.5 is not equally answerable on both platforms   */
/* ------------------------------------------------------------------------- */

describe("websiteCoverage", () => {
  it("reports full fidelity when every device reads the address from the browser", () => {
    const coverage = websiteCoverage(["macos"]);

    expect(coverage.level).toBe("browser-url");
    expect(coverage.note).toMatch(/macOS/);
  });

  it("says plainly that a Windows agent can only read a domain out of a window title", () => {
    const coverage = websiteCoverage(["windows"]);

    expect(coverage.level).toBe("window-title");
    expect(coverage.note).toMatch(/Windows/);
    expect(coverage.note).toMatch(/title/i);
  });

  it("flags a mixed fleet, because half the days will look thinner than the other half", () => {
    expect(websiteCoverage(["macos", "windows"]).level).toBe("mixed");
    expect(websiteCoverage(["windows", "macos"]).level).toBe("mixed");
  });

  it("treats a person with no desktop device as unknown rather than as full coverage", () => {
    expect(websiteCoverage([]).level).toBe("unknown");
    // The Android agent tracks app usage, not browser addresses.
    expect(websiteCoverage(["android"]).level).toBe("unknown");
  });
});

/* ------------------------------------------------------------------------- */
/* This person's reports                                                      */
/* ------------------------------------------------------------------------- */

describe("personReports", () => {
  it("keeps a report queued against this person", () => {
    const rows = [report({ id: 1, profile_id: "person-1" }), report({ id: 2, profile_id: "person-2" })];

    expect(personReports(rows, "person-1").map((row) => row.id)).toEqual([1]);
  });

  it("keeps a company-scope report that named this person in its filters", () => {
    const rows = [
      report({ id: 3, profile_id: null, params: { scope: "profiles", profileIds: ["person-1"] } }),
      report({ id: 4, profile_id: null, params: { scope: "profiles", profileIds: ["person-9"] } }),
    ];

    expect(personReports(rows, "person-1").map((row) => row.id)).toEqual([3]);
  });

  it("drops a whole-company report, which is not this person's report", () => {
    const rows = [report({ id: 5, profile_id: null, params: { scope: "company" } })];

    expect(personReports(rows, "person-1")).toEqual([]);
  });

  it("survives a params blob of a shape nobody planned for", () => {
    const rows = [
      report({ id: 6, profile_id: null, params: "not-an-object" as never }),
      report({ id: 7, profile_id: null, params: { profileIds: "person-1" as never } }),
    ];

    expect(personReports(rows, "person-1")).toEqual([]);
  });

  it("preserves the order the API returned, which is newest first", () => {
    const rows = [
      report({ id: 10, profile_id: "person-1" }),
      report({ id: 9, profile_id: "person-1" }),
    ];

    expect(personReports(rows, "person-1").map((row) => row.id)).toEqual([10, 9]);
  });
});

describe("reportBadgeVariant", () => {
  it("maps a run's state onto the presence palette already in use", () => {
    expect(reportBadgeVariant("ready")).toBe("online");
    expect(reportBadgeVariant("pending")).toBe("offline");
    expect(reportBadgeVariant("failed")).toBe("revoked");
  });
});

describe("reportKindLabel", () => {
  it("names a report from the shared registry so the tab and /reports agree", () => {
    expect(reportKindLabel("app_usage")).toBe("Apps & URLs");
  });

  it("falls back to the stored string for a kind that predates the registry", () => {
    expect(reportKindLabel("daily")).toBe("daily");
  });
});

/* ------------------------------------------------------------------------- */
/* This person's hardware — scope §7                                          */
/* ------------------------------------------------------------------------- */

describe("devicesForProfile", () => {
  it("keeps only the machines assigned to this person", () => {
    const rows = [device({ id: "a" }), device({ id: "b", profile_id: "person-2" })];

    expect(devicesForProfile(rows, "person-1").map((row) => row.id)).toEqual(["a"]);
  });

  it("puts a live machine above a quiet one and a revoked one last", () => {
    const rows = [
      device({ id: "revoked", status: "revoked" }),
      device({ id: "offline", status: "offline" }),
      device({ id: "active", status: "active" }),
    ];

    expect(devicesForProfile(rows, "person-1").map((row) => row.id)).toEqual([
      "active",
      "offline",
      "revoked",
    ]);
  });

  it("orders equals by the most recent heartbeat, with never-seen last", () => {
    const rows = [
      device({ id: "never", last_seen_at: null }),
      device({ id: "older", last_seen_at: "2026-08-05T10:00:00.000Z" }),
      device({ id: "newer", last_seen_at: "2026-08-05T16:00:00.000Z" }),
    ];

    expect(devicesForProfile(rows, "person-1").map((row) => row.id)).toEqual([
      "newer",
      "older",
      "never",
    ]);
  });
});

describe("gigabytes", () => {
  it("renders memory and storage in the unit a spec sheet uses", () => {
    expect(gigabytes(16384)).toBe("16 GB");
    expect(gigabytes(512000)).toBe("500 GB");
  });

  it("renders an unreported figure as a dash, never as 0 GB", () => {
    expect(gigabytes(null)).toBe("—");
    expect(gigabytes(0)).toBe("—");
  });
});

describe("osLabel", () => {
  it("reads as an operating system, not as an enum member", () => {
    expect(osLabel("windows", "11 26100")).toBe("Windows 11 26100");
    expect(osLabel("macos", "15.1")).toBe("macOS 15.1");
  });

  it("leaves no trailing space when the agent reported no version", () => {
    expect(osLabel("windows", "")).toBe("Windows");
    expect(osLabel("android", null)).toBe("Android");
  });
});
