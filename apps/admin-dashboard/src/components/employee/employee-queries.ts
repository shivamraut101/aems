/**
 * The reads the employee page can answer **before** it renders.
 *
 * Every spec here is declared once and consumed twice — by the route's `page.tsx` /
 * `layout.tsx` through `<PrefetchBoundary queries={[…]}>`, and by the client component
 * through `useApiQuery(…)`. See the rule at the top of `lib/server-query.tsx`; the
 * whole mechanism is that the key and the path live in one object, so they cannot
 * drift into a hydrated entry nobody reads.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  What is deliberately NOT here
 * ───────────────────────────────────────────────────────────────────────────
 *
 * The day-scoped reads — the timeline, the app and website usage tables, the
 * screenshot blocks. All four are keyed on `from`/`to` instants derived from the
 * *viewer's* local midnight (`components/employee/day-window.ts`), and the server
 * renders in another timezone. Prefetching them would warm a key the browser never
 * asks for and pay for the window twice, which is rule 2 in `lib/server-query.tsx`.
 * Their loading state stays, and it is honest: the question genuinely does not exist
 * until the browser's clock is readable.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  Why these live under `components/employee/` and not in `lib/queries/`
 * ───────────────────────────────────────────────────────────────────────────
 *
 * `lib/queries/employee.ts`, `lib/queries/usage.ts` and `lib/api.ts` already declare
 * hooks against these same four cache keys, and those files are shared with screens
 * outside this page. The specs below therefore restate three keys that also exist
 * there — `["employee", id]`, `["employees"]`, `["devices"]`, `["reportHistory"]`.
 * Every component on *this* page reads the spec, so the duplication is one-directional
 * and the hydrated entry is guaranteed to be found; but it is duplication, and folding
 * the legacy hooks into these specs is filed as follow-up work rather than done here,
 * because those files belong to other surfaces too.
 */

import type { DeviceRow, EmployeeRow } from "@/lib/api";
import type { EmployeeDetail } from "@/lib/queries/employee";
import type { PersonReportRow } from "@/lib/queries/usage";
import { apiQuery, type ApiQuerySpec } from "@/lib/query-spec";

/** Names, roles and departments do not change while somebody reads a page. */
const IDENTITY_STALE_MS = 5 * 60_000;

/**
 * Identity and devices for one person — the page's header, and the record every tab
 * hangs off.
 *
 * A function rather than a constant because the key carries the id. The returned
 * object is a fresh literal each call, which is fine: `useApiQuery` reads its fields,
 * it does not use it as a dependency.
 */
export function employeeQuery(profileId: string): ApiQuerySpec<EmployeeDetail> {
  return apiQuery<EmployeeDetail>({
    queryKey: ["employee", profileId],
    path: `/api/employees/${encodeURIComponent(profileId)}`,
    staleTime: IDENTITY_STALE_MS,
  });
}

/**
 * The company roster.
 *
 * Read on this page only to resolve `manager_id` into a name and to fill the manager
 * picker in the edit dialog. A manager or super admin is answered; the prefetch of an
 * employee's own `/me` view is refused and simply caches nothing, which is the
 * documented behaviour of a failed prefetch.
 */
export const rosterQuery = apiQuery<EmployeeRow[]>({
  queryKey: ["employees"],
  path: "/api/employees",
  staleTime: IDENTITY_STALE_MS,
});

/** Every enrolled device in the company; the Devices tab filters to this person. */
export const devicesQuery = apiQuery<DeviceRow[]>({
  queryKey: ["devices"],
  path: "/api/devices",
});

/**
 * Report history, unfiltered.
 *
 * The cache holds the company's rows and each screen narrows them with `select`, so
 * the key carries no profile id — narrowing in the key would mean one fetch per person
 * for a list that is the same list every time.
 */
export const reportHistoryQuery = apiQuery<PersonReportRow[]>({
  queryKey: ["reportHistory"],
  path: "/api/reports",
});
