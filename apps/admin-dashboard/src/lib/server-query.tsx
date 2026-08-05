/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RULE FOR EVERY PAGE IN THIS APP. Read it before you write a route.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A page is TWO files.
 *
 *   `page.tsx`   — a **server** component. No `"use client"`. It fetches, and it
 *                  hands the result down. It renders no markup of its own beyond
 *                  the boundary.
 *   `<name>-view.tsx` — the `"use client"` component that was previously the page.
 *                  Same JSX, same hooks, unchanged except for its name.
 *
 * The server file looks exactly like this, every time:
 *
 * ```tsx
 * // src/app/(app)/devices/page.tsx        ← server. NO "use client".
 * import { PrefetchBoundary } from "@/lib/server-query";
 * import { devicesQuery } from "@/lib/queries/devices";
 * import { DevicesView } from "./devices-view";
 *
 * export default function DevicesPage() {
 *   return (
 *     <PrefetchBoundary queries={[devicesQuery]}>
 *       <DevicesView />
 *     </PrefetchBoundary>
 *   );
 * }
 * ```
 *
 * ```ts
 * // src/lib/queries/devices.ts            ← the ONE declaration of this read.
 * import { apiQuery } from "@/lib/query-spec";
 *
 * export const devicesQuery = apiQuery<DeviceRow[]>({
 *   queryKey: ["devices"],
 *   path: "/api/devices",
 *   staleTime: 30_000,
 * });
 * ```
 *
 * ```tsx
 * // src/app/(app)/devices/devices-view.tsx   ← "use client". The old page body.
 * "use client";
 * import { useApiQuery } from "@/lib/api";
 * import { devicesQuery } from "@/lib/queries/devices";
 *
 * export function DevicesView() {
 *   const devices = useApiQuery(devicesQuery);   // hydrated. Never "loading".
 *   ...
 * }
 * ```
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  Five ways to get this subtly wrong. All five have a symptom, and the
 *  symptom is always the same: the flash comes back and nothing errors.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 1. **Writing the key or the path twice.** If the client hook says
 *    `useQuery({ queryKey: ["devices"], queryFn: … })` while the page prefetches
 *    a spec, the two agree until one of them gains a parameter. Import the SAME
 *    exported `apiQuery(...)` object in both places. That is the entire mechanism;
 *    there is no other guarantee that a hydrated entry is ever read.
 *
 * 2. **Prefetching a query whose key depends on the browser.** Anything keyed on
 *    the reader's clock, their timezone, their locale, `window`, or a value they
 *    have not picked yet CANNOT be prefetched — the server would warm a key the
 *    browser never asks for, and you would pay for the round trip twice. Leave
 *    those out of `queries`; they keep their normal client loading state, and that
 *    state is honest because the question genuinely did not exist until mount.
 *
 * 3. **Prefetching a per-reader query on a shared route.** Everything here runs
 *    with the signed-in user's own token and `cache: "no-store"`. Do not add
 *    `revalidate`, `force-cache`, or a `unstable_cache` wrapper to anything
 *    downstream of it. One employee's day rendered out of another's cached payload
 *    is a data-protection incident, not a bug.
 *
 * 4. **Reaching for `useState`/`useEffect` in `page.tsx`.** It is a server
 *    component now. If you find yourself adding `"use client"` to it, you have put
 *    the view code in the wrong file — move it to `<name>-view.tsx`.
 *
 * 5. **Rendering a skeleton off `isFetching`.** A hydrated query is not loading;
 *    it is fetching in the background at most. Decide with
 *    `queryViewState(query)` from `@/components/states` — never with a hand-rolled
 *    ternary, and never off `isFetching`, which is true during every background
 *    refresh and is what made the Activity timeline flash once a minute.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  What this file guarantees, so you do not have to think about it
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  • A prefetch that fails caches **nothing**. The API being down, or refusing,
 *    leaves the entry absent and the client fetches it the ordinary way and shows
 *    the ordinary error. A server outage never dehydrates as an empty result.
 *  • A page never waits on a query it does not need: the prefetches run in
 *    parallel, and one slow endpoint does not serialise behind another.
 *  • The signed-in person is already in the cache before any page renders — the
 *    root layout seeds it — so `useSession()` is never in a loading state and the
 *    sidebar draws the right navigation on the first paint rather than the second.
 */

import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";

import type { ApiQuerySpec } from "./query-spec";
import { serverApiQuery } from "./supabase-server";

/**
 * A throwaway client, one per request.
 *
 * Never module-level. A shared server client would hold one employee's answers
 * where the next request could read them, which is the multi-tenant version of a
 * cache poisoning bug.
 *
 * `retry: false` because a server render is on the reader's critical path: a failed
 * prefetch costs nothing (the browser fetches it a moment later) while a retried one
 * costs the whole page its time to first byte.
 */
export function createServerQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Mirrors the browser default in `components/providers.tsx`. A spec's own
        // `staleTime` still wins; this only decides how long an entry with no
        // opinion survives hydration before the client refreshes it in background.
        staleTime: 15_000,
      },
    },
  });
}

/**
 * Warms every spec into one request-scoped client and hands it back to be dehydrated.
 *
 * `Promise.all`, not a loop with `await`: two endpoints that each take 200ms should
 * cost the page 200ms, not 400ms.
 */
export async function prefetchApiQueries(
  queries: readonly ApiQuerySpec<unknown>[],
): Promise<QueryClient> {
  const client = createServerQueryClient();

  await Promise.all(
    queries.map((spec) =>
      client.prefetchQuery({
        queryKey: spec.queryKey,
        queryFn: () => serverApiQuery(spec),
        ...(spec.staleTime !== undefined ? { staleTime: spec.staleTime } : {}),
      }),
    ),
  );

  return client;
}

/**
 * The one wrapper every route uses. See the rule at the top of this file.
 *
 * `queries` is typed `ApiQuerySpec<unknown>[]` so a heterogeneous array of specs —
 * `[devicesQuery, employeesQuery]`, with unrelated response types — is accepted
 * without every caller having to widen it by hand. Nothing here reads the payload
 * type; the client hook is where `T` matters.
 */
export async function PrefetchBoundary({
  queries,
  children,
}: {
  /** Specs to warm. Leave out anything keyed on the browser — see rule 2 above. */
  readonly queries: readonly ApiQuerySpec<unknown>[];
  readonly children: React.ReactNode;
}) {
  const client = await prefetchApiQueries(queries);

  return <HydrationBoundary state={dehydrate(client)}>{children}</HydrationBoundary>;
}
