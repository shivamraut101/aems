import type { SessionProfile } from "@aems/auth";
import type { Json } from "@aems/types";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { recordAudit } from "../lib/audit.js";
import { issueDeviceToken } from "../lib/device-token.js";
import { assertConsent } from "../plugins/context.js";

const enrollSchema = z.object({
  platform: z.enum(["windows", "macos", "android"]),
  label: z.string().min(1).max(120),
  osVersion: z.string().max(120).default(""),
  agentVersion: z.string().max(60).default(""),
  deviceName: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  cpu: z.string().max(160).optional(),
  ramMb: z.number().int().positive().optional(),
  storageMb: z.number().int().positive().optional(),
});

const heartbeatSchema = z.object({
  deviceId: z.string().uuid(),
  workSessionId: z.number().int().nullish(),
});

const telemetrySchema = z.object({
  batteryLevel: z.number().int().min(0).max(100).nullish(),
  batteryCharging: z.boolean().nullish(),
  networkType: z.enum(["wifi", "cellular", "ethernet", "offline"]).nullish(),
  storageFreeMb: z.number().int().min(0).nullish(),
  screenActiveSeconds: z.number().int().min(0).nullish(),
});

const applicationsSchema = z.object({
  applications: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        version: z.string().max(60).nullish(),
        identifier: z.string().max(200).nullish(),
      }),
    )
    .max(2000),
});

/** `docs/scope.md` §4.2 "assign devices". A device always has an owner — see below. */
const reassignSchema = z.object({
  profileId: z.string().uuid(),
});

const telemetryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

/** A path parameter reaches Postgres as a uuid; a malformed one is a 400, not a 500. */
const deviceIdSchema = z.string().uuid();

/**
 * May this caller read this device's monitoring data?
 *
 * Phrased as "is the caller privileged" rather than "is the caller an employee" so a
 * role added to the schema later and forgotten here arrives with no rights instead of
 * a manager's. Everyone can always read their own device — non-negotiable #3.
 */
export function deviceReadDenial(
  device: { profile_id: string } | null | undefined,
  session: Pick<SessionProfile, "role" | "profileId">,
): { error: string; message: string; statusCode: number } | null {
  if (!device) {
    return { error: "not_found", message: "Device not found", statusCode: 404 };
  }

  const privileged = session.role === "manager" || session.role === "super_admin";
  if (!privileged && device.profile_id !== session.profileId) {
    return { error: "forbidden", message: "Not your device", statusCode: 403 };
  }

  return null;
}

export const deviceRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Enrolment. Runs under the employee's own Supabase session — the agent asks them
   * to sign in once, then trades that session for a device token it can use forever.
   */
  app.post("/enroll", { preHandler: app.requireUser }, async (request, reply) => {
    const parsed = enrollSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: parsed.error.message, statusCode: 400 });
    }

    const session = request.session!;
    const body = parsed.data;

    const { data: device, error } = await app.supabase
      .from("devices")
      .insert({
        company_id: session.companyId,
        profile_id: session.profileId,
        platform: body.platform,
        label: body.label,
        os_version: body.osVersion,
        agent_version: body.agentVersion,
        device_name: body.deviceName ?? body.label,
        model: body.model ?? null,
        cpu: body.cpu ?? null,
        ram_mb: body.ramMb ?? null,
        storage_mb: body.storageMb ?? null,
        status: "active",
      })
      .select("id")
      .single();

    if (error || !device) {
      return reply
        .code(500)
        .send({ error: "enroll_failed", message: error?.message ?? "Could not enrol device", statusCode: 500 });
    }

    const { data: policy } = await app.supabase
      .from("policies")
      .select("version, name, screenshot_interval_seconds, idle_threshold_seconds, tracked_categories")
      .eq("company_id", session.companyId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!policy) {
      return reply.code(409).send({
        error: "no_policy",
        message: "This company has no monitoring policy yet — an admin must create one first",
        statusCode: 409,
      });
    }

    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "device.enrolled",
        targetType: "device",
        targetId: device.id,
        metadata: { platform: body.platform, label: body.label },
      },
      app.log,
    );

    return {
      deviceId: device.id,
      companyId: session.companyId,
      profileId: session.profileId,
      deviceToken: issueDeviceToken(
        {
          deviceId: device.id,
          companyId: session.companyId,
          profileId: session.profileId,
          issuedAt: Date.now(),
        },
        app.env.DEVICE_TOKEN_SECRET,
      ),
      // Freshly enrolled devices always need consent before collecting anything.
      consentRequired: true,
      policy: {
        version: policy.version,
        name: policy.name,
        screenshotIntervalSeconds: policy.screenshot_interval_seconds,
        idleThresholdSeconds: policy.idle_threshold_seconds,
        trackedCategories: policy.tracked_categories,
      },
    };
  });

  /**
   * Device list for the dashboard. RLS is bypassed here, so filter by company.
   *
   * Each row carries its newest `device_telemetry` sample as `telemetry`. Battery,
   * network, storage and screen-active time are named by `docs/scope.md` §3.3 and §7,
   * and until this embed existed the agents wrote all five into a table that no route
   * read back — collected, stored, and invisible.
   *
   * The embed is limited *per parent* (PostgREST's top-N-per-parent), so this stays one
   * round trip and one row of telemetry per device rather than the whole series.
   */
  app.get("/", { preHandler: app.requireUser }, async (request) => {
    const session = request.session!;

    let query = app.supabase
      .from("devices")
      .select(
        "*, device_telemetry(recorded_at, battery_level, battery_charging, network_type, storage_free_mb, screen_active_seconds)",
      )
      .eq("company_id", session.companyId)
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .order("recorded_at", { referencedTable: "device_telemetry", ascending: false })
      .limit(1, { referencedTable: "device_telemetry" });

    // Employees see only their own devices; managers and admins see the company.
    // Same fail-closed phrasing as `deviceReadDenial`: an unrecognised role must not
    // inherit the whole estate because it happens not to equal "employee".
    if (session.role !== "manager" && session.role !== "super_admin") {
      query = query.eq("profile_id", session.profileId);
    }

    const { data } = await query;

    // Flatten the embed: a one-element array called `device_telemetry` is a PostgREST
    // artefact, not a shape any consumer should have to know about.
    return (data ?? []).map(({ device_telemetry, ...device }) => ({
      ...device,
      telemetry: (Array.isArray(device_telemetry) ? device_telemetry[0] : device_telemetry) ?? null,
    }));
  });

  /** Keeps `last_seen_at` fresh — this is what drives online/idle/offline in the UI. */
  app.post("/heartbeat", { preHandler: app.requireDevice }, async (request, reply) => {
    const parsed = heartbeatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: parsed.error.message, statusCode: 400 });
    }

    const device = request.device!;
    if (parsed.data.deviceId !== device.deviceId) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Token does not match device", statusCode: 403 });
    }

    await app.supabase
      .from("devices")
      .update({ last_seen_at: new Date().toISOString(), status: "active" })
      .eq("id", device.deviceId);

    return { ok: true as const };
  });

  /** Battery, network, storage, screen time. Append-only series. */
  app.post("/telemetry", { preHandler: app.requireDevice }, async (request, reply) => {
    const parsed = telemetrySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: parsed.error.message, statusCode: 400 });
    }

    const device = request.device!;

    // Battery, network and screen-active time are collected data, not liveness —
    // the same consent gate as /activity and /screenshots applies. Only
    // /heartbeat is exempt, because it carries no observation and is the channel
    // through which a revoked agent finds out it has been revoked.
    const consent = await assertConsent(app.supabase, device.deviceId);
    if (!consent.ok) {
      return reply
        .code(403)
        .send({ error: "consent_required", message: consent.message, statusCode: 403 });
    }

    const body = parsed.data;

    const { error } = await app.supabase.from("device_telemetry").insert({
      company_id: device.companyId,
      device_id: device.deviceId,
      battery_level: body.batteryLevel ?? null,
      battery_charging: body.batteryCharging ?? null,
      network_type: body.networkType ?? null,
      storage_free_mb: body.storageFreeMb ?? null,
      screen_active_seconds: body.screenActiveSeconds ?? null,
    });

    if (error) {
      return reply
        .code(500)
        .send({ error: "telemetry_failed", message: error.message, statusCode: 500 });
    }

    return { ok: true as const };
  });

  /** Installed application inventory. Upserted so repeat scans just bump last_seen_at. */
  app.post("/applications", { preHandler: app.requireDevice }, async (request, reply) => {
    const parsed = applicationsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: parsed.error.message, statusCode: 400 });
    }

    const device = request.device!;

    // The list of software on someone's machine is monitoring data. Enrolment
    // reports inventory before consent is accepted, so without this gate a
    // device that never consented — or whose consent was withdrawn — would still
    // hand over its installed-application list.
    const consent = await assertConsent(app.supabase, device.deviceId);
    if (!consent.ok) {
      return reply
        .code(403)
        .send({ error: "consent_required", message: consent.message, statusCode: 403 });
    }

    const now = new Date().toISOString();

    const rows = parsed.data.applications.map((application) => ({
      company_id: device.companyId,
      device_id: device.deviceId,
      name: application.name,
      version: application.version ?? null,
      identifier: application.identifier ?? null,
      last_seen_at: now,
    }));

    if (rows.length === 0) return { upserted: 0 };

    const { error } = await app.supabase
      .from("device_applications")
      .upsert(rows, { onConflict: "device_id,name" });

    if (error) {
      return reply
        .code(500)
        .send({ error: "inventory_failed", message: error.message, statusCode: 500 });
    }

    return { upserted: rows.length };
  });

  /**
   * `docs/scope.md` §4.2 "assign devices" — hand a laptop to somebody else.
   *
   * `devices.profile_id` was written exactly once, at enrolment, from the enrolling
   * employee's own session. A machine changing hands therefore could not be moved
   * through the product at all.
   *
   * **Reassignment revokes the outgoing owner's consent.** Consent is per person per
   * device (`consent_records` is unique on `device_id` where `revoked_at is null`), and
   * `assertConsent` only asks whether the *device* has a live record. Move the device
   * without revoking and the new owner is collected against the previous owner's
   * agreement — non-negotiable #1 — and could not consent for themselves anyway,
   * because the unique index already holds a live row. The new owner re-consents
   * through the agent's normal first-run flow.
   *
   * The revoke runs *before* the reassignment on purpose. If the second write fails,
   * the device is left assigned to its old owner with consent withdrawn: it stops
   * collecting. The other order fails towards collecting without consent.
   *
   * There is no "unassign": `devices.profile_id` is `not null`, and a device nobody is
   * responsible for is what `POST /:deviceId/revoke` is for.
   */
  app.patch("/:deviceId", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    if (!deviceIdSchema.safeParse(deviceId).success) {
      return reply
        .code(400)
        .send({ error: "invalid_device_id", message: "deviceId must be a uuid", statusCode: 400 });
    }

    const parsed = reassignSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", message: parsed.error.message, statusCode: 400 });
    }

    const session = request.session!;
    const { profileId } = parsed.data;

    // The new owner must be in the caller's own company. Without this an admin who
    // learns a profile uuid could bind one tenant's hardware to another tenant's
    // employee, and every event that device sends afterwards lands on that person.
    const { data: target } = await app.supabase
      .from("profiles")
      .select("id, full_name, deactivated_at")
      .eq("id", profileId)
      .eq("company_id", session.companyId)
      .maybeSingle();

    if (!target) {
      return reply.code(400).send({
        error: "unknown_profile",
        message: "That employee is not in your company",
        statusCode: 400,
      });
    }

    // Handing hardware to someone who has been off-boarded. The device would show
    // in the inventory under a person the roster no longer lists, and it survived
    // only because ingestion refuses it separately — the assignment itself was
    // still accepted, which is a record nobody can act on.
    if (target.deactivated_at !== null) {
      return reply.code(400).send({
        error: "profile_deactivated",
        message: "That employee has been deactivated",
        statusCode: 400,
      });
    }

    const { data: device } = await app.supabase
      .from("devices")
      .select("*")
      .eq("id", deviceId)
      .eq("company_id", session.companyId)
      .maybeSingle();

    if (!device) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "Device not found", statusCode: 404 });
    }

    // Already theirs. Returning early rather than rewriting the row keeps a double
    // click from revoking a perfectly good consent record and forcing a re-prompt.
    if (device.profile_id === profileId) {
      return { ...device, consent_revoked: false };
    }

    const previousProfileId = device.profile_id;

    const { data: revoked, error: revokeError } = await app.supabase
      .from("consent_records")
      .update({ revoked_at: new Date().toISOString() })
      .eq("device_id", deviceId)
      .eq("company_id", session.companyId)
      .is("revoked_at", null)
      .select("id");

    if (revokeError) {
      return reply.code(500).send({
        error: "reassign_failed",
        message: "Could not withdraw the previous owner's consent, so the device was not reassigned",
        statusCode: 500,
      });
    }

    const consentRevoked = (revoked ?? []).length > 0;

    const { data: updated, error } = await app.supabase
      .from("devices")
      .update({ profile_id: profileId })
      .eq("id", deviceId)
      .eq("company_id", session.companyId)
      .select("*")
      .maybeSingle();

    if (error || !updated) {
      return reply.code(500).send({
        error: "reassign_failed",
        message: error?.message ?? "Could not reassign device",
        statusCode: 500,
      });
    }

    // Two entries, because two things happened. Collapsing them would hide a consent
    // withdrawal inside a device event, and the consent trail is the one an auditor reads.
    if (consentRevoked) {
      await recordAudit(
        app.supabase,
        {
          companyId: session.companyId,
          actorId: session.profileId,
          action: "consent.revoked",
          targetType: "device",
          targetId: deviceId,
          metadata: { reason: "device_reassigned", profileId: previousProfileId } as Json,
        },
        app.log,
      );
    }

    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "device.reassigned",
        targetType: "device",
        targetId: deviceId,
        metadata: {
          fromProfileId: previousProfileId,
          toProfileId: profileId,
          consentRevoked,
        } as Json,
      },
      app.log,
    );

    // `consent_revoked` tells the dashboard to say "this device will not collect again
    // until its new owner accepts the policy" instead of implying the move was silent.
    return { ...updated, consent_revoked: consentRevoked };
  });

  /**
   * Installed application inventory for one device — `docs/scope.md` §7.
   *
   * `POST /applications` has been upserting this table since enrolment shipped and
   * nothing ever selected it back, so the inventory existed only in the database.
   */
  app.get("/:deviceId/applications", { preHandler: app.requireUser }, async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    if (!deviceIdSchema.safeParse(deviceId).success) {
      return reply
        .code(400)
        .send({ error: "invalid_device_id", message: "deviceId must be a uuid", statusCode: 400 });
    }

    const session = request.session!;

    // Company-scoped: this read is the tenant boundary, because the service-role key
    // has already bypassed RLS by the time the query runs.
    const { data: device } = await app.supabase
      .from("devices")
      .select("id, profile_id")
      .eq("id", deviceId)
      .eq("company_id", session.companyId)
      .maybeSingle();

    const denial = deviceReadDenial(device, session);
    if (denial) return reply.code(denial.statusCode).send(denial);

    const { data } = await app.supabase
      .from("device_applications")
      .select("id, name, version, identifier, first_seen_at, last_seen_at")
      .eq("device_id", deviceId)
      .eq("company_id", session.companyId)
      .order("name");

    return data ?? [];
  });

  /**
   * Telemetry series for one device — battery, network, storage, screen-active time.
   *
   * `GET /` carries the newest sample for the whole estate; this is the history behind
   * one row, for the device detail panel.
   */
  app.get("/:deviceId/telemetry", { preHandler: app.requireUser }, async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    if (!deviceIdSchema.safeParse(deviceId).success) {
      return reply
        .code(400)
        .send({ error: "invalid_device_id", message: "deviceId must be a uuid", statusCode: 400 });
    }

    const parsedQuery = telemetryQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: "invalid_query", message: parsedQuery.error.message, statusCode: 400 });
    }

    const session = request.session!;

    const { data: device } = await app.supabase
      .from("devices")
      .select("id, profile_id")
      .eq("id", deviceId)
      .eq("company_id", session.companyId)
      .maybeSingle();

    const denial = deviceReadDenial(device, session);
    if (denial) return reply.code(denial.statusCode).send(denial);

    const { data } = await app.supabase
      .from("device_telemetry")
      .select(
        "id, recorded_at, battery_level, battery_charging, network_type, storage_free_mb, screen_active_seconds",
      )
      .eq("device_id", deviceId)
      .eq("company_id", session.companyId)
      .order("recorded_at", { ascending: false })
      .limit(parsedQuery.data.limit);

    const samples = data ?? [];
    return { latest: samples[0] ?? null, samples };
  });

  /** Revoking a device stops it collecting on its very next request. */
  app.post("/:deviceId/revoke", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const session = request.session!;

    const { data, error } = await app.supabase
      .from("devices")
      .update({ status: "revoked" })
      .eq("id", deviceId)
      .eq("company_id", session.companyId)
      .select("id")
      .maybeSingle();

    if (error || !data) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "Device not found", statusCode: 404 });
    }

    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "device.revoked",
        targetType: "device",
        targetId: deviceId,
      },
      app.log,
    );

    return { ok: true as const };
  });
};
