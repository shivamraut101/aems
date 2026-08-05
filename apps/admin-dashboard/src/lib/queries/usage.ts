"use client";

/**
 * Data and view models for the Apps, Websites, Reports and Devices tabs of an
 * employee page.
 *
 * The two usage tabs read the *report* endpoint rather than a bespoke aggregate.
 * That is deliberate: `/api/reports/run` is the only place in the product where
 * per-app and per-domain time is merged per person before it is summed, so the
 * screen, the CSV and the PDF quote the same number. A second aggregation path
 * for the dashboard is exactly how the worker and the dashboard came to disagree
 * about the same day.
 */

import {
  effectiveFormat,
  findReportType,
  formatCell,
  type CellValue,
  type ColumnFormat,
  type Grouping,
  type ReportDocument,
  type ReportKind,
  type ReportRow,
  type ReportSection,
} from "@aems/analytics";
import type { ReportRecord, ReportRunParams } from "@aems/types";
import { useMutation, useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";

export type { CellValue, ReportDocument, ReportRow, ReportSection };

/* ------------------------------------------------------------------------- */
/* The window a tab reports on                                                */
/* ------------------------------------------------------------------------- */

/**
 * The pair of instants a usage query covers.
 *
 * Deliberately *not* resolved here. `components/employee/use-day-window` owns which
 * day the employee page is showing, and it is shared by all seven tabs — a second
 * resolver in this file is how two tabs end up disagreeing about the same day while
 * both claiming to show it. Empty strings mean "not resolved yet"; the hooks below
 * stay disabled until they are not.
 */
export interface ReportWindow {
  from: string;
  to: string;
}

function instantOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A short, human reading of the window, for the line under a tab heading. */
export function rangeLabel(from: string, to: string, now: Date = new Date()): string {
  const start = instantOf(from);
  const end = instantOf(to);
  if (start === null || end === null) return "";

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  if (start === dayStart.getTime() && end <= now.getTime() + 1000) return "Today";

  // The end of a range is exclusive, so a window ending at midnight belongs to the
  // day before it — otherwise "1 Aug 00:00 → 2 Aug 00:00" reads as two days.
  const lastInstant = new Date(end - 1);
  const sameDay = new Date(start).toDateString() === lastInstant.toDateString();

  return sameDay ? shortDate(start) : `${shortDate(start)} – ${shortDate(end - 1)}`;
}

function shortDate(instant: number): string {
  return new Date(instant).toLocaleDateString([], { month: "short", day: "numeric" });
}

/* ------------------------------------------------------------------------- */
/* Report document → a dense table                                            */
/* ------------------------------------------------------------------------- */

/** The single section a usage report carries, or null when there is nothing yet. */
export function sectionOf(document: ReportDocument | undefined | null): ReportSection | null {
  return document?.sections[0] ?? null;
}

/** A column, resolved for rendering: format already reflects the decimal flag. */
export interface UsageColumn {
  id: string;
  label: string;
  format: ColumnFormat;
  align: "left" | "right";
  /** Sort by value rather than by the rendered string. "1h 15m" sorts before "45m". */
  numeric: boolean;
}

/**
 * Every quantity sorts numerically.
 *
 * The rendered text is the wrong sort key for all of these — "1h 15m" precedes
 * "45m" alphabetically, and "9%" precedes "62%". A date is left as text on
 * purpose: these are ISO instants, so lexical order *is* chronological order.
 */
export function numericFormat(format: ColumnFormat): boolean {
  return (
    format === "duration" ||
    format === "decimalHours" ||
    format === "percent" ||
    format === "count" ||
    format === "seconds"
  );
}

export function tableColumns(document: ReportDocument | undefined | null): UsageColumn[] {
  const section = sectionOf(document);
  if (!section || !document) return [];

  return section.columns.map((column) => {
    const format = effectiveFormat(column.format, document.decimalDuration);
    return {
      id: column.id,
      label: column.label,
      format,
      align: column.align,
      numeric: numericFormat(format),
    };
  });
}

/**
 * Reads one cell.
 *
 * `noUncheckedIndexedAccess` makes the lookup `CellValue | undefined`, and the
 * difference matters: the renderers treat null as "nothing to print" and would
 * otherwise print the string "undefined" into a monitoring record.
 */
export function cellOf(row: ReportRow | undefined | null, columnId: string): CellValue {
  return row?.cells[columnId] ?? null;
}

/** The text for a cell — the same call the CSV renderer makes, so both agree. */
export function renderCell(row: ReportRow | undefined | null, column: UsageColumn): string {
  return formatCell(cellOf(row, column.id), column.format);
}

/**
 * Column comparator for the usage tables.
 *
 * Sorting the rendered text is the trap: "1h 15m" precedes "45m" alphabetically and
 * "9%" precedes "62%", so a duration column sorted as text is not sorted at all.
 * Text compares case-insensitively so "Chrome" and "chrome.exe" sit together rather
 * than in two blocks either side of the uppercase names.
 */
export function compareCells(a: CellValue, b: CellValue, numeric: boolean): number {
  if (numeric) return Number(a ?? 0) - Number(b ?? 0);
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { sensitivity: "base" });
}

/** Bar width for a 0..1 share. Clamped, because a bar wider than its track is a bug. */
export function sharePercent(value: unknown): number {
  const share = Number(value);
  if (!Number.isFinite(share)) return 0;
  return Math.round(Math.min(1, Math.max(0, share)) * 100);
}

/* ------------------------------------------------------------------------- */
/* Website coverage                                                           */
/* ------------------------------------------------------------------------- */

export type DevicePlatform = "windows" | "macos" | "android";

export type CoverageLevel = "browser-url" | "window-title" | "mixed" | "unknown";

export interface WebsiteCoverage {
  level: CoverageLevel;
  /** What this person's devices can actually see. Always stated, never implied. */
  note: string;
}

/**
 * How much of scope §2.5 this person's fleet can answer.
 *
 * The agent reads a real address over AppleScript on macOS and has no supported
 * way to do so on Windows, where it falls back to the window title and refuses to
 * guess from it. So a Windows day legitimately shows a handful of domains and a
 * macOS day shows all of them. Saying that on the screen is the difference between
 * a thin report and a report that looks broken — and it is the honest framing,
 * because the missing rows are a platform limit, not idle time.
 */
export function websiteCoverage(platforms: readonly DevicePlatform[]): WebsiteCoverage {
  const mac = platforms.includes("macos");
  const windows = platforms.includes("windows");

  if (mac && windows) {
    return {
      level: "mixed",
      note:
        "This person works on both macOS and Windows. Addresses are read from the browser on macOS; " +
        "on Windows only a domain the window title spells out is recorded, so Windows days list fewer sites.",
    };
  }

  if (windows) {
    return {
      level: "window-title",
      note:
        "On Windows the agent reads the domain from the browser window title and never guesses one, " +
        "so only pages whose title spells out an address appear here. This list is incomplete by design.",
    };
  }

  if (mac) {
    return {
      level: "browser-url",
      note: "On macOS the agent reads the address directly from the browser, so this list is complete.",
    };
  }

  return {
    level: "unknown",
    note:
      "No desktop device is reporting for this person. Website usage comes from the Windows and macOS " +
      "agents only — the Android agent tracks application usage, not browser addresses.",
  };
}

/* ------------------------------------------------------------------------- */
/* This person's reports                                                      */
/* ------------------------------------------------------------------------- */

/**
 * `GET /api/reports`, straight from the table — snake_case on purpose.
 *
 * Both are aliases of the single declaration in `@aems/types`: the Reports page reads
 * this same endpoint under this same query key, and two hand-maintained copies of one
 * row behind one cache entry is a drift waiting to happen.
 */
export type ReportParams = ReportRunParams;
export type PersonReportRow = ReportRecord;

/**
 * The runs that are about this person.
 *
 * A run is theirs either because it was queued against their profile or because
 * they were named in its filters. A whole-company run is deliberately excluded:
 * it contains their row, but it is not their report, and listing it here would put
 * every colleague's numbers one download away from a page about one person.
 *
 * Order is left alone — the API already returns newest first.
 */
export function personReports(rows: PersonReportRow[], profileId: string): PersonReportRow[] {
  return rows.filter((row) => {
    if (row.profile_id === profileId) return true;

    const params = row.params;
    if (typeof params !== "object" || params === null) return false;

    const ids = params.profileIds;
    return Array.isArray(ids) && ids.includes(profileId);
  });
}

/** Reuses the presence palette: emerald for done, muted for waiting, red for failed. */
export function reportBadgeVariant(
  status: PersonReportRow["status"],
): "online" | "offline" | "revoked" {
  switch (status) {
    case "ready":
      return "online";
    case "failed":
      return "revoked";
    case "pending":
    default:
      return "offline";
  }
}

/**
 * The label the catalogue uses.
 *
 * Falls back to the stored string rather than to "Unknown": rows queued before the
 * report registry existed carry kinds like "daily", and a history that renders them
 * as unknown is less useful than one that just prints what was asked for.
 */
export function reportKindLabel(kind: string): string {
  return findReportType(kind)?.label ?? kind;
}

/* ------------------------------------------------------------------------- */
/* This person's hardware                                                     */
/* ------------------------------------------------------------------------- */

interface DeviceLike {
  profile_id: string;
  status: "active" | "offline" | "revoked";
  last_seen_at: string | null;
}

const STATUS_RANK: Record<DeviceLike["status"], number> = { active: 0, offline: 1, revoked: 2 };

/**
 * This person's machines, most relevant first.
 *
 * Status leads the sort rather than the heartbeat: a revoked laptop that reported
 * ten seconds before it was revoked is not the device a manager is looking for.
 */
export function devicesForProfile<T extends DeviceLike>(rows: readonly T[], profileId: string): T[] {
  return rows
    .filter((row) => row.profile_id === profileId)
    .sort((a, b) => {
      const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (byStatus !== 0) return byStatus;
      return lastSeen(b) - lastSeen(a);
    });
}

function lastSeen(device: DeviceLike): number {
  const parsed = device.last_seen_at ? Date.parse(device.last_seen_at) : NaN;
  // Never-seen sorts last rather than first, which is what `NaN` would do here.
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** Memory and storage in the unit a spec sheet uses. A dash, never "0 GB". */
export function gigabytes(mb: number | null | undefined): string {
  if (!mb || !Number.isFinite(mb) || mb <= 0) return "—";
  return `${Math.round(mb / 1024)} GB`;
}

const PLATFORM_LABEL: Record<DevicePlatform, string> = {
  windows: "Windows",
  macos: "macOS",
  android: "Android",
};

export function platformLabel(platform: DevicePlatform): string {
  return PLATFORM_LABEL[platform];
}

export function osLabel(platform: DevicePlatform, osVersion: string | null | undefined): string {
  const version = (osVersion ?? "").trim();
  return version ? `${PLATFORM_LABEL[platform]} ${version}` : PLATFORM_LABEL[platform];
}

/* ------------------------------------------------------------------------- */
/* Hooks                                                                      */
/* ------------------------------------------------------------------------- */

interface ReportSpec {
  kind: ReportKind;
  grouping: Grouping;
  scope: "self" | "profiles";
  profileIds: string[];
  periodStart: string;
  periodEnd: string;
}

/**
 * Runs one usage report for one person, synchronously.
 *
 * `retry: false` because both realistic failures are settled facts — an employee
 * asking about someone else is a 403 that a second attempt cannot change, and a
 * malformed period is a 400 about the request itself.
 */
function useUsageReport(kind: ReportKind, grouping: Grouping, profileId: string, range: ReportWindow) {
  return useQuery({
    queryKey: ["usage", kind, grouping, profileId, range.from, range.to],
    queryFn: () => {
      const spec: ReportSpec = {
        kind,
        grouping,
        scope: "profiles",
        profileIds: [profileId],
        periodStart: range.from,
        periodEnd: range.to,
      };

      return apiFetch<ReportDocument>("/api/reports/run", {
        method: "POST",
        body: JSON.stringify(spec),
      });
    },
    // The window is empty until `useDayWindow` resolves after mount. Firing then
    // would ask the API about an empty range and be refused for a 400.
    enabled: Boolean(profileId && range.from && range.to),
    staleTime: 60_000,
    retry: false,
  });
}

/** Scope §2.4 — time in each application, with its category and its share. */
export function useAppUsage(profileId: string, range: ReportWindow) {
  return useUsageReport("app_usage", "application", profileId, range);
}

/** Scope §2.5 — time and visit count per domain. */
export function useWebsiteUsage(profileId: string, range: ReportWindow) {
  return useUsageReport("website_usage", "domain", profileId, range);
}

/**
 * Report runs, narrowed to this person.
 *
 * Shares the `["reportHistory"]` cache entry with the /reports screen — one fetch,
 * two readers — and narrows in `select`, which runs against the cached rows rather
 * than sending a second request.
 */
export function usePersonReports(profileId: string) {
  return useQuery({
    queryKey: ["reportHistory"],
    queryFn: () => apiFetch<PersonReportRow[]>("/api/reports"),
    select: (rows) => personReports(rows, profileId),
    enabled: Boolean(profileId),
    retry: false,
  });
}

/**
 * Trades a finished report for a five-minute signed URL.
 *
 * A mutation rather than a query: the link expires, so fetching it on render would
 * hand out URLs that are already dying by the time anyone clicks one.
 */
export function useReportDownload() {
  return useMutation({
    mutationFn: (reportId: number) =>
      apiFetch<{ url: string }>(`/api/reports/${reportId}/download`),
  });
}
