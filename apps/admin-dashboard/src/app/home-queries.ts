/**
 * The two reads the dashboard home can answer before it renders.
 *
 * Declared as `ApiQuerySpec`s so `page.tsx` can warm them on the server and the view
 * can read them back out of the cache on its first render — the pattern documented at
 * the top of `lib/server-query.tsx`.
 *
 * Everything else on `/` is keyed on the *browser's* clock. "Today", and "the last
 * seven days", are windows anchored to the reader's own midnight and their own
 * instant, and the server render has neither; warming them would put an answer under
 * a key the browser never asks for. Those panels keep their skeleton, and it is an
 * honest one — see rule 2 in `lib/server-query.tsx`.
 *
 * `liveWorkforceQuery` restates the key `lib/api.ts`'s `useLiveWorkforce()` already
 * uses, because `components/live-workforce.tsx` reads that hook and belongs to another
 * surface. Same key, same path, same shape, so the hydrated entry is found; folding
 * the hook into this spec is follow-up work rather than a change made from here.
 */

import { apiQuery } from "@/lib/query-spec";
import type { LiveWorkforceRow, OverviewMetrics } from "@/lib/api";

/** Scope §4.1's headline row: employees, active now, working today, hours tracked. */
export const overviewQuery = apiQuery<OverviewMetrics>({
  queryKey: ["analytics", "overview"],
  path: "/api/analytics/overview",
});

/**
 * Scope §4.3's live board.
 *
 * No `staleTime`: the hook that reads it polls every twenty seconds, and presence is
 * the one figure on this page whose staleness a reader can actually see. The prefetch
 * exists to remove the *first* empty frame, not to hold the answer still.
 */
export const liveWorkforceQuery = apiQuery<LiveWorkforceRow[]>({
  queryKey: ["analytics", "live"],
  path: "/api/analytics/live",
});
