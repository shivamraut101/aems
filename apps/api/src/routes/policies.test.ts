import type { SessionProfile } from "@aems/auth";
import type { AemsSupabaseClient } from "@aems/supabase";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";

import {
  SCREENSHOT_INTERVAL_SECONDS,
  nextPolicyVersion,
  policyDraftSchema,
  policyRoutes,
} from "./policies.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_COMPANY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const BOB = "22222222-2222-4222-8222-222222222222";
const ALICE = "11111111-1111-4111-8111-111111111111";

const admin: SessionProfile = { profileId: ADMIN, companyId: COMPANY, email: "a@x", role: "super_admin" };
const manager: SessionProfile = { profileId: BOB, companyId: COMPANY, email: "m@x", role: "manager" };
const alice: SessionProfile = { profileId: ALICE, companyId: COMPANY, email: "e@x", role: "employee" };

const DRAFT = {
  name: "Standard Monitoring Policy",
  screenshotIntervalSeconds: 300,
  idleThresholdSeconds: 120,
  trackedCategories: ["development", "communication"],
};

// --- recording Supabase stand-in (see devices.test.ts for the rationale) ----

interface Op {
  fn: string;
  args: unknown[];
}
interface Call {
  table: string;
  ops: Op[];
}
type Result = { data?: unknown; error?: unknown };

const CHAINABLE = ["select", "insert", "update", "upsert", "delete", "eq", "neq", "is", "in", "order", "limit"];

function fakeSupabase(results: Record<string, Result[]>) {
  const calls: Call[] = [];

  const from = (table: string): unknown => {
    const call: Call = { table, ops: [] };
    calls.push(call);
    const queue = results[table] ? [...results[table]] : [];
    results[table] = queue;

    const settle = () => {
      const next = queue.shift() ?? {};
      return { data: next.data ?? null, error: next.error ?? null };
    };

    const builder: Record<string, unknown> = {};
    for (const fn of CHAINABLE) {
      builder[fn] = (...args: unknown[]) => {
        call.ops.push({ fn, args });
        return builder;
      };
    }
    builder.single = () => Promise.resolve(settle());
    builder.maybeSingle = () => Promise.resolve(settle());
    builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(settle()).then(onFulfilled, onRejected);
    return builder;
  };

  return { client: { from } as unknown as AemsSupabaseClient, calls };
}

const forTable = (calls: Call[], table: string): Call[] => calls.filter((c) => c.table === table);

function hasEq(call: Call, column: string, value: unknown): boolean {
  return call.ops.some((op) => op.fn === "eq" && op.args[0] === column && op.args[1] === value);
}

function payloadOf(call: Call, fn: "update" | "insert"): Record<string, unknown> | undefined {
  return call.ops.find((op) => op.fn === fn)?.args[0] as Record<string, unknown> | undefined;
}

async function buildTestApp(opts: {
  supabase: AemsSupabaseClient;
  session?: SessionProfile;
}): Promise<FastifyInstance> {
  const app = Fastify();

  app.decorate("supabase", opts.supabase);
  app.decorate("env", { DEVICE_TOKEN_SECRET: "test-secret" } as Env);
  app.decorateRequest("session", undefined);
  app.decorateRequest("device", undefined);

  const guard =
    (allowed: SessionProfile["role"][]) => async (request: FastifyRequest, reply: FastifyReply) => {
      const session = opts.session;
      if (!session) {
        await reply.code(401).send({ error: "unauthorized", message: "no session", statusCode: 401 });
        return;
      }
      if (!allowed.includes(session.role)) {
        await reply.code(403).send({ error: "forbidden", message: "role", statusCode: 403 });
        return;
      }
      request.session = session;
    };

  app.decorate("requireUser", guard(["employee", "manager", "super_admin"]));
  app.decorate("requireManager", guard(["manager", "super_admin"]));
  app.decorate("requireSuperAdmin", guard(["super_admin"]));
  app.decorate("requireDevice", async () => {});

  await app.register(policyRoutes, { prefix: "/api/policies" });
  return app;
}

// ---------------------------------------------------------------------------

describe("nextPolicyVersion", () => {
  const august = new Date("2026-08-05T12:00:00Z");

  it("starts a company's first month at .1, matching the seed's 2026.08.1", () => {
    expect(nextPolicyVersion([], august)).toBe("2026.08.1");
  });

  it("zero-pads the month so versions sort as text", () => {
    expect(nextPolicyVersion([], new Date("2026-01-09T00:00:00Z"))).toBe("2026.01.1");
    expect(nextPolicyVersion([], new Date("2026-12-31T23:00:00Z"))).toBe("2026.12.1");
  });

  it("takes the highest suffix, not the count", () => {
    // A hand-written row or a deleted one must not make the next mint collide with a
    // version consent has already been recorded against.
    expect(nextPolicyVersion(["2026.08.1", "2026.08.7"], august)).toBe("2026.08.8");
    expect(nextPolicyVersion(["2026.08.9", "2026.08.10"], august)).toBe("2026.08.11");
  });

  it("ignores other months' series", () => {
    expect(nextPolicyVersion(["2026.07.4", "2025.08.9"], august)).toBe("2026.08.1");
  });

  it("ignores labels that are not in the scheme rather than parsing them to NaN", () => {
    // `Number("beta")` is NaN and NaN compares false against every bound, so an
    // unguarded parse silently keeps returning .1 and colliding forever.
    expect(nextPolicyVersion(["2026.08.beta", "2026.08.", "2026.08. 2", "2026.08.3"], august)).toBe(
      "2026.08.4",
    );
  });
});

describe("policyDraftSchema", () => {
  it("accepts each of the five intervals docs/scope.md §2.3 names", () => {
    for (const seconds of SCREENSHOT_INTERVAL_SECONDS) {
      const parsed = policyDraftSchema.safeParse({ ...DRAFT, screenshotIntervalSeconds: seconds });
      expect(parsed.success, `${seconds}s`).toBe(true);
    }
  });

  it("rejects an interval outside those five", () => {
    // The column check is only `>= 30`, so the database would take 47. No screen can
    // display or round-trip a sixth option.
    for (const seconds of [30, 47, 120, 3600]) {
      expect(
        policyDraftSchema.safeParse({ ...DRAFT, screenshotIntervalSeconds: seconds }).success,
        `${seconds}s`,
      ).toBe(false);
    }
  });

  it("keeps the idle threshold inside the column check and a sane ceiling", () => {
    expect(policyDraftSchema.safeParse({ ...DRAFT, idleThresholdSeconds: 29 }).success).toBe(false);
    expect(policyDraftSchema.safeParse({ ...DRAFT, idleThresholdSeconds: 30 }).success).toBe(true);
    // A day-long idle threshold is idle detection switched off while looking enabled.
    expect(policyDraftSchema.safeParse({ ...DRAFT, idleThresholdSeconds: 86_400 }).success).toBe(false);
  });

  it("keeps the forgotten-break limit inside the column check", () => {
    expect(policyDraftSchema.safeParse({ ...DRAFT, maxOpenBreakSeconds: 899 }).success).toBe(false);
    expect(policyDraftSchema.safeParse({ ...DRAFT, maxOpenBreakSeconds: 900 }).success).toBe(true);
    expect(policyDraftSchema.safeParse({ ...DRAFT, maxOpenBreakSeconds: 43_200 }).success).toBe(true);
    // Past 12 hours the limit can no longer catch the overnight case it exists for, so
    // it is the guard switched off while still reading as configured.
    expect(policyDraftSchema.safeParse({ ...DRAFT, maxOpenBreakSeconds: 43_201 }).success).toBe(
      false,
    );
  });

  /**
   * The default is not cosmetic. Absence has to resolve to the limit both agents
   * already enforce (and the column's own default, 10800) — resolving it to nothing
   * would let a policy publish with no forgotten-break guard at all, which is the
   * overnight-billing defect the field exists to prevent.
   */
  it("defaults the forgotten-break limit to the column default", () => {
    expect(policyDraftSchema.parse(DRAFT).maxOpenBreakSeconds).toBe(10_800);
  });

  it("defaults trackedCategories rather than demanding one", () => {
    const { name, screenshotIntervalSeconds, idleThresholdSeconds } = DRAFT;
    const parsed = policyDraftSchema.parse({ name, screenshotIntervalSeconds, idleThresholdSeconds });
    expect(parsed.trackedCategories).toEqual([]);
  });

  it("makes version optional but constrains it when supplied", () => {
    expect(policyDraftSchema.parse(DRAFT).version).toBeUndefined();
    expect(policyDraftSchema.safeParse({ ...DRAFT, version: "2026.09.1" }).success).toBe(true);
    // It is quoted back in consent records and audit metadata, so no slashes, spaces
    // or empty strings.
    for (const version of ["", "a b", "../etc", "v/1", "-lead"]) {
      expect(policyDraftSchema.safeParse({ ...DRAFT, version }).success, version).toBe(false);
    }
  });

  it("requires a name", () => {
    expect(policyDraftSchema.safeParse({ ...DRAFT, name: "" }).success).toBe(false);
    const withoutName: Record<string, unknown> = { ...DRAFT };
    delete withoutName.name;
    expect(policyDraftSchema.safeParse(withoutName).success).toBe(false);
  });
});

describe("GET /api/policies/current", () => {
  it("scopes to the caller's company", async () => {
    const { client, calls } = fakeSupabase({ policies: [{ data: { id: "p1", version: "2026.08.1" } }] });
    const app = await buildTestApp({ supabase: client, session: alice });
    const res = await app.inject({ method: "GET", url: "/api/policies/current" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: "2026.08.1" });
    expect(hasEq(forTable(calls, "policies")[0]!, "company_id", COMPANY)).toBe(true);
  });

  it("answers null, not 404, for a company that has not published one", async () => {
    // "No policy yet" is a real answer about an existing company; the settings screen
    // renders it as the setup prompt.
    const { client } = fakeSupabase({ policies: [{ data: null }] });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "GET", url: "/api/policies/current" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });

  it("is readable by an employee, because it states the terms they are monitored under", async () => {
    const { client } = fakeSupabase({ policies: [{ data: { id: "p1" } }] });
    const app = await buildTestApp({ supabase: client, session: alice });
    expect((await app.inject({ method: "GET", url: "/api/policies/current" })).statusCode).toBe(200);
  });
});

describe("POST /api/policies", () => {
  function publishable(existing: { version: string; created_at: string }[] = []) {
    return fakeSupabase({
      policies: [
        { data: existing },
        { data: { id: "new-policy", company_id: COMPANY, version: "2026.08.2", name: DRAFT.name } },
      ],
      audit_log_entries: [{}],
    });
  }

  it("is closed to managers and employees", async () => {
    // A policy change alters what every agent on the estate collects.
    for (const session of [manager, alice]) {
      const { client, calls } = fakeSupabase({});
      const app = await buildTestApp({ supabase: client, session });
      const res = await app.inject({ method: "POST", url: "/api/policies", payload: DRAFT });

      expect(res.statusCode, session.role).toBe(403);
      expect(calls).toHaveLength(0);
    }
  });

  it("is closed to an anonymous caller", async () => {
    const { client } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client });
    expect((await app.inject({ method: "POST", url: "/api/policies", payload: DRAFT })).statusCode).toBe(
      401,
    );
  });

  it("400s an invalid draft without touching the table", async () => {
    const { client, calls } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "POST",
      url: "/api/policies",
      payload: { ...DRAFT, screenshotIntervalSeconds: 47 },
    });

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("INSERTS a new version and never updates an existing row", async () => {
    // The whole point of the route. Editing a live policy in place leaves every
    // consent_records row pointing at a version whose terms changed underneath it —
    // the employee agreed to a 15-minute screenshot interval and is now on a
    // 1-minute one, with nothing in the record showing the difference.
    const { client, calls } = publishable([{ version: "2026.08.1", created_at: "2026-08-01T00:00:00Z" }]);
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "POST", url: "/api/policies", payload: DRAFT });

    expect(res.statusCode).toBe(201);

    const policyCalls = forTable(calls, "policies");
    expect(policyCalls.some((c) => c.ops.some((op) => op.fn === "update"))).toBe(false);
    expect(policyCalls.some((c) => c.ops.some((op) => op.fn === "upsert"))).toBe(false);

    expect(payloadOf(policyCalls[1]!, "insert")).toEqual({
      company_id: COMPANY,
      version: "2026.08.2",
      name: DRAFT.name,
      screenshot_interval_seconds: 300,
      idle_threshold_seconds: 120,
      // `DRAFT` omits it, so this is the schema default landing in the row — which is
      // the case that matters: a client written against the previous shape of this
      // route must still publish the limit both agents already enforce, not a null.
      max_open_break_seconds: 10800,
      tracked_categories: ["development", "communication"],
    });
  });

  it("stamps the insert with the caller's company and reads only that company's versions", async () => {
    // Both halves matter: reading another tenant's versions would leak them, and an
    // insert without company_id would land the policy nowhere.
    const { client, calls } = publishable();
    const app = await buildTestApp({ supabase: client, session: admin });
    await app.inject({ method: "POST", url: "/api/policies", payload: DRAFT });

    const [read, insert] = forTable(calls, "policies");
    expect(hasEq(read!, "company_id", COMPANY)).toBe(true);
    expect(payloadOf(insert!, "insert")).toMatchObject({ company_id: COMPANY });
  });

  it("honours an explicitly supplied version", async () => {
    const { client, calls } = publishable();
    const app = await buildTestApp({ supabase: client, session: admin });
    await app.inject({
      method: "POST",
      url: "/api/policies",
      payload: { ...DRAFT, version: "2027-Q1" },
    });

    expect(payloadOf(forTable(calls, "policies")[1]!, "insert")).toMatchObject({ version: "2027-Q1" });
  });

  it("409s a version this company already published, without writing", async () => {
    // Reusing a version is the in-place edit wearing a different hat.
    const { client, calls } = fakeSupabase({
      policies: [{ data: [{ version: "2026.08.1", created_at: "2026-08-01T00:00:00Z" }] }],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "POST",
      url: "/api/policies",
      payload: { ...DRAFT, version: "2026.08.1" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "version_exists" });
    expect(forTable(calls, "policies")).toHaveLength(1);
  });

  it("turns the unique-index race into a 409, not a 500", async () => {
    // Two admins publishing in the same instant: the loser must be told to retry, and a
    // retry mints the next number.
    const { client } = fakeSupabase({
      policies: [{ data: [] }, { error: { code: "23505", message: "duplicate key" } }],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "POST", url: "/api/policies", payload: DRAFT });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "version_exists" });
  });

  it("500s a write failure that is not a duplicate", async () => {
    const { client } = fakeSupabase({
      policies: [{ data: [] }, { error: { code: "08006", message: "connection failure" } }],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "POST", url: "/api/policies", payload: DRAFT });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "policy_write_failed" });
  });

  it("500s rather than guessing a version when the existing versions cannot be read", async () => {
    // Minting on top of an unknown set is how you collide with a version consent is
    // already recorded against.
    const { client, calls } = fakeSupabase({
      policies: [{ error: { message: "timeout" } }],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "POST", url: "/api/policies", payload: DRAFT });

    expect(res.statusCode).toBe(500);
    expect(forTable(calls, "policies")).toHaveLength(1);
  });

  it("records both the new and the previous version in the append-only log", async () => {
    // A policy change is one of the few writes where the value it replaced matters as
    // much as the new one.
    const { client, calls } = publishable([{ version: "2026.08.1", created_at: "2026-08-01T00:00:00Z" }]);
    const app = await buildTestApp({ supabase: client, session: admin });
    await app.inject({ method: "POST", url: "/api/policies", payload: DRAFT });

    expect(payloadOf(forTable(calls, "audit_log_entries")[0]!, "insert")).toMatchObject({
      company_id: COMPANY,
      actor_id: ADMIN,
      action: "policy.published",
      target_type: "policy",
      target_id: "new-policy",
      metadata: {
        version: "2026.08.2",
        previousVersion: "2026.08.1",
        screenshotIntervalSeconds: 300,
        idleThresholdSeconds: 120,
      },
    });
  });

  it("records previousVersion null for a company's very first policy", async () => {
    const { client, calls } = publishable();
    const app = await buildTestApp({ supabase: client, session: admin });
    await app.inject({ method: "POST", url: "/api/policies", payload: DRAFT });

    expect(payloadOf(forTable(calls, "audit_log_entries")[0]!, "insert")).toMatchObject({
      metadata: { previousVersion: null },
    });
  });

  it("files the audit entry under the caller's own company", async () => {
    const { client, calls } = publishable();
    const app = await buildTestApp({
      supabase: client,
      session: { ...admin, companyId: OTHER_COMPANY },
    });
    await app.inject({ method: "POST", url: "/api/policies", payload: DRAFT });

    expect(payloadOf(forTable(calls, "audit_log_entries")[0]!, "insert")).toMatchObject({
      company_id: OTHER_COMPANY,
    });
  });
});
