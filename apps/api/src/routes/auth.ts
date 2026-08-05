import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { recordAudit } from "../lib/audit.js";

const consentSchema = z.object({
  deviceId: z.string().uuid(),
  policyVersion: z.string().min(1),
  method: z.enum(["in_app_dialog", "onboarding_portal", "signed_document"]),
});

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
        .send({ error: "invalid_body", message: parsed.error.message, statusCode: 400 });
    }

    const session = request.session!;
    const { deviceId, policyVersion, method } = parsed.data;

    // The device must belong to the person consenting — nobody consents on
    // someone else's behalf.
    const { data: device } = await app.supabase
      .from("devices")
      .select("id, company_id, profile_id")
      .eq("id", deviceId)
      .single();

    if (!device || device.profile_id !== session.profileId) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Device does not belong to you", statusCode: 403 });
    }

    const { data: policy } = await app.supabase
      .from("policies")
      .select("version")
      .eq("company_id", session.companyId)
      .eq("version", policyVersion)
      .maybeSingle();

    if (!policy) {
      return reply.code(400).send({
        error: "unknown_policy",
        message: `Policy version ${policyVersion} does not exist`,
        statusCode: 400,
      });
    }

    const { data: consent, error } = await app.supabase
      .from("consent_records")
      .insert({
        company_id: session.companyId,
        profile_id: session.profileId,
        device_id: deviceId,
        policy_version: policyVersion,
        method,
        ip_address: request.ip,
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
        metadata: { policyVersion, method },
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
        .send({ error: "invalid_body", message: parsed.error.message, statusCode: 400 });
    }

    const device = request.device!;
    const { policyVersion, method } = parsed.data;

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

    const { data: consent, error } = await app.supabase
      .from("consent_records")
      .insert({
        company_id: device.companyId,
        profile_id: device.profileId,
        device_id: device.deviceId,
        policy_version: policyVersion,
        method,
        ip_address: request.ip,
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
        metadata: { policyVersion, method, via: "device_token" },
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
