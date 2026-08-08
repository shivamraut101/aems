import { describe, expect, it } from "vitest";

import {
  ROLE_RANK,
  canViewOthers,
  canViewProfile,
  canViewRole,
  visibleRoleFilter,
} from "./roles.js";

const SELF = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const viewer = (role: "employee" | "manager" | "super_admin") => ({
  profileId: SELF,
  companyId: "c",
  email: "v@x",
  role,
});

describe("canViewRole", () => {
  it("lets a super admin see every rank", () => {
    expect(canViewRole("super_admin", "super_admin")).toBe(true);
    expect(canViewRole("super_admin", "manager")).toBe(true);
    expect(canViewRole("super_admin", "employee")).toBe(true);
  });

  /**
   * The defect this whole rule exists for. A manager opening the owner's profile got
   * their screenshots, timeline, devices and location trail, because the old check
   * asked only whether the *reader* was privileged and never who they were reading.
   */
  it("refuses a manager the super admin", () => {
    expect(canViewRole("manager", "super_admin")).toBe(false);
  });

  it("refuses a manager a peer manager", () => {
    expect(canViewRole("manager", "manager")).toBe(false);
  });

  it("lets a manager see an employee", () => {
    expect(canViewRole("manager", "employee")).toBe(true);
  });

  it("refuses an employee everyone, including another employee", () => {
    expect(canViewRole("employee", "employee")).toBe(false);
    expect(canViewRole("employee", "manager")).toBe(false);
    expect(canViewRole("employee", "super_admin")).toBe(false);
  });
});

describe("canViewProfile", () => {
  /**
   * Non-negotiable #3. The rank comparison is strict, so without the self short-circuit
   * a manager could not open their own account page and an employee could not read a
   * byte of their own data.
   */
  it("always allows self, at every rank", () => {
    expect(canViewProfile(viewer("employee"), SELF, "employee")).toBe(true);
    expect(canViewProfile(viewer("manager"), SELF, "manager")).toBe(true);
    expect(canViewProfile(viewer("super_admin"), SELF, "super_admin")).toBe(true);
  });

  it("refuses a manager another manager's profile", () => {
    expect(canViewProfile(viewer("manager"), OTHER, "manager")).toBe(false);
  });

  it("allows a manager an employee's profile", () => {
    expect(canViewProfile(viewer("manager"), OTHER, "employee")).toBe(true);
  });
});

describe("visibleRoleFilter", () => {
  it("returns null for a super admin, so their query carries no filter at all", () => {
    expect(visibleRoleFilter("super_admin")).toBeNull();
  });

  it("narrows a manager to employees", () => {
    expect(visibleRoleFilter("manager")).toEqual(["employee"]);
  });

  it("gives an employee nothing — every list they see is their own row", () => {
    expect(visibleRoleFilter("employee")).toEqual([]);
  });

  /**
   * Fails closed. A role added to `ROLE_RANK` above manager and forgotten everywhere
   * else must be *hidden* from a manager, never shown: the filter is built from what a
   * viewer may see rather than from what they may not.
   */
  it("never lets a filter include a rank at or above the viewer's", () => {
    for (const role of Object.keys(ROLE_RANK) as (keyof typeof ROLE_RANK)[]) {
      for (const allowed of visibleRoleFilter(role) ?? []) {
        expect(ROLE_RANK[allowed]).toBeLessThan(ROLE_RANK[role]);
      }
    }
  });
});

describe("canViewOthers", () => {
  /**
   * Left deliberately rank-blind: it answers "may this person see colleagues at all",
   * which is still the right gate for rendering a roster link. Pinned so nobody
   * "fixes" it back into the per-target check and reintroduces the split.
   */
  it("stays true for both privileged roles", () => {
    expect(canViewOthers("manager")).toBe(true);
    expect(canViewOthers("super_admin")).toBe(true);
    expect(canViewOthers("employee")).toBe(false);
  });
});
