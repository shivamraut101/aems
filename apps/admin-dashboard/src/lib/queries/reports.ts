"use client";

import {
  REPORT_KINDS,
  effectiveFormat,
  formatCell,
  type CellValue,
  type ColumnFormat,
  type Grouping,
  type ReportDocument,
  type ReportFormat,
  type ReportKind,
  type ReportRow,
} from "@aems/analytics";
import type { ReportRecord } from "@aems/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { NetworkError, apiErrorFor, apiFetch, joinUrl } from "@/lib/api";
import { apiBaseUrl, type UserRole } from "@/lib/session";
import { createClient } from "@/lib/supabase";

import { dateKeyOf, shiftDateKey } from "./activity";

/**
 * The reports screen: catalogue, filters, run-to-screen, export-to-file, history.
 *
 * Cattr's split, adopted — the same filters either render now or queue a file, so a
 * manager never waits on a background job to see a number. Everything above the hooks
 * is pure and tested; nothing here re-implements the arithmetic or the formatting,
 * which both come from `@aems/analytics` so the table on screen and the CSV in the
 * download read identically.
 */

/* -------------------------------------------------------------------------- */
/* Wire shapes — mirror the API DTOs exactly, snake_case included               */
/* -------------------------------------------------------------------------- */

export type ReportScope = "self" | "profiles" | "my_team" | "company";

export interface ReportColumnDto {
  id: string;
  label: string;
  format: ColumnFormat;
  align: "left" | "right";
}

export interface ReportTypeDto {
  id: ReportKind;
  label: string;
  description: string;
  groupings: Grouping[];
  defaultGrouping: Grouping;
  minRole: "manager" | "employee";
  columnsByGrouping: Partial<Record<Grouping, ReportColumnDto[]>>;
}

/**
 * A row of `reports`, straight from the table.
 *
 * The shape now lives in `@aems/types` as `ReportRecord`, because the employee
 * Reports tab reads the same endpoint under the same query key and the two
 * hand-maintained copies could drift behind one cache entry. Kept as an alias so
 * this screen's existing references keep reading naturally.
 */
export type ReportHistoryRow = ReportRecord;

/** The request body `POST /api/reports/run`, `/export` and `/` all take. */
export interface ReportSpec {
  kind: ReportKind;
  grouping: Grouping;
  scope: ReportScope;
  periodStart: string;
  periodEnd: string;
  decimalDuration: boolean;
}

/* -------------------------------------------------------------------------- */
/* Scope                                                                       */
/* -------------------------------------------------------------------------- */

export interface ScopeOption {
  value: ReportScope;
  label: string;
}

/**
 * The scopes a role may choose.
 *
 * An employee is pinned to "self" server-side whatever they send, so offering the
 * other three would be offering an action the API has already decided to refuse.
 * "profiles" is deliberately absent until there is a person picker to fill it.
 */
export function scopesForRole(role: UserRole): ScopeOption[] {
  if (role === "employee") return [{ value: "self", label: "Just me" }];

  return [
    { value: "company", label: "Whole company" },
    { value: "my_team", label: "My team" },
    { value: "self", label: "Just me" },
  ];
}

/* -------------------------------------------------------------------------- */
/* The filter form                                                             */
/* -------------------------------------------------------------------------- */

const dayKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "That is not a real date");

/**
 * One schema, validated before the request leaves the browser.
 *
 * The API validates the same things and answers 400 — this exists so the person gets
 * the message beside the field instead of in an error banner after a round trip.
 */
export const reportFormSchema = z
  .object({
    kind: z.enum(REPORT_KINDS),
    grouping: z.string().min(1),
    scope: z.enum(["self", "profiles", "my_team", "company"]),
    fromDate: dayKey,
    toDate: dayKey,
    // Not `.default(false)`: a default makes the schema's input and output types
    // differ, and React Hook Form resolves against the input side.
    decimalDuration: z.boolean(),
  })
  .refine((values) => values.toDate >= values.fromDate, {
    message: "The period must end on or after it starts",
    path: ["toDate"],
  });

export type ReportFormValues = z.infer<typeof reportFormSchema>;

/**
 * Two calendar days become the half-open instant window the API expects.
 *
 * The end is midnight *after* the last day, so picking the same day twice reports
 * that whole day rather than an empty window. Both ends are local midnights: the
 * reader picked days on their own calendar, not UTC's.
 */
export function toReportSpec(values: ReportFormValues): ReportSpec {
  return {
    kind: values.kind,
    grouping: values.grouping as Grouping,
    scope: values.scope,
    periodStart: localMidnight(values.fromDate).toISOString(),
    periodEnd: localMidnight(shiftDateKey(values.toDate, 1)).toISOString(),
    decimalDuration: values.decimalDuration,
  };
}

function localMidnight(key: string): Date {
  const [year, month, day] = key.split("-").map((part) => Number(part));
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0);
}

/**
 * Keeps a grouping the type allows, otherwise the type's own default.
 *
 * The API silently falls back too, so sending an unsupported grouping would render a
 * table whose header disagrees with the control that produced it.
 */
export function resolveGrouping(type: ReportTypeDto, requested: string | undefined): Grouping {
  if (requested && type.groupings.includes(requested as Grouping)) return requested as Grouping;
  return type.defaultGrouping;
}

/** Named from the local calendar day, not the ISO string — those differ east of UTC. */
export function exportFilename(spec: ReportSpec, format: ReportFormat): string {
  return `${spec.kind}-${dateKeyOf(new Date(spec.periodStart))}.${format}`;
}

/* -------------------------------------------------------------------------- */
/* Rendering a ReportDocument                                                  */
/* -------------------------------------------------------------------------- */

export interface ResolvedColumn {
  id: string;
  label: string;
  align: "left" | "right";
  /** `decimalDuration` already applied, so no cell has to ask again. */
  format: ColumnFormat;
}

export function documentColumns(document: ReportDocument): ResolvedColumn[] {
  const section = document.sections[0];
  if (!section) return [];

  return section.columns.map((column) => ({
    id: column.id,
    label: column.label,
    align: column.align,
    format: effectiveFormat(column.format, document.decimalDuration),
  }));
}

export function documentCell(row: ReportRow, column: ResolvedColumn): string {
  const value: CellValue = row.cells[column.id] ?? null;
  return formatCell(value, column.format);
}

/* -------------------------------------------------------------------------- */
/* Run history                                                                 */
/* -------------------------------------------------------------------------- */

export interface HistoryView {
  label: string;
  tone: "online" | "secondary" | "revoked";
  /** The one extra sentence worth showing on the row, or nothing. */
  detail: string | null;
  downloadable: boolean;
}

/**
 * A queued report as a row a person can act on.
 *
 * A failed row carries the API's own reason: "failed" alone tells a manager to open a
 * support ticket, while "No rows in range" tells them to widen the dates.
 */
export function historyView(row: ReportHistoryRow): HistoryView {
  if (row.status === "ready") {
    return {
      label: "Ready",
      tone: "online",
      detail: row.row_count === null ? null : `${row.row_count} rows`,
      downloadable: Boolean(row.storage_path),
    };
  }

  if (row.status === "failed") {
    return { label: "Failed", tone: "revoked", detail: row.failure_reason, downloadable: false };
  }

  return { label: "Pending", tone: "secondary", detail: null, downloadable: false };
}

/* -------------------------------------------------------------------------- */
/* Queries and mutations                                                       */
/* -------------------------------------------------------------------------- */

export function useReportTypes() {
  return useQuery({
    queryKey: ["reportTypes"],
    queryFn: () => apiFetch<{ types: ReportTypeDto[] }>("/api/reports/types"),
    select: (data) => data.types,
    // The catalogue is derived from the caller's role and changes on release, not
    // during a session.
    staleTime: 10 * 60_000,
  });
}

export function useReportHistory() {
  return useQuery({
    queryKey: ["reportHistory"],
    queryFn: () => apiFetch<ReportHistoryRow[]>("/api/reports"),
  });
}

/** Render to screen. `retry` is off: a 403 or a bad period is a settled fact. */
export function useRunReport() {
  return useMutation({
    mutationFn: (spec: ReportSpec) =>
      apiFetch<ReportDocument>("/api/reports/run", {
        method: "POST",
        body: JSON.stringify(spec),
      }),
    retry: false,
  });
}

/** Queue a file. PDF only travels this path — the renderer lives in the worker. */
export function useQueueReport() {
  return useMutation({
    mutationFn: (input: ReportSpec & { format: ReportFormat }) =>
      apiFetch<ReportHistoryRow>("/api/reports", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    retry: false,
  });
}

export function useExportCsv() {
  return useMutation({ mutationFn: (spec: ReportSpec) => downloadCsv(spec), retry: false });
}

/**
 * Fetches the CSV and hands it to the browser.
 *
 * Deliberately not `apiFetch`: that parses JSON, and this response is a file. The
 * error handling is the same shape on purpose — `apiErrorFor` and `NetworkError` so
 * `describeError` renders the failure with the same words as every other call.
 */
export async function downloadCsv(spec: ReportSpec): Promise<{ filename: string }> {
  const {
    data: { session },
  } = await createClient().auth.getSession();

  if (!session) throw apiErrorFor(401, { error: "unauthorized", message: "No local session" });

  let response: Response;
  try {
    response = await fetch(joinUrl(apiBaseUrl(), "/api/reports/export"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...spec, format: "csv" }),
    });
  } catch (cause) {
    throw new NetworkError("The export never reached the API", { cause });
  }

  if (!response.ok) {
    throw apiErrorFor(response.status, await response.json().catch(() => null));
  }

  const filename = exportFilename(spec, "csv");
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = window.document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    // Revoking immediately is safe — the browser has already taken the blob — and
    // not revoking leaks the whole file for the lifetime of the tab.
    URL.revokeObjectURL(url);
  }

  return { filename };
}

/** A five-minute signed link for a finished report. */
export function fetchReportDownloadUrl(id: number): Promise<{ url: string }> {
  return apiFetch<{ url: string }>(`/api/reports/${id}/download`);
}
