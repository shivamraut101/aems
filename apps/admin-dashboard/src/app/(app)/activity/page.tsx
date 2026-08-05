import { PrefetchBoundary } from "@/lib/server-query";

import { ActivityView } from "./activity-view";
import { employeesQuery, liveWorkforceQuery } from "./queries";

/**
 * Activity — the server half. No `"use client"`, no markup of its own.
 *
 * The roster is the whole left column and it is what a manager reads first, so both of
 * the requests it is built from are answered here, in parallel, before any HTML is
 * written. The names, the departments, the device labels and the presence dots are all
 * in the first paint; nothing about the master pane arrives a frame later.
 *
 * The detail pane is *not* prefetched, and that is a decision rather than an omission —
 * see the note in `queries.ts`. Its cache key is built from the reader's own midnight
 * and their browser's clock, neither of which this render knows. It keeps an honest
 * loading state, which is the truth: until someone is selected there is no day to fetch.
 */
export default function ActivityPage() {
  return (
    <PrefetchBoundary queries={[employeesQuery, liveWorkforceQuery]}>
      <ActivityView />
    </PrefetchBoundary>
  );
}
