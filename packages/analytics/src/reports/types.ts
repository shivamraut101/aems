/**
 * The report contract.
 *
 * One aggregation pass produces a `ReportDocument`; N renderers consume it and none
 * of them can see the events. That seam is why adding a format is a new file rather
 * than a second copy of the arithmetic — which is exactly how the CSV worker and the
 * dashboard came to disagree about the same day.
 */

/** The four report families scope §5 names. */
export type ReportKind = "time_and_activity" | "app_usage" | "website_usage" | "work_breaks";

/** Export formats. Enumerated, not free-form — scope §5 names CSV and PDF. */
export type ReportFormat = "csv" | "pdf";

/**
 * Row keys a report may be grouped on.
 *
 * Deliberately an enum rather than a free pivot: every combination below is one we
 * have decided renders sensibly, and a report that can be pivoted arbitrarily is a
 * report builder — Phase 2.
 */
export type Grouping =
  | "employee"
  | "date"
  | "employee_date"
  | "application"
  | "category"
  | "domain"
  /** One row per underlying record, ungrouped. */
  | "event";

/** How a renderer turns a cell value into text. */
export type ColumnFormat =
  | "text"
  | "seconds"
  | "duration"
  | "decimalHours"
  | "date"
  | "time"
  | "percent"
  | "count";

export type CellValue = string | number | null;

export interface ColumnDef {
  id: string;
  label: string;
  format: ColumnFormat;
  align: "left" | "right";
}

export interface ReportRow {
  cells: Record<string, CellValue>;
}

export interface ReportSection {
  heading: string;
  columns: ColumnDef[];
  rows: ReportRow[];
  /** Null when a total would be meaningless for this shape. */
  totals: ReportRow | null;
}

export interface ReportDocument {
  kind: ReportKind;
  title: string;
  subtitle: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  grouping: Grouping;
  /**
   * Kimai's `decimal` flag: the same column rendered `7h 30m` or `7.50`.
   * Accounting needs one, humans need the other, and the data is identical.
   */
  decimalDuration: boolean;
  sections: ReportSection[];
  rowCount: number;
  /** True when the underlying fetch hit its row ceiling and the totals are partial. */
  truncated: boolean;
  /** Caveats worth printing in the file itself — overlap, truncation. */
  notes: string[];
}

/** A report type as advertised to the dashboard's catalogue. */
export interface ReportTypeDef {
  id: ReportKind;
  label: string;
  description: string;
  groupings: readonly Grouping[];
  defaultGrouping: Grouping;
  /** Lowest role that may run it. Employees run reports over their own data only. */
  minRole: "manager" | "employee";
}

export interface ReportRequest {
  kind: ReportKind;
  grouping: Grouping;
  periodStart: string;
  periodEnd: string;
  decimalDuration?: boolean;
  /** Defaults to the report type's label. */
  title?: string;
  /** Free text under the title — the company or the scope the report covers. */
  subtitle?: string;
  /** Injected so the document is deterministic under test. */
  generatedAt?: string;
}

/*
 * The dataset shapes below are structural on purpose. They are satisfied by the
 * generated table Rows without this package depending on them, so a caller may
 * `select` only the columns a report actually reads.
 */

export interface ReportProfileRow {
  id: string;
  full_name: string;
  email: string;
  department: string | null;
}

export interface ReportActivityRow {
  profile_id: string;
  app_name: string;
  category: string | null;
  domain: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface ReportIdleRow {
  profile_id: string;
  idle_start_at: string;
  idle_end_at: string | null;
}

export interface ReportBreakRow {
  profile_id: string;
  break_start_at: string;
  break_end_at: string | null;
}

export interface ReportDataset {
  profiles: ReportProfileRow[];
  activity: ReportActivityRow[];
  idle: ReportIdleRow[];
  breaks: ReportBreakRow[];
  /** Set by the caller when a fetch hit its row ceiling. */
  truncated?: boolean;
}
