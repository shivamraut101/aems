import { REPORT_KINDS, type ReportKind } from "@aems/analytics";
import type { ReportRecord } from "@aems/types";

import type { ReportTypeDto } from "@/lib/queries/reports";
import { apiQuery } from "@/lib/query-spec";

/**
 * The two reads this screen can answer before it is drawn.
 *
 * Declared as {@link apiQuery} specs rather than hooks so `page.tsx` can warm them on
 * the server and `reports-view.tsx` can read them from the cache — one declaration,
 * two runtimes. See the header of `lib/server-query.tsx` for why that indirection
 * exists at all: a hand-written second copy of the key agrees on the day it is written
 * and drifts silently the day either side gains a parameter, and the only symptom is
 * the skeleton coming back.
 *
 * Deliberately NOT declared here: the report document itself. `POST /api/reports/run`
 * is fired by a person pressing Run, and a spec is a *read* that may be prefetched —
 * warming it during a render would run a report nobody asked for on every page load.
 *
 * This module is imported by a server component, so it must not carry `"use client"`
 * and must not import anything that does. The one import from `lib/queries/reports`
 * is `import type` and is erased before either bundle sees it.
 */

/**
 * The catalogue, cached in the API's own envelope.
 *
 * `{ types: [...] }` is kept rather than unwrapped on purpose. `useReportTypes()` in
 * `lib/queries/reports.ts` still exists, still uses this exact key, and unwraps with
 * `select`; caching the bare array under the same key would hand that hook an array to
 * read `.types` off and it would quietly render nothing. The unwrap happens in the view.
 */
export const reportTypesQuery = apiQuery<{ types: ReportTypeDto[] }>({
  queryKey: ["reportTypes"],
  path: "/api/reports/types",
  // Derived from the caller's role; it changes on release, not during a session.
  staleTime: 10 * 60_000,
});

/** Queued and finished exports. Same key as `useReportHistory()`, same shape. */
export const reportHistoryQuery = apiQuery<ReportRecord[]>({
  queryKey: ["reportHistory"],
  path: "/api/reports",
});

/**
 * The report type named by `?kind=`, or null for anything else.
 *
 * Null rather than a default, because the caller has a better default than this
 * function does: the first entry of the catalogue the API returned for *this* role.
 * Guessing `time_and_activity` here would put a type in the URL that a role might not
 * be offered.
 */
export function readKindParam(raw: string | string[] | undefined): ReportKind | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  return (REPORT_KINDS as readonly string[]).includes(value) ? (value as ReportKind) : null;
}
