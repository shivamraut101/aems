import { PrefetchBoundary } from "@/lib/server-query";

import { PeopleView } from "./people-view";
import { rosterQuery } from "./queries";

/**
 * The roster, `docs/scope.md` §4.2 — server half.
 *
 * No `"use client"`, no markup of its own. It resolves the one thing the view cannot
 * resolve for itself in time: the roster, fetched with the reader's own token before a
 * byte of HTML is written, so the first paint contains people rather than six grey bars
 * that become people a moment later. See the rule at the top of `lib/server-query.tsx`.
 *
 * `searchParams` is read here and nowhere else on the server. `?deactivated=1` changes
 * which cache entry the view will ask for, and warming the other one would be worth
 * nothing while looking exactly like a working prefetch.
 */
export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const includeDeactivated = params["deactivated"] === "1";

  return (
    <PrefetchBoundary queries={[rosterQuery(includeDeactivated)]}>
      <PeopleView />
    </PrefetchBoundary>
  );
}
