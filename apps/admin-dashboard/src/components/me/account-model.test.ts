import { describe, expect, it } from "vitest";

import type { AccountProfile } from "@/lib/queries/account";

import { longDate, longDateTime, monitoringLine, resolveManager, roleSummary } from "./account-model";

function profile(overrides: Partial<AccountProfile> = {}): AccountProfile {
  return {
    id: "a0000000-0000-4000-8000-000000000003",
    company_id: "c1",
    email: "employee@aems.local",
    full_name: "Evan Ross",
    role: "employee",
    department: "Engineering",
    manager_id: null,
    monitoring_enabled: true,
    created_at: "2026-08-05T06:08:10.000Z",
    ...overrides,
  };
}

describe("resolveManager", () => {
  it("says nobody is assigned when manager_id is null", () => {
    expect(resolveManager(profile())).toEqual({ state: "none" });
  });

  /**
   * The state the product is in today: `GET /api/employees/:profileId` sends
   * `manager_id` and no join, and RLS lets an employee read exactly one profile row —
   * their own. The id is real and the name is not reachable, so the page says so rather
   * than printing a UUID or an unexplained dash.
   */
  it("says assigned when the id is set but the name did not come with it", () => {
    expect(resolveManager(profile({ manager_id: "a0000000-0000-4000-8000-000000000002" }))).toEqual({
      state: "assigned",
    });
  });

  it("names the manager when the API embeds one", () => {
    const line = resolveManager(
      profile({
        manager_id: "m1",
        manager: { id: "m1", full_name: "Maya Chen", email: "manager@aems.local" },
      }),
    );

    expect(line).toEqual({ state: "named", name: "Maya Chen", email: "manager@aems.local" });
  });

  /** PostgREST emits a to-one embed as an object or a one-element array depending on the query. */
  it("accepts the array shape PostgREST also emits", () => {
    const line = resolveManager(
      profile({
        manager_id: "m1",
        manager: [{ id: "m1", full_name: "Maya Chen", email: "manager@aems.local" }],
      }),
    );

    expect(line).toMatchObject({ state: "named", name: "Maya Chen" });
  });

  it("falls back to the email's local part rather than rendering a blank name", () => {
    const line = resolveManager(
      profile({ manager_id: "m1", manager: { id: "m1", full_name: "  ", email: "manager@aems.local" } }),
    );

    expect(line).toMatchObject({ state: "named", name: "manager" });
  });

  it("survives the profile not having loaded yet", () => {
    expect(resolveManager(undefined)).toEqual({ state: "none" });
  });
});

describe("monitoringLine", () => {
  it("describes collection as conditional on consent, not automatic", () => {
    const line = monitoringLine(true);
    expect(line.label).toBe("Active");
    expect(line.detail).toContain("consent");
  });

  /**
   * `monitoring_enabled` is an admin control — migration ...0005 exists precisely to
   * stop a person switching it off for themselves — so the paused copy must not imply
   * the reader did it or can undo it.
   */
  it("attributes a pause to the administrator", () => {
    const line = monitoringLine(false);
    expect(line.label).toBe("Paused");
    expect(line.detail).toContain("administrator");
  });
});

describe("roleSummary", () => {
  it("tells an employee about the two rights that are theirs", () => {
    const summary = roleSummary("employee");
    expect(summary).toContain("read everything recorded about you");
    expect(summary).toContain("withdraw your consent");
  });

  it("tells a manager what they cannot do, not only what they can", () => {
    expect(roleSummary("manager")).toContain("Super Admin");
  });

  it("covers super admins too", () => {
    expect(roleSummary("super_admin")).toContain("policy");
  });
});

describe("date rendering", () => {
  it("renders a date and a datetime without throwing on bad input", () => {
    expect(longDate("2026-08-05T06:08:10.000Z")).not.toBe("—");
    expect(longDate(null)).toBe("—");
    expect(longDate("nonsense")).toBe("—");
    expect(longDateTime(undefined)).toBe("—");
    expect(longDateTime("2026-08-05T06:08:10.000Z")).not.toBe("—");
  });
});
