import type { Tables, TablesInsert } from "@aems/types";
import { describe, expect, it, vi } from "vitest";

import {
  buildProfilePatch,
  createEmployeeAccount,
  createSchema,
  managerAssignmentDenial,
  newTemporaryPassword,
  offboardingDenial,
  roleChangeDenial,
  rosterQuerySchema,
  updateSchema,
  type AuthAdminPort,
  type CreateAccountDeps,
  type ManagerCandidate,
} from "./employees.js";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const SUBJECT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const candidate = (over: Partial<ManagerCandidate> = {}): ManagerCandidate => ({
  id: OTHER,
  role: "manager",
  deactivated_at: null,
  ...over,
});

const profileRow = (over: Partial<Tables<"profiles">> = {}): Tables<"profiles"> => ({
  id: SUBJECT,
  company_id: COMPANY,
  email: "new@acme.test",
  full_name: "New Person",
  role: "employee",
  department: null,
  manager_id: null,
  monitoring_enabled: true,
  deactivated_at: null,
  created_at: "2026-08-05T00:00:00.000Z",
  updated_at: "2026-08-05T00:00:00.000Z",
  ...over,
});

/* ------------------------------------------------------------------------- */

describe("createSchema", () => {
  const valid = { email: "New.Person@Acme.test", fullName: "New Person" };

  it("lower-cases and trims the address so one person cannot become two rows", () => {
    // profiles_company_email_key is unique on (company_id, lower(email)) and
    // Supabase Auth folds case as well. Storing "New.Person@Acme.test" verbatim
    // would put a second-looking row in the roster for the same account.
    expect(createSchema.parse({ ...valid, email: "  New.Person@Acme.test " }).email).toBe(
      "new.person@acme.test",
    );
  });

  it("defaults the role to employee rather than to anything privileged", () => {
    // A body that forgets `role` must not create an admin. Asserted because the
    // default is a security decision, not a convenience.
    expect(createSchema.parse(valid).role).toBe("employee");
  });

  it("rejects a role outside the three the schema check constrains", () => {
    expect(createSchema.safeParse({ ...valid, role: "owner" }).success).toBe(false);
  });

  it("rejects a malformed address before it reaches Supabase Auth", () => {
    expect(createSchema.safeParse({ ...valid, email: "not-an-address" }).success).toBe(false);
  });

  it("rejects a blank name, which would render as an empty row in the roster", () => {
    expect(createSchema.safeParse({ ...valid, fullName: "   " }).success).toBe(false);
  });

  it("rejects a managerId that is not a uuid, so it never reaches a query", () => {
    expect(createSchema.safeParse({ ...valid, managerId: "the-boss" }).success).toBe(false);
  });

  it("caps a supplied password at bcrypt's 72-byte limit", () => {
    // Beyond 72 bytes bcrypt silently truncates, so a "stronger" password is
    // quietly weaker than the admin believes. Rejecting is honest.
    expect(createSchema.safeParse({ ...valid, temporaryPassword: "x".repeat(73) }).success).toBe(
      false,
    );
    expect(createSchema.safeParse({ ...valid, temporaryPassword: "short" }).success).toBe(false);
    expect(createSchema.safeParse({ ...valid, temporaryPassword: "x".repeat(12) }).success).toBe(
      true,
    );
  });

  it("accepts an explicit null manager and department", () => {
    const parsed = createSchema.parse({ ...valid, managerId: null, department: null });
    expect(parsed.managerId).toBeNull();
    expect(parsed.department).toBeNull();
  });

  it("has no company_id to give — it is not in the schema at all", () => {
    // The tenant comes from the session. If this ever parses, a super admin of one
    // company can post another company's id and plant a profile inside it.
    const parsed = createSchema.parse({ ...valid, companyId: COMPANY });
    expect(parsed).not.toHaveProperty("companyId");
    expect(parsed).not.toHaveProperty("company_id");
  });
});

describe("rosterQuerySchema", () => {
  it("hides deactivated people unless they are explicitly asked for", () => {
    expect(rosterQuerySchema.parse({}).includeDeactivated).toBe(false);
    expect(rosterQuerySchema.parse({ includeDeactivated: "true" }).includeDeactivated).toBe(true);
  });

  it("reads 'false' as false, which a boolean coercion would get backwards", () => {
    // z.coerce.boolean("false") is true. A UI that spells the default out would
    // have asked for the opposite of what it meant.
    expect(rosterQuerySchema.parse({ includeDeactivated: "false" }).includeDeactivated).toBe(false);
  });

  it("rejects anything that is not one of the two words", () => {
    expect(rosterQuerySchema.safeParse({ includeDeactivated: "1" }).success).toBe(false);
    expect(rosterQuerySchema.safeParse({ includeDeactivated: "yes" }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */

describe("managerAssignmentDenial", () => {
  it("refuses an id that resolved to nothing in the caller's company", () => {
    // The lookup is filtered by company_id, so null means "not in your company"
    // — whether it exists elsewhere or not at all.
    const denial = managerAssignmentDenial(null, SUBJECT);
    expect(denial?.statusCode).toBe(400);
    expect(denial?.error).toBe("unknown_manager");
  });

  it("does not distinguish a nonexistent id from another tenant's id", () => {
    // Two different messages here would turn the endpoint into an existence
    // oracle for other companies' profile ids.
    expect(managerAssignmentDenial(null, SUBJECT)?.message).toBe(
      managerAssignmentDenial(null, OTHER)?.message,
    );
  });

  it("refuses a self-reference", () => {
    // profiles_manager_id_fkey happily accepts id = manager_id, which makes an
    // org chart with a cycle of one and hangs any naive traversal.
    const denial = managerAssignmentDenial(candidate({ id: SUBJECT }), SUBJECT);
    expect(denial?.error).toBe("manager_is_self");
  });

  it("refuses an employee as a manager", () => {
    const denial = managerAssignmentDenial(candidate({ role: "employee" }), SUBJECT);
    expect(denial?.error).toBe("manager_not_a_manager");
  });

  it("refuses a deactivated manager", () => {
    const denial = managerAssignmentDenial(
      candidate({ deactivated_at: "2026-08-01T00:00:00.000Z" }),
      SUBJECT,
    );
    expect(denial?.error).toBe("manager_deactivated");
  });

  it("allows a manager and a super admin", () => {
    expect(managerAssignmentDenial(candidate({ role: "manager" }), SUBJECT)).toBeNull();
    expect(managerAssignmentDenial(candidate({ role: "super_admin" }), SUBJECT)).toBeNull();
  });

  it("skips the self check on create, where the subject has no id yet", () => {
    // POST has nobody to compare against — the profile is created a moment later
    // with an id nobody has seen. Passing null must not be read as "matches".
    expect(managerAssignmentDenial(candidate({ id: SUBJECT }), null)).toBeNull();
  });

  it("still refuses a self-referencing employee, not just the first rule it hits", () => {
    // Both rules fire; the point is that neither ordering lets the row through.
    expect(managerAssignmentDenial(candidate({ id: SUBJECT, role: "employee" }), SUBJECT)).not
      .toBeNull();
  });
});

describe("buildProfilePatch", () => {
  it("omits absent fields so a partial PATCH cannot blank a column", () => {
    expect(buildProfilePatch({ fullName: "Ada" })).toEqual({ full_name: "Ada" });
  });

  it("keeps an explicit null, which is how a manager or department is cleared", () => {
    // `undefined` means "leave alone" and `null` means "unset". Collapsing the two
    // would make un-assigning a manager impossible through the API.
    expect(buildProfilePatch({ managerId: null, department: null })).toEqual({
      manager_id: null,
      department: null,
    });
  });

  it("maps every writable field to its column name", () => {
    expect(
      buildProfilePatch({
        fullName: "Ada",
        department: "Eng",
        managerId: OTHER,
        role: "manager",
        monitoringEnabled: false,
      }),
    ).toEqual({
      full_name: "Ada",
      department: "Eng",
      manager_id: OTHER,
      role: "manager",
      monitoring_enabled: false,
    });
  });

  it("produces an empty patch for an empty body, which the route turns into a 400", () => {
    expect(Object.keys(buildProfilePatch({}))).toHaveLength(0);
  });

  it("cannot set company_id, id or the deactivation tombstone", () => {
    // updateSchema has no field for any of them, so a body carrying them is
    // stripped before it gets here. This asserts the strip, not the intent.
    const body = updateSchema.parse({
      fullName: "Ada",
      companyId: COMPANY,
      id: OTHER,
      deactivatedAt: "2026-08-05T00:00:00.000Z",
      monitoringEnabled: false,
    });

    const patch = buildProfilePatch(body);
    expect(patch).not.toHaveProperty("company_id");
    expect(patch).not.toHaveProperty("id");
    expect(patch).not.toHaveProperty("deactivated_at");
  });
});

describe("offboardingDenial", () => {
  it("refuses self-deactivation", () => {
    const denial = offboardingDenial({ id: ADMIN, role: "super_admin" }, ADMIN, 5);
    expect(denial?.error).toBe("cannot_deactivate_self");
  });

  it("refuses deactivating the last super admin", () => {
    // No route promotes anyone without a super admin to call it, so this failure
    // is only recoverable with hand-written SQL against production.
    const denial = offboardingDenial({ id: SUBJECT, role: "super_admin" }, ADMIN, 0);
    expect(denial?.error).toBe("last_super_admin");
  });

  it("allows deactivating a super admin while another remains", () => {
    expect(offboardingDenial({ id: SUBJECT, role: "super_admin" }, ADMIN, 1)).toBeNull();
  });

  it("does not count admins for a manager or an employee", () => {
    for (const role of ["manager", "employee"] as const) {
      expect(offboardingDenial({ id: SUBJECT, role }, ADMIN, 0)).toBeNull();
    }
  });

  it("puts the self check ahead of everything, so the sole admin gets the honest reason", () => {
    expect(offboardingDenial({ id: ADMIN, role: "super_admin" }, ADMIN, 0)?.error).toBe(
      "cannot_deactivate_self",
    );
  });
});

/**
 * The second door into the same unrecoverable state.
 *
 * `offboardingDenial` stops the last super admin being deactivated. This stops them
 * demoting themselves, which locks a company out just as completely — no route promotes
 * anyone without an existing super admin to call it, so the only way back is
 * hand-written SQL against production.
 *
 * The guard was already in the route and had no test at all, which is how a five-line
 * conditional inside a handler quietly survives a refactor that removes it.
 */
describe("roleChangeDenial", () => {
  it("refuses a super admin demoting themselves", () => {
    for (const role of ["manager", "employee"] as const) {
      expect(roleChangeDenial(ADMIN, ADMIN, role)?.error).toBe("cannot_demote_self");
    }
  });

  it("allows demoting somebody else", () => {
    // Safe by construction: the caller is a super admin and cannot demote themselves,
    // so at least one always survives the change.
    expect(roleChangeDenial(SUBJECT, ADMIN, "employee")).toBeNull();
  });

  it("allows a no-op that leaves you a super admin", () => {
    expect(roleChangeDenial(ADMIN, ADMIN, "super_admin")).toBeNull();
  });

  it("does not touch a patch that never mentions a role", () => {
    // The regression this exists to prevent: an admin correcting their own department
    // or display name must not be refused because the guard fired on an absent field.
    expect(roleChangeDenial(ADMIN, ADMIN, undefined)).toBeNull();
  });
});

describe("newTemporaryPassword", () => {
  it("is long, unpredictable and safe to copy out of a browser", () => {
    const a = newTemporaryPassword();
    const b = newTemporaryPassword();

    expect(a).not.toBe(b);
    expect(a).toHaveLength(24);
    // base64url only: no +, / or = to be mangled by a copy-paste or a URL.
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

/* ------------------------------------------------------------------------- */
/* The two-write failure                                                      */
/* ------------------------------------------------------------------------- */

const NEW_USER_ID = "44444444-4444-4444-8444-444444444444";

const input = {
  email: "new@acme.test",
  fullName: "New Person",
  role: "employee" as const,
  department: null,
  managerId: null,
  companyId: COMPANY,
  password: "temporary-password",
};

function fakeAuth(over: Partial<AuthAdminPort> = {}): AuthAdminPort {
  return {
    createUser: vi.fn(async () => ({ data: { user: { id: NEW_USER_ID } }, error: null })),
    deleteUser: vi.fn(async () => ({ error: null })),
    ...over,
  };
}

function deps(over: Partial<CreateAccountDeps> = {}): CreateAccountDeps {
  return {
    auth: fakeAuth(),
    insertProfile: vi.fn(async (row: TablesInsert<"profiles">) => ({
      data: profileRow({ id: row.id, company_id: row.company_id, email: row.email }),
      error: null,
    })),
    log: { error: vi.fn() },
    ...over,
  };
}

describe("createEmployeeAccount", () => {
  it("gives the profile the id of the auth user it just created", async () => {
    // The two are the same person only because profiles.id references
    // auth.users(id). A generated id here would fail the foreign key.
    const d = deps();
    const result = await createEmployeeAccount(d, input);

    expect(result.ok).toBe(true);
    expect(d.insertProfile).toHaveBeenCalledWith(expect.objectContaining({ id: NEW_USER_ID }));
  });

  it("takes company_id from the caller, never from anything the caller sent", async () => {
    const d = deps();
    await createEmployeeAccount(d, { ...input, companyId: COMPANY });

    expect(d.insertProfile).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: COMPANY }),
    );
  });

  it("confirms the address, because no invitation mail is going out", async () => {
    // Without email_confirm the account exists and the first sign-in blocks on a
    // confirmation link nobody receives.
    const auth = fakeAuth();
    await createEmployeeAccount(deps({ auth }), input);

    expect(auth.createUser).toHaveBeenCalledWith(expect.objectContaining({ email_confirm: true }));
  });

  it("reports an address already registered anywhere as a 409", async () => {
    const auth = fakeAuth({
      createUser: vi.fn(async () => ({
        data: { user: null },
        error: { message: "A user with this email address has already been registered", status: 422 },
      })),
    });

    const result = await createEmployeeAccount(deps({ auth }), input);

    expect(result).toMatchObject({ ok: false, statusCode: 409, error: "email_taken" });
  });

  it("does not leak which tenant already holds the address", async () => {
    // GoTrue's own message names nothing, but ours must not either — the address
    // may belong to a different company entirely.
    const auth = fakeAuth({
      createUser: vi.fn(async () => ({
        data: { user: null },
        error: { message: "already registered in company Globex", status: 422 },
      })),
    });

    const result = await createEmployeeAccount(deps({ auth }), input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("That email address is already registered");
  });

  it("does not insert a profile when the auth user was never created", async () => {
    const auth = fakeAuth({
      createUser: vi.fn(async () => ({ data: { user: null }, error: { message: "boom", status: 500 } })),
    });
    const d = deps({ auth });

    const result = await createEmployeeAccount(d, input);

    expect(result.ok).toBe(false);
    expect(d.insertProfile).not.toHaveBeenCalled();
  });

  it("deletes the auth user when the profile insert fails", async () => {
    // This is the whole point of the compensation. auth.users.email is globally
    // unique while profiles_company_email_key is only per-company, so an orphan
    // auth row is invisible to every query the API makes and still blocks every
    // retry with that address, forever.
    const auth = fakeAuth();
    const d = deps({
      auth,
      insertProfile: vi.fn(async () => ({ data: null, error: { message: "duplicate key" } })),
    });

    const result = await createEmployeeAccount(d, input);

    expect(auth.deleteUser).toHaveBeenCalledWith(NEW_USER_ID);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
    if (result.ok) return;
    expect(result.message).toContain("duplicate key");
  });

  it("names the orphaned user id when the compensating delete also fails", async () => {
    // Nothing is left to do in-band. The id has to reach a human, so it goes to
    // the log AND into the response body.
    const auth = fakeAuth({
      deleteUser: vi.fn(async () => ({ error: { message: "network down" } })),
    });
    const log = { error: vi.fn() };
    const d = deps({
      auth,
      log,
      insertProfile: vi.fn(async () => ({ data: null, error: { message: "insert exploded" } })),
    });

    const result = await createEmployeeAccount(d, input);

    expect(result).toMatchObject({ ok: false, statusCode: 500, error: "orphaned_auth_user" });
    if (result.ok) return;
    expect(result.message).toContain(NEW_USER_ID);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ orphanedUserId: NEW_USER_ID }),
      expect.stringContaining("orphaned auth user"),
    );
  });

  it("never puts the password into the log line", async () => {
    const log = { error: vi.fn() };
    const d = deps({
      auth: fakeAuth({ deleteUser: vi.fn(async () => ({ error: { message: "network down" } })) }),
      log,
      insertProfile: vi.fn(async () => ({ data: null, error: { message: "insert exploded" } })),
    });

    await createEmployeeAccount(d, { ...input, password: "s3cret-do-not-log" });

    expect(JSON.stringify(log.error.mock.calls)).not.toContain("s3cret-do-not-log");
  });

  it("does not delete anything on the happy path", async () => {
    const auth = fakeAuth();
    await createEmployeeAccount(deps({ auth }), input);

    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it("treats a missing user with no error as a failure rather than proceeding", async () => {
    // A response with neither a user nor an error should not be readable as
    // success — `data.user.id` would be undefined and the profile would get a
    // null primary key.
    const d = deps({
      auth: fakeAuth({ createUser: vi.fn(async () => ({ data: { user: null }, error: null })) }),
    });

    const result = await createEmployeeAccount(d, input);

    expect(result.ok).toBe(false);
    expect(d.insertProfile).not.toHaveBeenCalled();
  });
});
