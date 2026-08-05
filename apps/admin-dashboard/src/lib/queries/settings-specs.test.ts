import { describe, expect, it } from "vitest";

import {
  RESTRICTION_QUERIES,
  restrictionEventsQuery,
  restrictionPeopleQuery,
  restrictionPolicyQuery,
} from "./restrictions";
import {
  SETTINGS_QUERIES,
  categoryRulesQuery,
  companyPolicyQuery,
  devicesQuery,
  employeesQuery,
} from "./settings-specs";

/**
 * Pins the four reads /settings prefetches.
 *
 * The failure this guards against is silent by construction. If a spec's `queryKey`
 * stops matching the key the hook reading it uses, nothing throws and nothing logs —
 * the server warms an entry nobody asks for, the browser fetches from scratch, and the
 * page flashes a skeleton exactly as it did before anyone bothered to prefetch. The two
 * hooks in `lib/api.ts` that still declare `["employees"]` and `["devices"]` inline are
 * the exposed pair, because they are the two this file cannot import from.
 *
 * These assertions are literal on purpose: changing a key here should require changing
 * a test, so it is a decision rather than an accident.
 */
describe("settings query specs", () => {
  it("declares the policy read the policy panel and the server prefetch share", () => {
    expect(companyPolicyQuery.queryKey).toEqual(["policy", "current"]);
    expect(companyPolicyQuery.path).toBe("/api/policies/current");
  });

  it("declares the category rules read", () => {
    expect(categoryRulesQuery.queryKey).toEqual(["categories", "rules"]);
    expect(categoryRulesQuery.path).toBe("/api/activity/categories");
  });

  it("matches the key and path `useEmployees` declares inline in lib/api.ts", () => {
    expect(employeesQuery.queryKey).toEqual(["employees"]);
    expect(employeesQuery.path).toBe("/api/employees");
  });

  it("matches the key and path `useDevices` declares inline in lib/api.ts", () => {
    expect(devicesQuery.queryKey).toEqual(["devices"]);
    expect(devicesQuery.path).toBe("/api/devices");
  });

  it("prefetches exactly the four reads the page renders, and nothing keyed on the browser", () => {
    expect(SETTINGS_QUERIES).toHaveLength(4);
    expect(SETTINGS_QUERIES.map((spec) => spec.path)).toEqual([
      "/api/policies/current",
      "/api/activity/categories",
      "/api/employees",
      "/api/devices",
    ]);
    // No query string anywhere: a period or a filter would be keyed on a choice the
    // reader has not made, and `server-query.tsx` rule 2 says that cannot be prefetched.
    expect(SETTINGS_QUERIES.every((spec) => !spec.path.includes("?"))).toBe(true);
    // A read, never a write. Prefetching a mutation would fire it during a render.
    expect(SETTINGS_QUERIES.every((spec) => spec.method === undefined)).toBe(true);
  });
});

/**
 * The same guard for `/settings/restrictions`.
 *
 * Its paths are pinned literally against `apps/api/src/routes/restrictions.ts`, which is
 * registered at the `/api/restrictions` prefix. `check-api-routes.mjs` proves the paths
 * are *served*; what it cannot prove is that the key the server warms is the key the hook
 * reads, and that is the failure that comes back as a flash rather than as an error.
 */
describe("restriction query specs", () => {
  it("declares the policy read, whose payload carries settings, rules and rejections", () => {
    expect(restrictionPolicyQuery.queryKey).toEqual(["restrictions", "policy"]);
    expect(restrictionPolicyQuery.path).toBe("/api/restrictions");
  });

  it("pins the refusal window in the path so the key stays constant", () => {
    // A date-range picker would key on the reader's clock, which cannot be prefetched —
    // `server-query.tsx` rule 2. "The last N refusals" needs no clock on either side.
    expect(restrictionEventsQuery.queryKey).toEqual(["restrictions", "events"]);
    expect(restrictionEventsQuery.path).toBe("/api/restrictions/events?limit=100");
  });

  it("shares the roster key with the rest of the app rather than minting its own", () => {
    // TanStack keys are global. Reusing `["employees"]` means warming it here also warms
    // the Company tab; a private key would fetch the same rows twice under two names.
    expect(restrictionPeopleQuery.queryKey).toEqual(employeesQuery.queryKey);
    expect(restrictionPeopleQuery.path).toBe(employeesQuery.path);
  });

  it("warms exactly what the page renders, and every one of them is a read", () => {
    expect(RESTRICTION_QUERIES.map((spec) => spec.path)).toEqual([
      "/api/restrictions",
      "/api/restrictions/events?limit=100",
      "/api/employees",
    ]);
    expect(RESTRICTION_QUERIES.every((spec) => spec.method === undefined)).toBe(true);
  });

  it("shares no key with the company settings page", () => {
    // Two specs under one key with different paths is the drift `query-spec.ts` exists to
    // prevent; whichever landed second would silently change what the other page rendered.
    const settings = SETTINGS_QUERIES.map((spec) => JSON.stringify(spec.queryKey));
    const restrictions = RESTRICTION_QUERIES.filter(
      (spec) => spec.path !== "/api/employees",
    ).map((spec) => JSON.stringify(spec.queryKey));

    expect(restrictions.some((key) => settings.includes(key))).toBe(false);
  });
});
