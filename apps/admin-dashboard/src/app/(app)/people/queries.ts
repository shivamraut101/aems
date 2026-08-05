import type { EmployeeRow } from "@/lib/api";
import { apiQuery } from "@/lib/query-spec";

/**
 * The reads the roster performs, declared once as data.
 *
 * Framework-free on purpose — no React, no `"use client"`. `page.tsx` is a **server**
 * component and imports these to warm them before it writes any HTML, while the view
 * imports the same objects to read them. One object is the only thing that stops the
 * key and the path drifting apart, and a drift here is silent: the hydrated entry sits
 * under a key nobody asks for and the page flashes a skeleton exactly as it did before
 * anyone bothered to prefetch. See the header of `lib/query-spec.ts`.
 *
 * The `EmployeeRow` import is type-only, so nothing from the `"use client"` module it
 * lives in reaches the server bundle.
 *
 * `["employees"]` is not a key invented here. It is the one `useEmployees()` in
 * `lib/api.ts` already uses and the one `invalidatePerson()` in `lib/queries/employees.ts`
 * invalidates after every write, and both must keep agreeing — the roster is shared with
 * Settings, the Add device dialog and the employee header. `lib/queries/settings-specs.ts`
 * declares the same pair for the same reason; the three should collapse into one module
 * once `lib/api.ts`'s inline hooks move onto `useApiQuery`.
 */

/** The roster. Deactivated people are excluded by the API unless asked for. */
export const employeesQuery = apiQuery<EmployeeRow[]>({
  queryKey: ["employees"],
  path: "/api/employees",
});

/**
 * The roster *including* people who have been off-boarded.
 *
 * A separate cache entry rather than a parameter on the first, because it is a
 * different answer to a different question and mixing them would let a page that asked
 * for the short list render the long one out of cache. Deliberately still a prefix
 * match for `["employees"]`, so one invalidation after a write refreshes both.
 */
export const deactivatedEmployeesQuery = apiQuery<EmployeeRow[]>({
  queryKey: ["employees", "withDeactivated"],
  path: "/api/employees?includeDeactivated=true",
});

/**
 * Whichever of the two the `?deactivated=1` flag calls for.
 *
 * The flag lives in the URL, so the server page can read it from `searchParams` and
 * warm the *same* entry the view will read — a prefetch of the wrong variant is worth
 * exactly nothing, and looks identical to no prefetch at all.
 */
export function rosterQuery(includeDeactivated: boolean) {
  return includeDeactivated ? deactivatedEmployeesQuery : employeesQuery;
}
