import { DATA_TYPE_IDS, type DataTypeId } from "@aems/types";
import type { AemsSupabaseClient } from "@aems/supabase";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { recordAudit } from "../lib/audit.js";
import { validationFailure } from "../lib/validation.js";

const consentSchema = z.object({
  deviceId: z.string().uuid(),
  policyVersion: z.string().min(1),
  method: z.enum(["in_app_dialog", "onboarding_portal", "signed_document"]),
  /**
   * The data types the screen actually listed, and therefore what was agreed to.
   *
   * Optional: an agent that predates per-type consent submits without it, and the row
   * it writes keeps `granted_types` NULL — "the platform default of the day", which is
   * exactly what those signatures meant. A `[]` would mean "agreed to nothing".
   */
  grantedTypes: z
    .array(z.enum(DATA_TYPE_IDS as unknown as [DataTypeId, ...DataTypeId[]]))
    .optional(),
});

function sameTypes(a: DataTypeId[] | null, b: DataTypeId[] | null | undefined): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/**
 * Withdraws a live consent that no longer describes what is being agreed to.
 *
 * `consent_records` allows exactly one live row per device (a partial unique index), so
 * without this an employee agreeing to a type their administrator switched on after
 * they first consented would 409 forever — and the server would go on refusing that
 * type, because it enforces `granted ∩ allowed`. The superseded row stays, revoked,
 * because the trail of what was agreed to and when is the point of the table.
 *
 * An identical re-submission is left alone, so a replayed consent still 409s as it did.
 */
async function supersedeConsent(
  supabase: AemsSupabaseClient,
  companyId: string,
  deviceId: string,
  policyVersion: string,
  grantedTypes: DataTypeId[] | undefined,
): Promise<void> {
  const { data: live } = await supabase
    .from("consent_records")
    .select("id, policy_version, granted_types")
    .eq("device_id", deviceId)
    .eq("company_id", companyId)
    .is("revoked_at", null)
    .maybeSingle();

  if (!live) return;
  if (live.policy_version === policyVersion && sameTypes(live.granted_types, grantedTypes)) return;

  await supabase
    .from("consent_records")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", live.id);
}

/**
 * The device-token variant. No `deviceId`: the token names the device, and accepting
 * one from the body would let a caller with any valid device token consent on behalf
 * of another machine.
 */
const deviceConsentSchema = consentSchema.omit({ deviceId: true });

export const authRoutes: FastifyPluginAsync = async (app) => {
  /** Who am I? Used by the dashboard and by agents right after login. */
  app.get("/me", { preHandler: app.requireUser }, async (request) => {
    const session = request.session!;

    const { data: profile } = await app.supabase
      .from("profiles")
      // `companies(name)` is what the Settings screen prints as the tenant name.
      // Without it `parseMeResponse` resolves `companyName` to null and the row
      // that exists to answer "which company is this" rendered "Not set".
      .select(
        "id, company_id, email, full_name, role, department, monitoring_enabled, companies(name)",
      )
      .eq("id", session.profileId)
      .single();

    return { profile };
  });

  /**
   * Records consent. This is the gate every ingestion path checks — without a row
   * here, nothing about this device may be collected.
   */
  app.post("/consent", { preHandler: app.requireUser }, async (request, reply) => {
    const parsed = consentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_body"));
    }

    const session = request.session!;
    const { deviceId, policyVersion, method, grantedTypes } = parsed.data;

    // Two independent reads, so one round trip rather than two. Neither is a write and
    // the ownership refusal below still comes first: what a caller who fails it sees is
    // unchanged, only the policy row was fetched alongside instead of afterwards.
    const [{ data: device }, { data: policy }] = await Promise.all([
      // The device must belong to the person consenting — nobody consents on
      // someone else's behalf.
      app.supabase.from("devices").select("id, company_id, profile_id").eq("id", deviceId).single(),
      app.supabase
        .from("policies")
        .select("version")
        .eq("company_id", session.companyId)
        .eq("version", policyVersion)
        .maybeSingle(),
    ]);

    if (!device || device.profile_id !== session.profileId) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Device does not belong to you", statusCode: 403 });
    }

    if (!policy) {
      return reply.code(400).send({
        error: "unknown_policy",
        message: `Policy version ${policyVersion} does not exist`,
        statusCode: 400,
      });
    }

    await supersedeConsent(app.supabase, session.companyId, deviceId, policyVersion, grantedTypes);

    const { data: consent, error } = await app.supabase
      .from("consent_records")
      .insert({
        company_id: session.companyId,
        profile_id: session.profileId,
        device_id: deviceId,
        policy_version: policyVersion,
        method,
        ip_address: request.ip,
        granted_types: grantedTypes ?? null,
      })
      .select("id")
      .single();

    if (error || !consent) {
      return reply
        .code(409)
        .send({ error: "consent_exists", message: error?.message ?? "Could not record consent", statusCode: 409 });
    }

    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "consent.granted",
        targetType: "device",
        targetId: deviceId,
        metadata: { policyVersion, method, grantedTypes: grantedTypes ?? null },
      },
      app.log,
    );

    return { consentId: consent.id };
  });

  /**
   * The same act, proven by the device token instead of a Supabase session.
   *
   * An agent enrolled with a sign-in code never holds a user session — that is the
   * point of the code. Without this route, code enrolment would produce a device that
   * can never record consent, and therefore can never legally collect anything.
   *
   * The device token already names the device, its company and its owner, and the API
   * re-reads that row on every request, so there is nothing here for a caller to
   * assert about who they are. That makes this narrower than the session route, not
   * wider: it can only ever consent for the one device presenting the token.
   */
  app.post("/consent/device", { preHandler: app.requireDevice }, async (request, reply) => {
    const parsed = deviceConsentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_body"));
    }

    const device = request.device!;
    const { policyVersion, method, grantedTypes } = parsed.data;

    const { data: policy } = await app.supabase
      .from("policies")
      .select("version")
      .eq("company_id", device.companyId)
      .eq("version", policyVersion)
      .maybeSingle();

    if (!policy) {
      return reply.code(400).send({
        error: "unknown_policy",
        message: `Policy version ${policyVersion} does not exist`,
        statusCode: 400,
      });
    }

    await supersedeConsent(
      app.supabase,
      device.companyId,
      device.deviceId,
      policyVersion,
      grantedTypes,
    );

    const { data: consent, error } = await app.supabase
      .from("consent_records")
      .insert({
        company_id: device.companyId,
        profile_id: device.profileId,
        device_id: device.deviceId,
        policy_version: policyVersion,
        method,
        ip_address: request.ip,
        granted_types: grantedTypes ?? null,
      })
      .select("id")
      .single();

    if (error || !consent) {
      return reply
        .code(409)
        .send({ error: "consent_exists", message: error?.message ?? "Could not record consent", statusCode: 409 });
    }

    await recordAudit(
      app.supabase,
      {
        companyId: device.companyId,
        actorId: device.profileId,
        action: "consent.granted",
        targetType: "device",
        targetId: device.deviceId,
        metadata: { policyVersion, method, via: "device_token", grantedTypes: grantedTypes ?? null },
      },
      app.log,
    );

    return { consentId: consent.id };
  });

  /** Withdrawing consent. Agents stop collecting on their next request. */
  app.post("/consent/:deviceId/revoke", { preHandler: app.requireUser }, async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const session = request.session!;

    // Scoped by company because the API holds the service-role key and therefore
    // bypasses RLS: without this filter the only ownership test below is
    // `profile_id !== session.profileId`, which a super admin is explicitly
    // allowed to skip. That combination let a super admin of ANY tenant revoke
    // another tenant's consent by supplying that device's uuid, and filed the
    // resulting `consent.revoked` audit entry under the wrong company.
    const { data: consent } = await app.supabase
      .from("consent_records")
      .select("id, profile_id")
      .eq("device_id", deviceId)
      .eq("company_id", session.companyId)
      .is("revoked_at", null)
      .maybeSingle();

    if (!consent) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "No active consent for this device", statusCode: 404 });
    }

    // Employees revoke their own; super admins may revoke on behalf of anyone.
    if (consent.profile_id !== session.profileId && session.role !== "super_admin") {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Not your consent record", statusCode: 403 });
    }

    await app.supabase
      .from("consent_records")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", consent.id);

    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "consent.revoked",
        targetType: "device",
        targetId: deviceId,
      },
      app.log,
    );

    return { ok: true };
  });
};
