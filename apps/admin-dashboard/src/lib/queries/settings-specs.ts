/**
 * The reads /settings performs, declared once as data.
 *
 * Deliberately framework-free: no React, no `"use client"`. `app/(app)/settings/page.tsx`
 * is a **server** component and imports these to warm them, while the hooks in
 * `settings.ts` import the same objects to read them. That shared object is the only
 * thing stopping the key and the path drifting apart — see the header of
 * `lib/query-spec.ts` for why a drift here is silent rather than loud.
 *
 * `employeesQuery` and `devicesQuery` restate the key and path that `useEmployees()`
 * and `useDevices()` in `lib/api.ts` still declare inline. That is the duplication
 * `query-spec.ts` warns about, and it is temporary: `lib/api.ts` is owned by another
 * change in flight, so the specs live here until those two hooks can be moved onto
 * `useApiQuery` and these constants deleted. They agree today, and the keys are
 * asserted in `settings-specs.test.ts` so a future edit to either side fails a test
 * rather than quietly reintroducing the flash.
 */

import type { DeviceRow, EmployeeRow } from "@/lib/api";
import { apiQuery } from "@/lib/query-spec";

import type { CategoryRulesResponse, PolicyRecord } from "./settings-view";

/**
 * The policy version in force.
 *
 * `GET /api/policies/current` is `requireUser` and answers `200 null` for a company
 * that has not published yet, so a successful prefetch can legitimately cache `null` —
 * which `policyState` reads as "missing" and turns into the publish form. A 404 or a
 * 500 throws inside `serverApiQuery`, caches nothing, and leaves the client to fetch
 * and report it properly.
 */
export const companyPolicyQuery = apiQuery<PolicyRecord | null>({
  queryKey: ["policy", "current"],
  path: "/api/policies/current",
  staleTime: 5 * 60_000,
});

/** Classification rules with the engine's refusals attached. Readable by every role. */
export const categoryRulesQuery = apiQuery<CategoryRulesResponse>({
  queryKey: ["categories", "rules"],
  path: "/api/activity/categories",
  staleTime: 60_000,
});

/**
 * The roster the monitoring section lists and the company section counts.
 *
 * No `staleTime`: it must match what `useEmployees()` does today, which is to take the
 * provider default. A spec that disagreed would not break — staleness is per observer —
 * but it would make the two declarations differ in a second way as well as the first.
 */
export const employeesQuery = apiQuery<EmployeeRow[]>({
  queryKey: ["employees"],
  path: "/api/employees",
});

/** Enrolled devices — the company section's count. */
export const devicesQuery = apiQuery<DeviceRow[]>({
  queryKey: ["devices"],
  path: "/api/devices",
});

/** Everything `/settings` itself needs before its first paint. */
export const SETTINGS_QUERIES = [
  companyPolicyQuery,
  categoryRulesQuery,
  employeesQuery,
  devicesQuery,
] as const;
