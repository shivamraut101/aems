import { describe, expect, it } from "vitest";

import {
  EMPTY_CREATE_FORM,
  createEmployeeSchema,
  editDefaults,
  editEmployeeSchema,
  isDeactivated,
  managerName,
  managerOptions,
  toCreateBody,
  toUpdatePatch,
  type EditableEmployee,
  type ManagerCandidate,
} from "./employees-form";

const person: EditableEmployee = {
  full_name: "Ada Lovelace",
  department: "Engineering",
  manager_id: "11111111-1111-4111-8111-111111111111",
  role: "employee",
  monitoring_enabled: true,
};

describe("createEmployeeSchema", () => {
  it("accepts a minimal person — email, name and role", () => {
    const result = createEmployeeSchema.safeParse({
      ...EMPTY_CREATE_FORM,
      email: "ada@acme.test",
      fullName: "Ada Lovelace",
    });

    expect(result.success).toBe(true);
  });

  it("rejects the empty form it starts life in, so Save cannot fire on a blank dialog", () => {
    expect(createEmployeeSchema.safeParse(EMPTY_CREATE_FORM).success).toBe(false);
  });

  it("rejects a non-address and says so in words a person can act on", () => {
    const result = createEmployeeSchema.safeParse({
      ...EMPTY_CREATE_FORM,
      email: "ada",
      fullName: "Ada",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toBe("That does not look like an email address.");
  });

  it("trims before it measures, so a name of spaces is not a name", () => {
    const result = createEmployeeSchema.safeParse({
      ...EMPTY_CREATE_FORM,
      email: "ada@acme.test",
      fullName: "   ",
    });

    expect(result.success).toBe(false);
  });

  it("accepts an empty manager but refuses a manager that is not an id", () => {
    const none = createEmployeeSchema.safeParse({
      ...EMPTY_CREATE_FORM,
      email: "ada@acme.test",
      fullName: "Ada",
      managerId: "",
    });
    const bad = createEmployeeSchema.safeParse({
      ...EMPTY_CREATE_FORM,
      email: "ada@acme.test",
      fullName: "Ada",
      managerId: "Grace Hopper",
    });

    expect(none.success).toBe(true);
    expect(bad.success).toBe(false);
  });

  it("refuses a role outside the three RLS knows about", () => {
    const result = createEmployeeSchema.safeParse({
      ...EMPTY_CREATE_FORM,
      email: "ada@acme.test",
      fullName: "Ada",
      role: "owner",
    });

    expect(result.success).toBe(false);
  });
});

describe("toCreateBody", () => {
  it("omits department and manager rather than sending empty strings", () => {
    const body = toCreateBody({
      ...EMPTY_CREATE_FORM,
      email: "ada@acme.test",
      fullName: "Ada Lovelace",
    });

    expect(body).toEqual({ email: "ada@acme.test", fullName: "Ada Lovelace", role: "employee" });
    expect("department" in body).toBe(false);
    expect("managerId" in body).toBe(false);
  });

  it("lower-cases the address, because Supabase Auth stores it that way", () => {
    const body = toCreateBody({
      ...EMPTY_CREATE_FORM,
      email: "  Ada@Acme.Test ",
      fullName: " Ada Lovelace ",
    });

    expect(body.email).toBe("ada@acme.test");
    expect(body.fullName).toBe("Ada Lovelace");
  });

  it("carries a department and a manager through when they were filled in", () => {
    const body = toCreateBody({
      email: "ada@acme.test",
      fullName: "Ada",
      role: "manager",
      department: " Engineering ",
      managerId: "11111111-1111-4111-8111-111111111111",
    });

    expect(body.department).toBe("Engineering");
    expect(body.managerId).toBe("11111111-1111-4111-8111-111111111111");
    expect(body.role).toBe("manager");
  });
});

describe("editDefaults", () => {
  it("renders every null column as an empty control, never as the string null", () => {
    expect(
      editDefaults({
        full_name: null,
        department: null,
        manager_id: null,
        role: "manager",
        monitoring_enabled: false,
      }),
    ).toEqual({
      fullName: "",
      department: "",
      managerId: "",
      role: "manager",
      monitoring: "paused",
    });
  });

  it("round-trips an unchanged form to no patch at all", () => {
    expect(toUpdatePatch(editDefaults(person), person)).toBeNull();
  });
});

describe("toUpdatePatch", () => {
  it("sends only what moved", () => {
    const patch = toUpdatePatch({ ...editDefaults(person), department: "Support" }, person);
    expect(patch).toEqual({ department: "Support" });
  });

  it("clears an emptied department with null, not with an empty string", () => {
    const patch = toUpdatePatch({ ...editDefaults(person), department: "  " }, person);
    expect(patch).toEqual({ department: null });
  });

  it("clears a manager with null, which is what detaches somebody from a team", () => {
    const patch = toUpdatePatch({ ...editDefaults(person), managerId: "" }, person);
    expect(patch).toEqual({ managerId: null });
  });

  it("carries a role change", () => {
    const patch = toUpdatePatch({ ...editDefaults(person), role: "manager" }, person);
    expect(patch).toEqual({ role: "manager" });
  });

  it("treats a whitespace-only edit of an unset field as no change", () => {
    const blank: EditableEmployee = { ...person, department: null };
    expect(toUpdatePatch({ ...editDefaults(blank), department: "   " }, blank)).toBeNull();
  });

  it("carries a monitoring change as the boolean the API expects", () => {
    const patch = toUpdatePatch({ ...editDefaults(person), monitoring: "paused" }, person);
    expect(patch).toEqual({ monitoringEnabled: false });
  });

  it("combines every field a super admin touched into one request", () => {
    const patch = toUpdatePatch(
      {
        fullName: "Ada L.",
        department: "Support",
        managerId: "",
        role: "manager",
        monitoring: "paused",
      },
      person,
    );

    expect(patch).toEqual({
      fullName: "Ada L.",
      department: "Support",
      managerId: null,
      role: "manager",
      monitoringEnabled: false,
    });
  });
});

describe("editEmployeeSchema", () => {
  it("accepts a person with no department and no manager", () => {
    const result = editEmployeeSchema.safeParse({
      fullName: "Ada",
      department: "",
      managerId: "",
      role: "employee",
      monitoring: "on",
    });

    expect(result.success).toBe(true);
  });

  it("still requires a name — a profile with no name renders as a blank row", () => {
    const result = editEmployeeSchema.safeParse({
      fullName: "",
      department: "",
      managerId: "",
      role: "employee",
      monitoring: "on",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a monitoring value that is neither on nor paused", () => {
    const result = editEmployeeSchema.safeParse({
      fullName: "Ada",
      department: "",
      managerId: "",
      role: "employee",
      monitoring: "maybe",
    });

    expect(result.success).toBe(false);
  });
});

describe("managerOptions", () => {
  const roster: ManagerCandidate[] = [
    { id: "a", full_name: "Zoe Byrne", email: "zoe@acme.test", role: "manager" },
    { id: "b", full_name: null, email: "admin@acme.test", role: "super_admin" },
    { id: "c", full_name: "Ada Lovelace", email: "ada@acme.test", role: "employee" },
  ];

  it("excludes a deactivated manager, matching what the API refuses", () => {
    const withLeaver: ManagerCandidate[] = [
      ...roster,
      {
        id: "d",
        full_name: "Alan Turing",
        email: "alan@acme.test",
        role: "manager",
        deactivated_at: "2026-08-01T09:00:00.000Z",
      },
    ];

    expect(managerOptions(withLeaver).map((option) => option.id)).toEqual(["b", "a"]);
  });

  it("offers managers and super admins, never employees", () => {
    expect(managerOptions(roster).map((option) => option.id)).toEqual(["b", "a"]);
  });

  it("falls back to the email when a manager has no name yet", () => {
    expect(managerOptions(roster)[0]?.label).toBe("admin@acme.test");
  });

  it("excludes the person being edited, so nobody becomes their own manager", () => {
    expect(managerOptions(roster, "a").map((option) => option.id)).toEqual(["b"]);
  });

  it("sorts by label case-insensitively", () => {
    expect(managerOptions(roster).map((option) => option.label)).toEqual([
      "admin@acme.test",
      "Zoe Byrne",
    ]);
  });
});

describe("managerName", () => {
  const roster: ManagerCandidate[] = [
    { id: "a", full_name: "Zoe Byrne", email: "zoe@acme.test", role: "manager" },
  ];

  it("names the manager", () => {
    expect(managerName(roster, "a")).toBe("Zoe Byrne");
  });

  it("returns null for nobody, so the page says 'Not set' rather than printing a uuid", () => {
    expect(managerName(roster, null)).toBeNull();
    expect(managerName(roster, "gone")).toBeNull();
  });
});

describe("isDeactivated", () => {
  it("is false for a row that does not carry the column at all", () => {
    expect(isDeactivated({})).toBe(false);
  });

  it("is false for a live account", () => {
    expect(isDeactivated({ deactivated_at: null })).toBe(false);
  });

  it("is true once the tombstone is set", () => {
    expect(isDeactivated({ deactivated_at: "2026-08-05T10:00:00.000Z" })).toBe(true);
  });
});
