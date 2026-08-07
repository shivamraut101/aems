import type { ColumnDef, Grouping, ReportKind, ReportTypeDef } from "./types.js";

/**
 * The report catalogue.
 *
 * `kind` used to be an opaque enum that changed only the output filename, so a
 * daily, a weekly and a team report produced byte-identical CSVs. A report type is
 * now a real object: its own columns, its own enumerated groupings, its own role
 * gate. The dashboard renders this list rather than hardcoding one of its own.
 */
export const REPORT_KINDS = [
  "time_and_activity",
  "app_usage",
  "website_usage",
  "work_breaks",
] as const satisfies readonly ReportKind[];

const TYPES: Record<ReportKind, ReportTypeDef> = {
  time_and_activity: {
    id: "time_and_activity",
    label: "Time & Activity",
    description: "Tracked, active, idle and break time per employee or per day.",
    groupings: ["employee", "date", "employee_date"],
    defaultGrouping: "employee",
    minRole: "employee",
  },
  app_usage: {
    id: "app_usage",
    label: "Apps & URLs",
    description: "Time spent in each application, with its share of the period.",
    groupings: ["application", "employee", "category"],
    defaultGrouping: "application",
    minRole: "employee",
  },
  website_usage: {
    id: "website_usage",
    label: "Website Usage",
    description: "Time and visit counts per domain.",
    groupings: ["domain", "employee"],
    defaultGrouping: "domain",
    minRole: "employee",
  },
  work_breaks: {
    id: "work_breaks",
    label: "Work Breaks",
    description: "Declared breaks — when they started, how long they ran.",
    groupings: ["event", "employee", "date", "employee_date"],
    defaultGrouping: "employee",
    minRole: "manager",
  },
};

export function getReportType(kind: ReportKind): ReportTypeDef {
  return TYPES[kind];
}

/** Lookup for untrusted input — answers rather than throwing. */
export function findReportType(kind: string): ReportTypeDef | undefined {
  return (REPORT_KINDS as readonly string[]).includes(kind)
    ? TYPES[kind as ReportKind]
    : undefined;
}

export function isGroupingAllowed(kind: ReportKind, grouping: Grouping): boolean {
  return TYPES[kind].groupings.includes(grouping);
}

export function defaultGrouping(kind: ReportKind): Grouping {
  return TYPES[kind].defaultGrouping;
}

/**
 * The catalogue a given role may run.
 *
 * UX only — RLS is the boundary. It exists so the screen never offers a report the
 * database is going to refuse.
 */
export function listReportTypes(role: "super_admin" | "manager" | "employee"): ReportTypeDef[] {
  return REPORT_KINDS.map((kind) => TYPES[kind]).filter(
    (type) => role !== "employee" || type.minRole === "employee",
  );
}

const EMPLOYEE: ColumnDef = { id: "employee", label: "Employee", format: "text", align: "left" };
const DEPARTMENT: ColumnDef = { id: "department", label: "Department", format: "text", align: "left" };
const DATE: ColumnDef = { id: "date", label: "Date", format: "date", align: "left" };

/**
 * The columns a (type, grouping) pair renders.
 *
 * Grouping changes the shape of a row, so it has to change the columns too — a
 * per-date row has no single employee and a per-employee row has no single date.
 */
export function columnsFor(kind: ReportKind, grouping: Grouping): ColumnDef[] {
  if (!isGroupingAllowed(kind, grouping)) return [];

  const perEmployee = grouping === "employee" || grouping === "employee_date" || grouping === "event";
  const perDate = grouping === "date" || grouping === "employee_date";

  switch (kind) {
    case "time_and_activity": {
      const columns: ColumnDef[] = [];
      if (perEmployee) columns.push(EMPLOYEE, DEPARTMENT);
      if (perDate) columns.push(DATE);
      columns.push(
        { id: "tracked", label: "Tracked", format: "duration", align: "right" },
        { id: "active", label: "Active", format: "duration", align: "right" },
        { id: "idle", label: "Idle", format: "duration", align: "right" },
        { id: "break", label: "Break", format: "duration", align: "right" },
        { id: "activeRatio", label: "Active %", format: "percent", align: "right" },
      );
      return columns;
    }

    case "app_usage": {
      const columns: ColumnDef[] = [];
      if (perEmployee) columns.push(EMPLOYEE, DEPARTMENT);
      if (grouping !== "category") {
        columns.push({ id: "application", label: "Application", format: "text", align: "left" });
      }
      columns.push({ id: "category", label: "Category", format: "text", align: "left" });
      columns.push(
        { id: "duration", label: "Duration", format: "duration", align: "right" },
        // How many separate times the app was opened, not how long it was held. The
        // desktop agent counts one focus interval per switch and the Android agent
        // counts one foreground session per opening, so both sides of the same column
        // mean the same thing: a row is a visit.
        { id: "opens", label: "Opens", format: "count", align: "right" },
        { id: "share", label: "Share", format: "percent", align: "right" },
      );
      return columns;
    }

    case "website_usage": {
      const columns: ColumnDef[] = [];
      if (perEmployee) columns.push(EMPLOYEE, DEPARTMENT);
      columns.push(
        { id: "domain", label: "Domain", format: "text", align: "left" },
        { id: "duration", label: "Duration", format: "duration", align: "right" },
        { id: "visits", label: "Visits", format: "count", align: "right" },
        { id: "share", label: "Share", format: "percent", align: "right" },
      );
      return columns;
    }

    case "work_breaks": {
      const columns: ColumnDef[] = [];
      if (perEmployee) columns.push(EMPLOYEE, DEPARTMENT);
      if (perDate || grouping === "event") columns.push(DATE);

      if (grouping === "event") {
        columns.push(
          { id: "breakStart", label: "Break start", format: "time", align: "left" },
          { id: "breakEnd", label: "Break end", format: "time", align: "left" },
          { id: "duration", label: "Duration", format: "duration", align: "right" },
        );
        return columns;
      }

      columns.push(
        { id: "breaks", label: "Breaks", format: "count", align: "right" },
        { id: "duration", label: "Break time", format: "duration", align: "right" },
        { id: "longest", label: "Longest", format: "duration", align: "right" },
      );
      return columns;
    }

    default:
      return [];
  }
}
