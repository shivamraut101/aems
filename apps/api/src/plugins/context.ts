import { AuthError, bearerToken, isManager, isSuperAdmin, resolveSession, type SessionProfile } from "@aems/auth";
import { createAdminClient, type AemsSupabaseClient } from "@aems/supabase";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { Env } from "../env.js";
import { verifyDeviceToken } from "../lib/device-token.js";

/** The agent behind a request, once its device token has been checked against the database. */
export interface DeviceContext {
  deviceId: string;
  companyId: string;
  profileId: string;
}

declare module "fastify" {
  interface FastifyInstance {
    env: Env;
    supabase: AemsSupabaseClient;
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
      .select("id, company_id, profile_id, status, profiles!inner(monitoring_enabled)")
      .eq("id", payload.deviceId)
      .single();

    if (error || !device) {
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
    };
  });
};

export const contextPlugin = fp(plugin, { name: "aems-context" });

/**
 * Blocks collection until consent is on file.
 *
 * Called by every ingestion route. The agents also gate themselves, but an agent is
 * a binary on someone's laptop — the server is where the rule is actually enforced.
 */
export async function assertConsent(
  supabase: AemsSupabaseClient,
  deviceId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data, error } = await supabase
    .from("consent_records")
    .select("id")
    .eq("device_id", deviceId)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) {
    return { ok: false, message: "Could not verify consent" };
  }

  if (!data) {
    return { ok: false, message: "No active consent record for this device" };
  }

  return { ok: true };
}
