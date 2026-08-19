import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env.js";
import { issueDeviceToken } from "../lib/device-token.js";

/**
 * `contextPlugin` builds its own Supabase client, so the client is mocked rather than
 * injected. Only the one chain `requireDevice` uses needs to exist.
 */
const maybeSingle = vi.fn();

vi.mock("@aems/supabase", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle }),
      }),
    }),
  }),
}));

const { contextPlugin } = await import("./context.js");

const SECRET = "test-secret";
const DEVICE = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  profileId: "33333333-3333-4333-8333-333333333333",
  issuedAt: 0,
};

const ENROLLED_ROW = {
  id: DEVICE.deviceId,
  company_id: DEVICE.companyId,
  profile_id: DEVICE.profileId,
  platform: "windows",
  status: "active",
  profiles: { monitoring_enabled: true, deactivated_at: null },
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(contextPlugin, {
    env: {
      SUPABASE_URL: "http://supabase.test",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      DEVICE_TOKEN_SECRET: SECRET,
      CORS_ORIGIN: "http://dashboard.test",
    } as unknown as Env,
  });

  app.get("/probe", { preHandler: app.requireDevice }, async (request) => ({
    deviceId: request.device?.deviceId ?? null,
  }));

  await app.ready();
  return app;
}

async function probe(token: string): Promise<{ statusCode: number; body: { error?: string } }> {
  const app = await buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/probe",
    headers: { "x-device-token": token },
  });
  await app.close();
  return { statusCode: response.statusCode, body: response.json() };
}

beforeEach(() => {
  maybeSingle.mockReset();
});

describe("requireDevice", () => {
  it("admits a device the database returned", async () => {
    maybeSingle.mockResolvedValue({ data: ENROLLED_ROW, error: null });

    const { statusCode } = await probe(issueDeviceToken(DEVICE, SECRET));

    expect(statusCode).toBe(200);
  });

  it("401s a token whose device the database does not have", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });

    const { statusCode, body } = await probe(issueDeviceToken(DEVICE, SECRET));

    expect(statusCode).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  /**
   * The regression this file was written for. The database was unreachable, the lookup
   * failed, and answering 401 told every agent its enrolment was gone: the agent reads
   * any 401 as revocation, so it set `revoked`, discarded its journal and stopped
   * collecting. An outage must be a retry, not a fleet-wide clock-out with data loss.
   */
  it("503s — never 401s — when the device lookup itself fails", async () => {
    maybeSingle.mockResolvedValue({
      data: null,
      error: { message: "fetch failed", code: "", details: "", hint: "" },
    });

    const { statusCode, body } = await probe(issueDeviceToken(DEVICE, SECRET));

    expect(statusCode).toBe(503);
    expect(body.error).toBe("database_unavailable");
  });

  it("401s a token signed with the wrong secret", async () => {
    maybeSingle.mockResolvedValue({ data: ENROLLED_ROW, error: null });

    const { statusCode } = await probe(issueDeviceToken(DEVICE, "not-the-secret"));

    expect(statusCode).toBe(401);
  });

  it("403s a revoked device, which is what revocation actually looks like", async () => {
    maybeSingle.mockResolvedValue({
      data: { ...ENROLLED_ROW, status: "revoked" },
      error: null,
    });

    const { statusCode, body } = await probe(issueDeviceToken(DEVICE, SECRET));

    expect(statusCode).toBe(403);
    expect(body.error).toBe("device_revoked");
  });
});
