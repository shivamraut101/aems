import type { EmployeeRow, LiveWorkforceRow } from "@/lib/api";
import { apiQuery } from "@/lib/query-spec";

/**
 * The two company-wide reads the Activity screen — and the AI Insights screen — open
 * with, declared once so a server prefetch and a client hook cannot drift apart.
 *
 * Both keys are deliberately the ones `useEmployees()` and `useLiveWorkforce()` in
 * `lib/api.ts` already use, and both paths are the ones those hooks already call. That
 * is not a coincidence to be tidied away later: the employee header, the live workforce
 * strip and the devices page all read the same two entries, and a spec that invented a
 * new key would fetch the same rows a second time and leave the two copies to disagree
 * about who is online.
 *
 * No `"use client"` here — `page.tsx` is a server component and imports this. The two
 * imports from `lib/api` are `import type` and are erased before either bundle is built.
 *
 * Not declared here, on purpose: the day timeline. Its query key contains a window
 * derived from the *reader's* midnight and the reader's clock, and the server knows
 * neither their timezone nor which 10-minute slot their browser will round to. Warming
 * it would put an entry in the cache under a key the browser never asks for — paying
 * for the round trip twice and still flashing. See rule 2 in `lib/server-query.tsx`.
 */

/** Everyone in the company, with their enrolled devices. */
export const employeesQuery = apiQuery<EmployeeRow[]>({
  queryKey: ["employees"],
  path: "/api/employees",
});

/** One presence row per person. Refreshed on an interval by whoever reads it. */
export const liveWorkforceQuery = apiQuery<LiveWorkforceRow[]>({
  queryKey: ["analytics", "live"],
  path: "/api/analytics/live",
});

/** How often the live strip re-asks. Shared so two readers cannot pick different rates. */
export const LIVE_REFETCH_MS = 20_000;
