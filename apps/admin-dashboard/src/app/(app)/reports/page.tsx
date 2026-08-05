import { PrefetchBoundary } from "@/lib/server-query";

import { readKindParam, reportHistoryQuery, reportTypesQuery } from "./queries";
import { ReportsView } from "./reports-view";
import { serverDateKey } from "./today";

/**
 * Reports — the server half. No `"use client"`, no markup of its own.
 *
 * Both reads this screen opens with are answered here, in parallel, before a byte of
 * HTML is written: the catalogue of report types and the export history. The browser
 * receives a page whose type selector is already populated and whose Exports table is
 * already filled, instead of two skeletons that swap a moment later.
 *
 * `searchParams` is read on the server for the same reason: `?kind=` decides which
 * report the form opens on, and resolving it during hydration would render the wrong
 * type for one frame and correct it in front of the reader.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  return (
    <PrefetchBoundary queries={[reportTypesQuery, reportHistoryQuery]}>
      <ReportsView initialKind={readKindParam(params["kind"])} serverToday={serverDateKey()} />
    </PrefetchBoundary>
  );
}
