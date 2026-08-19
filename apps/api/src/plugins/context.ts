import { AuthError, bearerToken, isManager, isSuperAdmin, resolveSession, type SessionProfile } from "@aems/auth";
import { createAdminClient, type AemsSupabaseClient } from "@aems/supabase";
import { effectiveTypes, type DataTypeId, type DevicePlatform } from "@aems/types";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { Env } from "../env.js";
import { verifyDeviceToken } from "../lib/device-token.js";
import { createMailer, type Mailer } from "../lib/email/mailer.js";

/** The agent behind a request, once its device token has been checked against the database. */
export interface DeviceContext {
  deviceId: string;
  companyId: string;
  profileId: string;
  /**
   * Carried because what a device may collect starts with what its hardware can do.
   * Without it the ingest routes cannot tell a laptop from a phone, which is how a
   * desktop token was able to write `location_points` that no screen ever showed.
   */
  platform: DevicePlatform;
}

declare module "fastify" {
  interface FastifyInstance {
    env: Env;
    supabase: AemsSupabaseClient;
    /** Outbound mail. Never throws and never blocks — see `lib/email/mailer.ts`. */
    mailer: Mailer;
    /** The dashboard origin a link in an email points at, with no trailing slash. */
    dashboardUrl: string;
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireManager: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireSuperAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireDevice: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    session?: SessionProfile;
    device?: DeviceContext;
  }
}

const plugin: FastifyPluginAsync<{ env: Env }> = async (app, opts) => {
  const supabase = createAdminClient({
    url: opts.env.SUPABASE_URL,
    anonKey: opts.env.SUPABASE_ANON_KEY,
    serviceRoleKey: opts.env.SUPABASE_SERVICE_ROLE_KEY,
  });

  app.decorate("env", opts.env);
  app.decorate("supabase", supabase);
  app.decorate("mailer", createMailer(opts.env, app.log));
  // CORS_ORIGIN may hold several origins; a link in an email needs exactly one. The
  // first is the canonical dashboard in every deployment shape this has had, and
  // DASHBOARD_URL overrides it for the one where it is not.
  app.decorate(
    "dashboardUrl",
    (opts.env.DASHBOARD_URL ?? opts.env.CORS_ORIGIN.split(",")[0] ?? "").trim().replace(/\/+$/, ""),
  );
  app.decorateRequest("session", undefined);
  app.decorateRequest("device", undefined);

  app.decorate("requireUser", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      return reply.code(401).send({ error: "unauthorized", message: "Missing bearer token", statusCode: 401 });
    }

    try {
      request.session = await resolveSession(token, supabase);
    } catch (err) {
      const status = err instanceof AuthError ? err.statusCode : 401;
      const message = err instanceof Error ? err.message : "Authentication failed";
      return reply.code(status).send({ error: "unauthorized", message, statusCode: status });
    }
  });

  app.decorate("requireManager", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.requireUser(request, reply);
    if (reply.sent) return;

    if (!request.session || !isManager(request.session.role)) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Manager role required", statusCode: 403 });
    }
  });

  app.decorate("requireSuperAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.requireUser(request, reply);
    if (reply.sent) return;

    if (!request.session || !isSuperAdmin(request.session.role)) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Super admin role required", statusCode: 403 });
    }
  });

  /**
   * Authenticates an agent.
   *
   * A valid signature is not enough. Every request re-reads the device row so a
   * revoked device, a disabled employee, or withdrawn consent takes effect at once
   * rather than whenever the token happens to expire.
   */
  app.decorate("requireDevice", async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers["x-device-token"];
    const token = Array.isArray(header) ? header[0] : header;

    if (!token) {
      return reply
        .code(401)
        .send({ error: "unauthorized", message: "Missing device token", statusCode: 401 });
    }

    const payload = verifyDeviceToken(token, opts.env.DEVICE_TOKEN_SECRET);
    if (!payload) {
      return reply
        .code(401)
        .send({ error: "unauthorized", message: "Invalid device token", statusCode: 401 });
    }

    const { data: device, error } = await supabase
      .from("devices")
      .select(
        "id, company_id, profile_id, platform, status, profiles!inner(monitoring_enabled, deactivated_at)",
      )
      .eq("id", payload.deviceId)
      .maybeSingle();

    // A failed query and an unknown device are not the same answer, and collapsing
    // them cost a fleet its buffered work: when the database was unreachable this
    // replied 401, the agent classifies any 401 as revocation, and every agent
    // discarded its journal and stopped collecting. `maybeSingle` reports no rows as
    // `data: null` with no error, so `error` here is only ever infrastructure —
    // answered 503 so it classifies as a retry and the buffer survives the outage.
    if (error) {
      request.log.error({ err: error, deviceId: payload.deviceId }, "Device lookup failed");
      return reply.code(503).send({
        error: "database_unavailable",
        message: "Could not verify this device right now",
        statusCode: 503,
      });
    }

    if (!device) {
      return reply
        .code(401)
        .send({ error: "unauthorized", message: "Device is not enrolled", statusCode: 401 });
    }

    if (device.status === "revoked") {
      return reply
        .code(403)
        .send({ error: "device_revoked", message: "This device has been revoked", statusCode: 403 });
    }

    // Supabase types an !inner join as an array or an object depending on the
    // relationship it infers; normalise before reading.
    const profile = Array.isArray(device.profiles) ? device.profiles[0] : device.profiles;

    // Off-boarded people stop being collected from, whatever the monitoring flag
    // says. Deactivating an employee happens to set `monitoring_enabled = false`
    // as well, which made this look covered — but that flag is independently
    // writable through PATCH /api/employees/:id, so a single unrelated toggle
    // silently resumed collection on an off-boarded person's device. Checked
    // before the monitoring flag so the 403 names the real reason.
    if (profile && profile.deactivated_at !== null) {
      return reply.code(403).send({
        error: "employee_deactivated",
        message: "This employee has been deactivated",
        statusCode: 403,
      });
    }

    if (profile && profile.monitoring_enabled === false) {
      return reply.code(403).send({
        error: "monitoring_disabled",
        message: "Monitoring is disabled for this employee",
        statusCode: 403,
      });
    }

    request.device = {
      deviceId: device.id,
      companyId: device.company_id,
      profileId: device.profile_id,
      platform: device.platform,
    };
  });
};

export const contextPlugin = fp(plugin, { name: "aems-context" });

/**
 * The types an admin has switched off for this device. `null` means the read failed.
 *
 * A deny list: a type with no row is permitted. That is what lets an existing device —
 * every device, today, since the table is empty — keep behaving exactly as it did.
 */
export async function deniedTypesFor(
  supabase: AemsSupabaseClient,
  deviceId: string,
): Promise<DataTypeId[] | null> {
  const { data, error } = await supabase
    .from("device_collection_settings")
    .select("data_type, enabled")
    .eq("device_id", deviceId);

  if (error) return null;
  return (data ?? []).filter((row) => !row.enabled).map((row) => row.data_type);
}

/**
 * Blocks collection until consent is on file, and says what that consent covers.
 *
 * Called by every ingestion route. The agents also gate themselves, but an agent is
 * a binary on someone's laptop — the server is where the rule is actually enforced.
 *
 * This replaced `assertConsent` rather than sitting beside it, deliberately: six call
 * sites each needing two calls is twelve places to forget one, and the thing forgotten
 * would be a data type collected against a consent that excluded it. Deleting the old
 * name made the compiler enumerate every caller.
 *
 * `types` is the intersection of three sets — what the platform can do, minus what an
 * admin switched off, intersected with what the employee agreed to. Most restrictive
 * wins in every direction, and a `granted_types` of null (every consent signed before
 * per-type consent existed) narrows nothing.
 */
export async function resolveCollection(
  supabase: AemsSupabaseClient,
  device: DeviceContext,
): Promise<
  | { ok: true; types: Set<DataTypeId>; grantedTypes: DataTypeId[] | null }
  | { ok: false; message: string }
> {
  const [consent, denied] = await Promise.all([
    supabase
      .from("consent_records")
      .select("id, granted_types")
      .eq("device_id", device.deviceId)
      .is("revoked_at", null)
      .maybeSingle(),
    deniedTypesFor(supabase, device.deviceId),
  ]);

  if (consent.error) {
    return { ok: false, message: "Could not verify consent" };
  }

  if (!consent.data) {
    return { ok: false, message: "No active consent record for this device" };
  }

  // Fail closed. A settings read that failed cannot prove a type was *not* switched
  // off, and guessing "permitted" here collects something an admin turned off.
  if (denied === null) {
    return { ok: false, message: "Could not verify what this device may collect" };
  }

  const grantedTypes = consent.data.granted_types ?? null;

  return {
    ok: true,
    types: new Set(effectiveTypes(device.platform, denied, grantedTypes)),
    grantedTypes,
  };
}

/**
 * The refusal an ingest route sends when consent exists but this type is switched off.
 *
 * Distinct from `consent_required` on purpose: one says "nobody agreed", the other says
 * "somebody decided". An agent that conflated them would route a person to a consent
 * screen over a decision their administrator made, which they cannot fix by agreeing.
 */
export function collectionDenial(type: DataTypeId) {
  return {
    error: "collection_disabled",
    message: `This device is not permitted to collect ${type}`,
    statusCode: 403,
  } as const;
}
