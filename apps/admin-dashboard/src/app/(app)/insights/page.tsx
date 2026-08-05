import type { ApiQuerySpec } from "@/lib/query-spec";
import { PrefetchBoundary } from "@/lib/server-query";
import { getServerSession } from "@/lib/supabase-server";

import { employeesQuery } from "../activity/queries";
import { InsightsView } from "./insights-view";
import { insightsQuery, resolveInsightsRequest } from "./queries";

/**
 * AI Insights — the server half. No `"use client"`, no markup of its own.
 *
 * This page can prefetch the thing a reader actually came for, which the Activity page
 * cannot: the summary is identified by `kind` and `profileId`, both of which are in the
 * URL, and neither depends on the browser's clock or timezone. So the indigo panel and
 * the recorded figures beside it are in the first paint rather than replacing a
 * skeleton a moment later.
 *
 * `fallbackKind` is `"insight"` because `/insights` is a manager destination — `NAV` in
 * `lib/session.ts` gives it to managers and super admins — and the company reading is
 * the first option those roles are offered. An employee who reaches the URL anyway
 * meets the shell's access wall, and the prefetch is skipped for them rather than being
 * spent on a request the API would refuse.
 */
export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await getServerSession();

  // `role !== "employee"` is the only fact needed here and it is a *skip*, not a gate:
  // the boundary is the API, which refuses a company insight to an employee whatever
  // this render decides. Getting it wrong costs a wasted prefetch, never a disclosure.
  const readsOthers = session !== null && session.role !== "employee";

  const request = resolveInsightsRequest({
    kindParam: params["kind"],
    profileIdParam: params["profileId"],
    fallbackKind: "insight",
    ownProfileId: null,
  });

  const queries: ApiQuerySpec<unknown>[] = readsOthers
    ? [employeesQuery, ...(request.askable ? [insightsQuery(request.kind, request.profileId)] : [])]
    : [];

  return (
    <PrefetchBoundary queries={queries}>
      <InsightsView />
    </PrefetchBoundary>
  );
}
