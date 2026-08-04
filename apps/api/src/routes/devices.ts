import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { recordAudit } from "../lib/audit.js";
import { issueDeviceToken } from "../lib/device-token.js";

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

  /** Device list for the dashboard. RLS is bypassed here, so filter by company. */
  app.get("/", { preHandler: app.requireUser }, async (request) => {
    const session = request.session!;

    let query = app.supabase
      .from("devices")
      .select("*")
      .eq("company_id", session.companyId)
      .order("last_seen_at", { ascending: false, nullsFirst: false });

    // Employees see only their own devices; managers see the whole company.
    if (session.role === "employee") {
      query = query.eq("profile_id", session.profileId);
    }

    const { data } = await query;
    return data ?? [];
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
