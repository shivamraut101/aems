import { describe, expect, it } from "vitest";

import { LIVE_REFETCH_MS, employeesQuery, liveWorkforceQuery } from "./queries";

/**
 * The roster specs must land on the *existing* cache entries, not new ones.
 *
 * `useEmployees()` and `useLiveWorkforce()` in `lib/api.ts` are read by the devices
 * page, the people page, the settings monitoring section, the employee header and the
 * live workforce strip. If a spec here invented its own key, the Activity page would
 * fetch the same rows a second time and the two copies would drift — one strip saying a
 * person is active while another says they are offline, with no error anywhere.
 *
 * The expected values are written out literally on purpose; derived expectations pass
 * through the drift they are meant to catch.
 */
describe("roster query specs", () => {
  it("shares the key and path useEmployees() uses", () => {
    expect(employeesQuery.queryKey).toEqual(["employees"]);
    expect(employeesQuery.path).toBe("/api/employees");
  });

  it("shares the key and path useLiveWorkforce() uses", () => {
    expect(liveWorkforceQuery.queryKey).toEqual(["analytics", "live"]);
    expect(liveWorkforceQuery.path).toBe("/api/analytics/live");
  });

  it("keeps presence and the roster in separate entries", () => {
    expect(employeesQuery.queryKey).not.toEqual(liveWorkforceQuery.queryKey);
  });

  it("describes reads only — a prefetched mutation would fire on every page load", () => {
    expect(employeesQuery.method).toBeUndefined();
    expect(liveWorkforceQuery.method).toBeUndefined();
  });

  it("leaves presence on the provider's short staleness rather than pinning its own", () => {
    // Presence is the one figure on the screen whose staleness a reader can see. A
    // `staleTime` here would silence the interval refetch for that long.
    expect(liveWorkforceQuery.staleTime).toBeUndefined();
    expect(LIVE_REFETCH_MS).toBe(20_000);
  });
});
