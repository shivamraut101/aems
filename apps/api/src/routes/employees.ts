import { canViewOthers } from "@aems/auth";
import { randomBytes } from "node:crypto";

import type { Json, Tables, TablesInsert, TablesUpdate } from "@aems/types";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { recordAudit } from "../lib/audit.js";
import { validationFailure } from "../lib/validation.js";

/**
 * A ban long enough to be permanent without being forever.
 *
 * GoTrue takes a duration, not a flag, and `"none"` is how it clears one. 100 years
 * is the idiom: it outlives any employment and still leaves a single call to undo.
 */
const PERMANENT_BAN = "876000h";

/** Minimal shape of the client's admin surface, so this is testable without Supabase. */
interface AdminAuth {
  auth: { admin: { updateUserById: (id: string, attrs: { ban_duration: string }) => Promise<{ error: unknown }> } };
}

/**
 * Revokes or restores a person's ability to obtain a token.
 *
 * `profiles.id` IS the `auth.users.id` — the profile row's primary key is the
 * identity's, which is what makes this a single call with no lookup.
 */
async function banAuthUser(
  client: unknown,
  userId: string,
  banned: boolean,
): Promise<{ ok: boolean; error?: unknown }> {
  try {
    const { error } = await (client as AdminAuth).auth.admin.updateUserById(userId, {
      ban_duration: banned ? PERMANENT_BAN : "none",
    });
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    // Never let an identity-provider hiccup throw out of off-boarding: the caller
    // logs, audits and reports the failure rather than abandoning the transaction
    // half-done.
    return { ok: false, error };
  }
}

/* ------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* ------------------------------------------------------------------------- */

export const createSchema = z.object({
  // Lower-cased on the way in. `profiles_company_email_key` is a unique index on
  // (company_id, lower(email)) and Supabase Auth folds case too, so storing the
  // raw casing would let "Ada@x" and "ada@x" look like two people in the roster
  // while being one account.
  email: z
    .string()
    .trim()
    .email()
    .max(200)
    .transform((value) => value.toLowerCase()),
  fullName: z.string().trim().min(1).max(160),
  role: z.enum(["super_admin", "manager", "employee"]).default("employee"),
  department: z.string().trim().max(120).nullish(),
  managerId: z.string().uuid().nullish(),
  // Optional. Supplied by an admin who wants to set the first password by hand;
  // otherwise one is generated and returned exactly once. 72 bytes is bcrypt's
  // hard limit — anything longer is silently truncated by the hash, which makes
  // a "long" password quietly weaker than it looks.
  temporaryPassword: z.string().min(8).max(72).optional(),
});

export const updateSchema = z.object({
  fullName: z.string().trim().min(1).max(160).optional(),
  department: z.string().trim().max(120).nullish(),
  managerId: z.string().uuid().nullish(),
  role: z.enum(["super_admin", "manager", "employee"]).optional(),
  monitoringEnabled: z.boolean().optional(),
});

/**
 * The roster hides off-boarded people by default.
 *
 * A plain boolean coercion would be wrong here: `z.coerce.boolean()` turns every
 * non-empty string — including "false" and "0" — into `true`, so a UI that spells
 * the default out explicitly would silently ask for the opposite of what it means.
 */
export const rosterQuerySchema = z.object({
  includeDeactivated: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type CreateEmployeeBody = z.infer<typeof createSchema>;
export type UpdateEmployeeBody = z.infer<typeof updateSchema>;

/** The shape every failure on this route takes. Fastify sends it verbatim. */
export interface RouteDenial {
  statusCode: number;
  error: string;
  message: string;
}

/* ------------------------------------------------------------------------- */
/* Pure decisions                                                             */
/* ------------------------------------------------------------------------- */

/** The three columns of a candidate manager that decide whether the link is legal. */
export interface ManagerCandidate {
  id: string;
  role: Tables<"profiles">["role"];
  deactivated_at: string | null;
}

/**
 * May `managerId` become this person's manager?
 *
 * `profiles_manager_id_fkey` constrains the target to *some* profile and nothing
 * else — not the company, not the role, not self-reference. On a service-role
 * query RLS is not there to catch the rest, so this is the whole check.
 *
 * `candidate` must come from a lookup already filtered by `company_id`: a null
 * therefore means "no such profile in your company", and the message must not
 * separate "does not exist" from "belongs to another tenant" or the endpoint
 * becomes an existence oracle for other companies' profile ids.
 */
export function managerAssignmentDenial(
  candidate: ManagerCandidate | null,
  subjectProfileId: string | null,
): RouteDenial | null {
  if (!candidate) {
    return {
      statusCode: 400,
      error: "unknown_manager",
      message: "That manager is not an employee of your company",
    };
  }

  if (subjectProfileId !== null && candidate.id === subjectProfileId) {
    return {
      statusCode: 400,
      error: "manager_is_self",
      message: "Someone cannot be their own manager",
    };
  }

  if (candidate.role === "employee") {
    return {
      statusCode: 400,
      error: "manager_not_a_manager",
      message: "Only a manager or a super admin can be assigned as a manager",
    };
  }

  if (candidate.deactivated_at !== null) {
    return {
      statusCode: 400,
      error: "manager_deactivated",
      message: "That manager has been deactivated",
    };
  }

  return null;
}

/** Body → column patch. Split out so "which fields are writable" is testable on its own. */
export function buildProfilePatch(body: UpdateEmployeeBody): TablesUpdate<"profiles"> {
  const patch: TablesUpdate<"profiles"> = {};
  if (body.fullName !== undefined) patch.full_name = body.fullName;
  if (body.department !== undefined) patch.department = body.department;
  if (body.managerId !== undefined) patch.manager_id = body.managerId;
  if (body.role !== undefined) patch.role = body.role;
  if (body.monitoringEnabled !== undefined) patch.monitoring_enabled = body.monitoringEnabled;
  return patch;
}

/**
 * Guards that stop a company locking itself out of its own account.
 *
 * Both failures are unrecoverable through the product: there is no route that
 * promotes someone without an existing super admin to call it, so the only fix
 * is a hand-written SQL statement against production.
 */
export function offboardingDenial(
  target: { id: string; role: Tables<"profiles">["role"] },
  actorProfileId: string,
  otherActiveAdmins: number,
): RouteDenial | null {
  if (target.id === actorProfileId) {
    return {
      statusCode: 400,
      error: "cannot_deactivate_self",
      message: "Ask another super admin to deactivate your account",
    };
  }

  if (target.role === "super_admin" && otherActiveAdmins < 1) {
    return {
      statusCode: 400,
      error: "last_super_admin",
      message: "Promote another super admin before deactivating this one",
    };
  }

  return null;
}

/**
 * A first password an admin can read out loud.
 *
 * Returned once, in the create response, and never stored, logged or written to
 * the audit metadata. This exists because the project has no SMTP configured, so
 * `inviteUserByEmail` — the textbook answer — fails at the GoTrue call and leaves
 * the admin with an account nobody can sign in to. A password the admin hands
 * over is worse than an emailed invite and far better than a dead account; swap
 * it for an invite the moment mail is wired up.
 *
 * base64url of 18 random bytes: 24 characters, no padding, no ambiguity about
 * which characters survive a copy-paste out of a browser.
 */
export function newTemporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}

/* ------------------------------------------------------------------------- */
/* Account creation — the two-write problem                                   */
/* ------------------------------------------------------------------------- */

/** Only the two admin calls this module makes, so a test can supply both. */
export interface AuthAdminPort {
  createUser(attributes: {
    email: string;
    password?: string;
    email_confirm?: boolean;
    user_metadata?: Record<string, unknown>;
  }): Promise<{
    data: { user: { id: string } | null };
    error: { message: string; status?: number } | null;
  }>;
  deleteUser(id: string): Promise<{ error: { message: string } | null }>;
}

export interface CreateAccountDeps {
  auth: AuthAdminPort;
  /** Inserts the profile row and returns it, or the database error. */
  insertProfile(
    row: TablesInsert<"profiles">,
  ): Promise<{ data: Tables<"profiles"> | null; error: { message: string } | null }>;
  log?: { error: (obj: unknown, msg: string) => void };
}

export type CreateAccountResult =
  | { ok: true; profile: Tables<"profiles"> }
  | ({ ok: false } & RouteDenial);

/**
 * Creates the auth user and the profile, and undoes the first if the second fails.
 *
 * Two writes to two systems with no shared transaction, so one of them can land
 * alone. The failure is not symmetric:
 *
 *   * profile without auth user — impossible, `profiles.id` references
 *     `auth.users (id)`, so the insert is what fails, not the state.
 *   * auth user without profile — an account that signs in and sees nothing.
 *     `resolveSession` throws "No profile is linked to this account", so the
 *     person is stuck at a 403 on every screen.
 *
 * We COMPENSATE rather than make it idempotent, and the reason is the uniqueness
 * asymmetry: `auth.users.email` is globally unique, while
 * `profiles_company_email_key` is unique per company. An orphaned auth row is
 * therefore invisible to every query this API makes and yet permanently blocks
 * every retry with that address — the admin sees "email already registered" for
 * an employee who does not exist and has no way, anywhere in the product, to
 * clear it. Idempotency would mean adopting whatever auth row happens to hold
 * that address, which across tenants is an account takeover.
 *
 * If the compensating delete also fails there is nothing left to do in-band, so
 * the orphaned user id goes to the log at error level and into the 500 body —
 * someone has to be able to find it.
 */
export async function createEmployeeAccount(
  deps: CreateAccountDeps,
  input: {
    email: string;
    fullName: string;
    role: Tables<"profiles">["role"];
    department: string | null;
    managerId: string | null;
    companyId: string;
    password: string;
  },
): Promise<CreateAccountResult> {
  const created = await deps.auth.createUser({
    email: input.email,
    password: input.password,
    // No mail is going out, so leaving the address unconfirmed would block the
    // first sign-in on a confirmation link nobody receives.
    email_confirm: true,
    user_metadata: { full_name: input.fullName },
  });

  if (created.error || !created.data.user) {
    const status = created.error?.status ?? 500;
    // GoTrue answers 422 for an address that already exists anywhere in the
    // project, including in another tenant. Report it as a conflict without
    // confirming which company holds it.
    const conflict = status === 422 || status === 409;
    return {
      ok: false,
      statusCode: conflict ? 409 : 502,
      error: conflict ? "email_taken" : "auth_create_failed",
      message: conflict
        ? "That email address is already registered"
        : (created.error?.message ?? "Could not create the sign-in account"),
    };
  }

  const userId = created.data.user.id;

  const inserted = await deps.insertProfile({
    id: userId,
    // From the session, never from the body. A super admin of one tenant posting
    // another tenant's company_id is the whole reason this is not read from input.
    company_id: input.companyId,
    email: input.email,
    full_name: input.fullName,
    role: input.role,
    department: input.department,
    manager_id: input.managerId,
  });

  if (inserted.error || !inserted.data) {
    const cause = inserted.error?.message ?? "Could not create the employee record";
    const undone = await deps.auth.deleteUser(userId);

    if (undone.error) {
      deps.log?.error(
        { orphanedUserId: userId, email: input.email, cause, cleanup: undone.error.message },
        "orphaned auth user: profile insert failed and the compensating delete failed too",
      );
      return {
        ok: false,
        statusCode: 500,
        error: "orphaned_auth_user",
        message: `Employee record failed (${cause}) and the sign-in account could not be removed. Delete auth user ${userId} by hand before retrying this address.`,
      };
    }

    return {
      ok: false,
      statusCode: 400,
      error: "create_failed",
      message: cause,
    };
  }

  return { ok: true, profile: inserted.data };
}

/* ------------------------------------------------------------------------- */
/* Routes                                                                     */
/* ------------------------------------------------------------------------- */

/** Columns the roster needs. `*` would ship nothing extra today but drifts silently. */
const ROSTER_COLUMNS =
  "id, email, full_name, role, department, manager_id, monitoring_enabled, deactivated_at, created_at, devices(id, platform, label, status, last_seen_at)";

export const employeeRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Looks a candidate manager up inside the caller's company and rules on it.
   *
   * Scoped by company_id on the way in, so `managerAssignmentDenial` never has to
   * be trusted with a cross-tenant row.
   */
  const checkManager = async (
    managerId: string,
    companyId: string,
    subjectProfileId: string | null,
  ): Promise<RouteDenial | null> => {
    const { data } = await app.supabase
      .from("profiles")
      .select("id, role, deactivated_at")
      .eq("id", managerId)
      .eq("company_id", companyId)
      .maybeSingle();

    return managerAssignmentDenial(data, subjectProfileId);
  };

  /** Roster for the dashboard, with each person's current device state attached. */
  app.get("/", { preHandler: app.requireManager }, async (request, reply) => {
    const session = request.session!;
    const parsed = rosterQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_query"));
    }

    let query = app.supabase
      .from("profiles")
      .select(ROSTER_COLUMNS)
      .eq("company_id", session.companyId);

    // Off-boarded people are hidden unless asked for. `monitoring_enabled = false`
    // is a pause, not a removal — before this column existed the roster had no way
    // to say "this person has left" at all.
    if (!parsed.data.includeDeactivated) {
      query = query.is("deactivated_at", null);
    }

    const { data } = await query.order("full_name");

    return data ?? [];
  });

  app.get("/:profileId", { preHandler: app.requireUser }, async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const session = request.session!;

    if (profileId !== session.profileId && !canViewOthers(session.role)) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Not your profile", statusCode: 403 });
    }

    const { data } = await app.supabase
      .from("profiles")
      .select("*, devices(*)")
      .eq("id", profileId)
      .eq("company_id", session.companyId)
      .maybeSingle();

    if (!data) {
      return reply.code(404).send({ error: "not_found", message: "No such employee", statusCode: 404 });
    }

    return data;
  });

  /**
   * Adds a person. Super admin only.
   *
   * This is the route whose absence made the product unusable: there was no way
   * to put an employee into the system at all, so every screen was seeded data.
   */
  app.post("/", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_body"));
    }

    const session = request.session!;
    const body = parsed.data;

    // Pre-flight, before an auth user exists. Every check that can be made without
    // writing is made here, because a failure after `createUser` costs a
    // compensating delete and a failure of THAT costs a manual cleanup.
    //
    // Both are reads with nothing between them, so they go together rather than one
    // after the other. The manager denial is still reported first — issuing the two
    // queries concurrently changes when they run, never which refusal the caller sees.
    const [denial, { data: clash }] = await Promise.all([
      body.managerId ? checkManager(body.managerId, session.companyId, null) : null,
      app.supabase
        .from("profiles")
        .select("id")
        .eq("company_id", session.companyId)
        .eq("email", body.email)
        .maybeSingle(),
    ]);

    if (denial) {
      return reply
        .code(denial.statusCode)
        .send({ error: denial.error, message: denial.message, statusCode: denial.statusCode });
    }

    if (clash) {
      return reply.code(409).send({
        error: "email_taken",
        message: "Someone in your company already uses that email address",
        statusCode: 409,
      });
    }

    const password = body.temporaryPassword ?? newTemporaryPassword();

    const result = await createEmployeeAccount(
      {
        auth: {
          createUser: (attributes) => app.supabase.auth.admin.createUser(attributes),
          deleteUser: (id) => app.supabase.auth.admin.deleteUser(id),
        },
        // Awaited rather than returned: PostgREST hands back a thenable builder,
        // not a Promise, and the port asks for a real one.
        insertProfile: async (row) =>
          await app.supabase.from("profiles").insert(row).select("*").single(),
        log: app.log,
      },
      {
        email: body.email,
        fullName: body.fullName,
        role: body.role,
        department: body.department ?? null,
        managerId: body.managerId ?? null,
        companyId: session.companyId,
        password,
      },
    );

    if (!result.ok) {
      return reply
        .code(result.statusCode)
        .send({ error: result.error, message: result.message, statusCode: result.statusCode });
    }

    // Only after BOTH writes have landed. An audit entry for a creation that was
    // rolled back would be a false record in an append-only log.
    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "employee.created",
        targetType: "profile",
        targetId: result.profile.id,
        // Never the password, and never a hash of it either.
        metadata: {
          email: body.email,
          role: body.role,
          department: body.department ?? null,
          managerId: body.managerId ?? null,
        },
      },
      app.log,
    );

    return reply.code(201).send({
      profile: result.profile,
      // Shown once, then gone. Null when the admin chose the password themselves,
      // because echoing back something they already know only widens its exposure.
      temporaryPassword: body.temporaryPassword ? null : password,
    });
  });

  /**
   * Employee management. Super admin only — this is where roles and the monitoring
   * toggle live, so it is the highest-privilege route in the API.
   */
  app.patch("/:profileId", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const parsed = updateSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_body"));
    }

    const session = request.session!;
    const body = parsed.data;

    // Demoting yourself could leave a company with no super admin at all.
    if (profileId === session.profileId && body.role && body.role !== "super_admin") {
      return reply.code(400).send({
        error: "cannot_demote_self",
        message: "Ask another super admin to change your role",
        statusCode: 400,
      });
    }

    // `manager_id` is the one caller-supplied identifier on this route that
    // reaches a write. The foreign key accepts any profile in the database,
    // including one in another tenant, and the service-role client means RLS will
    // not second-guess it.
    if (body.managerId) {
      const denial = await checkManager(body.managerId, session.companyId, profileId);
      if (denial) {
        return reply
          .code(denial.statusCode)
          .send({ error: denial.error, message: denial.message, statusCode: denial.statusCode });
      }
    }

    const patch = buildProfilePatch(body);

    if (Object.keys(patch).length === 0) {
      return reply
        .code(400)
        .send({ error: "empty_patch", message: "Nothing to update", statusCode: 400 });
    }

    const { data, error } = await app.supabase
      .from("profiles")
      .update(patch)
      .eq("id", profileId)
      .eq("company_id", session.companyId)
      .select("*")
      .maybeSingle();

    if (error || !data) {
      return reply
        .code(404)
        .send({ error: "not_found", message: error?.message ?? "No such employee", statusCode: 404 });
    }

    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "employee.updated",
        targetType: "profile",
        targetId: profileId,
        metadata: patch as Json,
      },
      app.log,
    );

    return data;
  });

  /**
   * Off-boards a person. Soft, always.
   *
   * A hard delete is not available and must not be added. `profiles.id` cascades
   * from `auth.users`, and the monitoring tables cascade from `profiles`, so
   * `deleteUser` would take the work sessions, the activity, the screenshot
   * metadata and — worst — the `consent_records` that prove the collection was
   * lawful. The screenshot bytes in Storage are not cascaded and would outlive
   * all of it: images with no consent record behind them. It would also punch a
   * hole in the audit log's meaning, since entries would point at target ids that
   * no longer resolve to anyone.
   *
   * So the row stays and four things change together — the tombstone, the
   * monitoring switch, every device, and every live consent record. Revocation is
   * immediate by non-negotiable #4, and each of those is a place an agent checks.
   */
  app.delete("/:profileId", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const session = request.session!;

    const { data: target } = await app.supabase
      .from("profiles")
      .select("id, role, deactivated_at")
      .eq("id", profileId)
      .eq("company_id", session.companyId)
      .maybeSingle();

    if (!target) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "No such employee", statusCode: 404 });
    }

    if (target.deactivated_at !== null) {
      return reply.code(409).send({
        error: "already_deactivated",
        message: "That employee is already deactivated",
        statusCode: 409,
      });
    }

    // Counted only when it matters, and only among people who can still sign in.
    let otherActiveAdmins = 0;
    if (target.role === "super_admin") {
      const { count } = await app.supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("company_id", session.companyId)
        .eq("role", "super_admin")
        .is("deactivated_at", null)
        .neq("id", profileId);
      otherActiveAdmins = count ?? 0;
    }

    const denial = offboardingDenial(target, session.profileId, otherActiveAdmins);
    if (denial) {
      return reply
        .code(denial.statusCode)
        .send({ error: denial.error, message: denial.message, statusCode: denial.statusCode });
    }

    const now = new Date().toISOString();

    const { data: updated, error } = await app.supabase
      .from("profiles")
      .update({ deactivated_at: now, monitoring_enabled: false })
      .eq("id", profileId)
      .eq("company_id", session.companyId)
      .is("deactivated_at", null)
      .select("*")
      .maybeSingle();

    if (error || !updated) {
      return reply.code(409).send({
        error: "deactivate_failed",
        message: error?.message ?? "The employee was changed by someone else — try again",
        statusCode: 409,
      });
    }

    // Devices first, consent second. In that order the worst interleaving is a
    // revoked device whose consent row is still open, which collects nothing
    // because `requireDevice` rejects it. The reverse order leaves a live device
    // with no consent, and `assertConsent` is the only thing standing between it
    // and a screenshot.
    const { data: revokedDevices } = await app.supabase
      .from("devices")
      .update({ status: "revoked" })
      .eq("profile_id", profileId)
      .eq("company_id", session.companyId)
      .neq("status", "revoked")
      .select("id");

    const { data: revokedConsents } = await app.supabase
      .from("consent_records")
      .update({ revoked_at: now })
      .eq("profile_id", profileId)
      .eq("company_id", session.companyId)
      .is("revoked_at", null)
      .select("id");

    // Off-boarding has to reach the identity, not just the profile row.
    //
    // Everything above closes the API and the agents. None of it stops the person
    // signing in to Supabase Auth and querying PostgREST directly with the public
    // anon key: their `auth.users` row is untouched, so they still get a JWT, and the
    // self-read RLS policies happily serve their own history to it. Revoking the
    // ability to obtain a token at all is the one action that shuts every door —
    // PostgREST, the dashboard middleware, and any future client — instead of
    // patching each policy and hoping the next one remembers.
    //
    // A ban rather than a delete: `profiles.id` references `auth.users(id)`, so
    // deleting the identity would cascade the profile away and take the monitoring
    // history with it. Reversible, too, which reactivate below depends on.
    const banned = await banAuthUser(app.supabase, profileId, true);
    if (!banned.ok) {
      // Not fatal — the profile IS deactivated and the API already refuses them, so
      // failing the whole request would leave a half-off-boarded person and no audit
      // entry. Recorded loudly instead, and surfaced in the response.
      app.log.error(
        { err: banned.error, profileId },
        "employee deactivated but the auth identity could not be banned — they can still obtain a token",
      );
    }

    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "employee.deactivated",
        targetType: "profile",
        targetId: profileId,
        metadata: {
          deactivatedAt: now,
          signInRevoked: banned.ok,
          devicesRevoked: revokedDevices?.length ?? 0,
          consentRecordsRevoked: revokedConsents?.length ?? 0,
        },
      },
      app.log,
    );

    return {
      ok: true as const,
      profile: updated,
      signInRevoked: banned.ok,
      devicesRevoked: revokedDevices?.length ?? 0,
      consentRecordsRevoked: revokedConsents?.length ?? 0,
    };
  });

  /**
   * Brings a person back.
   *
   * Deliberately narrow: it clears the tombstone and nothing else. Monitoring
   * stays off and the devices stay revoked, because consent was withdrawn during
   * the off-boarding and non-negotiable #1 says collection may not resume without
   * a fresh, non-revoked consent record. Re-enrolling the agent is what produces
   * one. A reactivate that quietly switched collection back on would be exactly
   * the silent monitoring the compliance model forbids.
   */
  app.post("/:profileId/reactivate", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const session = request.session!;

    const { data, error } = await app.supabase
      .from("profiles")
      .update({ deactivated_at: null })
      .eq("id", profileId)
      .eq("company_id", session.companyId)
      .not("deactivated_at", "is", null)
      .select("*")
      .maybeSingle();

    if (error || !data) {
      // Either there is no such person in this company, or they were never
      // deactivated. Both are "nothing to reactivate".
      return reply.code(404).send({
        error: "not_found",
        message: "No deactivated employee with that id",
        statusCode: 404,
      });
    }

    // Lift the sign-in ban the off-boarding applied. Done AFTER the tombstone is
    // cleared: if this order were reversed and the update then failed, the person
    // could sign in while still deactivated — which is precisely the state the ban
    // exists to prevent.
    const unbanned = await banAuthUser(app.supabase, profileId, false);
    if (!unbanned.ok) {
      app.log.error(
        { err: unbanned.error, profileId },
        "employee reactivated but the auth ban could not be lifted — they cannot sign in",
      );
    }

    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "employee.reactivated",
        targetType: "profile",
        targetId: profileId,
        metadata: { monitoringEnabled: data.monitoring_enabled },
      },
      app.log,
    );

    return {
      ok: true as const,
      profile: data,
      // Stated rather than implied, so a UI cannot present a reactivated employee
      // as being monitored again when they are not.
      monitoringEnabled: data.monitoring_enabled,
      devicesRestored: 0,
    };
  });
};
