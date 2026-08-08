import type { SessionProfile } from "@aems/auth";
import type { AemsSupabaseClient } from "@aems/supabase";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";

import { deviceReadDenial, deviceRoutes } from "./devices.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_COMPANY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";

const admin: SessionProfile = { profileId: ADMIN, companyId: COMPANY, email: "a@x", role: "super_admin" };
const manager: SessionProfile = { profileId: BOB, companyId: COMPANY, email: "m@x", role: "manager" };
const alice: SessionProfile = { profileId: ALICE, companyId: COMPANY, email: "e@x", role: "employee" };

// ---------------------------------------------------------------------------
// A Supabase stand-in that RECORDS the query it was asked to build.
//
// The property under test on every one of these routes is `.eq("company_id", ...)`.
// It is invisible to tsc (table and column names are strings), invisible to a
// snapshot of the response, and the reason a cross-tenant read looks exactly like a
// working one. So the fake asserts on the chain, not just on what it returns.
// ---------------------------------------------------------------------------

interface Op {
  fn: string;
  args: unknown[];
}
interface Call {
  table: string;
  ops: Op[];
}
type Result = { data?: unknown; error?: unknown };

const CHAINABLE = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "is",
  "in",
  "gte",
  "lte",
  "order",
  "limit",
  // Rank visibility filters the roster with these two.
  "not",
  "or",
];

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

const tables = (calls: Call[]): string[] => calls.map((c) => c.table);
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

  await app.register(deviceRoutes, { prefix: "/api/devices" });
  return app;
}

// ---------------------------------------------------------------------------

describe("deviceReadDenial", () => {
  it("404s a device the company query did not return", () => {
    // The caller's tenant filter has already run; "not in your company" and "does not
    // exist" must be the same answer, or the 403/404 split enumerates other tenants.
    expect(deviceReadDenial(null, admin)?.statusCode).toBe(404);
    expect(deviceReadDenial(undefined, alice)?.statusCode).toBe(404);
  });

  it("lets an employee read their own device", () => {
    // Non-negotiable #3. An employee who cannot see their own device inventory is a
    // compliance failure, not a tightening.
    expect(deviceReadDenial({ profile_id: ALICE }, alice)).toBeNull();
  });

  it("refuses an employee someone else's device", () => {
    const denial = deviceReadDenial({ profile_id: BOB }, alice);
    expect(denial?.statusCode).toBe(403);
    expect(denial?.message).toBe("Not your device");
  });

  it("lets a manager and an admin read anyone's device", () => {
    for (const session of [manager, admin]) {
      expect(deviceReadDenial({ profile_id: ALICE }, session)).toBeNull();
    }
  });

  it("treats a role it does not recognise as unprivileged", () => {
    // Fail closed. A role added to the schema later and forgotten here must arrive with
    // no rights, not with a manager's. Written as "is the caller privileged" rather
    // than "is the caller an employee" precisely so this holds.
    const future = { role: "auditor" as SessionProfile["role"], profileId: ALICE };

    expect(deviceReadDenial({ profile_id: BOB }, future)?.statusCode).toBe(403);
    expect(deviceReadDenial({ profile_id: ALICE }, future)).toBeNull();
  });
});

describe("GET /api/devices", () => {
  it("scopes to the caller's company and flattens the newest telemetry sample", async () => {
    const { client, calls } = fakeSupabase({
      profiles: [{ data: [] }],
      devices: [
        {
          data: [
            {
              id: DEVICE,
              profile_id: ALICE,
              label: "Alice Laptop",
              device_telemetry: [{ recorded_at: "2026-08-05T10:00:00Z", battery_level: 71 }],
            },
          ],
        },
      ],
    });

    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({ method: "GET", url: "/api/devices" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { telemetry: { battery_level: number } | null; device_telemetry?: unknown }[];

    expect(body[0]!.telemetry?.battery_level).toBe(71);
    // The PostgREST array is an artefact of the embed; no consumer should see it.
    expect(body[0]!.device_telemetry).toBeUndefined();
    expect(hasEq(forTable(calls, "devices")[0]!, "company_id", COMPANY)).toBe(true);
  });

  it("returns telemetry null when a device has never reported any", async () => {
    const { client } = fakeSupabase({
      profiles: [{ data: [] }],
      devices: [{ data: [{ id: DEVICE, profile_id: ALICE, device_telemetry: [] }] }],
    });

    const app = await buildTestApp({ supabase: client, session: manager });
    const body = (await app.inject({ method: "GET", url: "/api/devices" })).json() as {
      telemetry: unknown;
    }[];

    // An empty embed must not become `undefined` or a bare `[]` — the dashboard reads
    // `telemetry === null` to decide between "no data yet" and a battery reading.
    expect(body[0]!.telemetry).toBeNull();
  });

  it("narrows an employee to their own devices", async () => {
    const { client, calls } = fakeSupabase({ devices: [{ data: [] }] });
    const app = await buildTestApp({ supabase: client, session: alice });
    await app.inject({ method: "GET", url: "/api/devices" });

    expect(hasEq(forTable(calls, "devices")[0]!, "profile_id", ALICE)).toBe(true);
  });

  it("does not narrow a manager", async () => {
    const { client, calls } = fakeSupabase({ devices: [{ data: [] }] });
    const app = await buildTestApp({ supabase: client, session: manager });
    await app.inject({ method: "GET", url: "/api/devices" });

    const ops = forTable(calls, "devices")[0]!.ops;
    expect(ops.some((op) => op.fn === "eq" && op.args[0] === "profile_id")).toBe(false);
  });
});

describe("PATCH /api/devices/:deviceId — reassignment", () => {
  /** Target profile lookup, device lookup, consent revoke, device update. */
  function happyPath() {
    return fakeSupabase({
      profiles: [{ data: { id: BOB, full_name: "Bob", deactivated_at: null } }],
      devices: [
        { data: { id: DEVICE, profile_id: ALICE, label: "Laptop" } },
        { data: { id: DEVICE, profile_id: BOB, label: "Laptop" } },
      ],
      consent_records: [{ data: [{ id: "consent-1" }] }],
      audit_log_entries: [{}, {}],
    });
  }

  it("is closed to managers and employees", async () => {
    for (const session of [manager, alice]) {
      const { client, calls } = fakeSupabase({});
      const app = await buildTestApp({ supabase: client, session });
      const res = await app.inject({
        method: "PATCH",
        url: `/api/devices/${DEVICE}`,
        payload: { profileId: BOB },
      });

      expect(res.statusCode, session.role).toBe(403);
      // Refused before any query ran — not refused after reading the row.
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses to hand a device to an off-boarded employee", async () => {
    // Reassignment is the one path that can point a LIVE device at a deactivated
    // profile: `DELETE /api/employees/:id` revokes that person's own devices, but
    // it cannot revoke one they had not been given yet. Without this the device
    // stayed active under someone the roster no longer lists, and only the
    // ingestion guard stopped it collecting.
    const { client, calls } = fakeSupabase({
      profiles: [{ data: { id: BOB, full_name: "Bob", deactivated_at: "2026-08-05T00:00:00Z" } }],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${DEVICE}`,
      payload: { profileId: BOB },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("profile_deactivated");
    // Refused after the profile lookup and before the device was ever touched.
    expect(calls).toHaveLength(1);
  });

  it("rejects a deviceId that is not a uuid before it reaches Postgres", async () => {
    const { client, calls } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/devices/not-a-uuid",
      payload: { profileId: BOB },
    });

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a body without a valid profileId", async () => {
    for (const payload of [{}, { profileId: "nobody" }, { profileId: null }]) {
      const { client } = fakeSupabase({});
      const app = await buildTestApp({ supabase: client, session: admin });
      const res = await app.inject({ method: "PATCH", url: `/api/devices/${DEVICE}`, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("refuses a target profile that is not in the caller's company", async () => {
    // The cross-tenant attack this route would otherwise open: an admin who learns a
    // uuid binds their hardware — and every event it sends — to another tenant's person.
    const { client, calls } = fakeSupabase({ profiles: [{ data: null }] });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${DEVICE}`,
      payload: { profileId: BOB },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "unknown_profile" });
    expect(hasEq(forTable(calls, "profiles")[0]!, "company_id", COMPANY)).toBe(true);
    // Nothing was written.
    expect(tables(calls)).toEqual(["profiles"]);
  });

  it("404s a device outside the caller's company and writes nothing", async () => {
    const { client, calls } = fakeSupabase({
      profiles: [{ data: { id: BOB, full_name: "Bob", deactivated_at: null } }],
      devices: [{ data: null }],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${DEVICE}`,
      payload: { profileId: BOB },
    });

    expect(res.statusCode).toBe(404);
    expect(hasEq(forTable(calls, "devices")[0]!, "company_id", COMPANY)).toBe(true);
    expect(tables(calls)).toEqual(["profiles", "devices"]);
  });

  it("revokes the outgoing owner's consent BEFORE reassigning", async () => {
    // Consent is per person per device, and `assertConsent` only asks whether the
    // device has a live record. Moving the device without revoking would collect the
    // new owner against the previous owner's agreement (non-negotiable #1), and the
    // partial unique index on consent_records would block them consenting for
    // themselves. Order matters too: if the second write fails the device must be left
    // NOT collecting, so the revoke goes first.
    const { client, calls } = happyPath();
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${DEVICE}`,
      payload: { profileId: BOB },
    });

    expect(res.statusCode).toBe(200);
    expect(tables(calls)).toEqual([
      "profiles",
      "devices",
      "consent_records",
      "devices",
      "audit_log_entries",
      "audit_log_entries",
    ]);

    const revoke = forTable(calls, "consent_records")[0]!;
    expect(payloadOf(revoke, "update")).toMatchObject({ revoked_at: expect.any(String) });
    expect(hasEq(revoke, "device_id", DEVICE)).toBe(true);
    expect(hasEq(revoke, "company_id", COMPANY)).toBe(true);
    // Only the LIVE record; revoked rows stay untouched for the audit trail.
    expect(revoke.ops.some((op) => op.fn === "is" && op.args[0] === "revoked_at")).toBe(true);

    expect(res.json()).toMatchObject({ profile_id: BOB, consent_revoked: true });
  });

  it("scopes the device update by company as well as by id", async () => {
    // `.eq("id", ...)` alone would be a cross-tenant write with a uuid for a password.
    const { client, calls } = happyPath();
    const app = await buildTestApp({ supabase: client, session: admin });
    await app.inject({ method: "PATCH", url: `/api/devices/${DEVICE}`, payload: { profileId: BOB } });

    const update = forTable(calls, "devices")[1]!;
    expect(payloadOf(update, "update")).toEqual({ profile_id: BOB });
    expect(hasEq(update, "id", DEVICE)).toBe(true);
    expect(hasEq(update, "company_id", COMPANY)).toBe(true);
  });

  it("files both the reassignment and the consent withdrawal under the caller's company", async () => {
    const { client, calls } = happyPath();
    const app = await buildTestApp({ supabase: client, session: admin });
    await app.inject({ method: "PATCH", url: `/api/devices/${DEVICE}`, payload: { profileId: BOB } });

    const entries = forTable(calls, "audit_log_entries").map((c) => payloadOf(c, "insert"));
    expect(entries).toHaveLength(2);

    // Two entries because two things happened; collapsing them hides a consent
    // withdrawal inside a device event, and the consent trail is what an auditor reads.
    expect(entries[0]).toMatchObject({
      company_id: COMPANY,
      actor_id: ADMIN,
      action: "consent.revoked",
      target_id: DEVICE,
      metadata: { reason: "device_reassigned", profileId: ALICE },
    });
    expect(entries[1]).toMatchObject({
      company_id: COMPANY,
      actor_id: ADMIN,
      action: "device.reassigned",
      target_id: DEVICE,
      metadata: { fromProfileId: ALICE, toProfileId: BOB, consentRevoked: true },
    });
  });

  it("does not revoke consent or write an audit entry when the owner is unchanged", async () => {
    // A double click must not cost a working consent record and force a re-prompt.
    const { client, calls } = fakeSupabase({
      profiles: [{ data: { id: ALICE, full_name: "Alice", deactivated_at: null } }],
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${DEVICE}`,
      payload: { profileId: ALICE },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ consent_revoked: false });
    expect(tables(calls)).toEqual(["profiles", "devices"]);
  });

  it("reports consent_revoked false when the device had no live consent", async () => {
    const { client } = fakeSupabase({
      profiles: [{ data: { id: BOB, full_name: "Bob", deactivated_at: null } }],
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }, { data: { id: DEVICE, profile_id: BOB } }],
      consent_records: [{ data: [] }],
      audit_log_entries: [{}],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${DEVICE}`,
      payload: { profileId: BOB },
    });

    expect(res.json()).toMatchObject({ consent_revoked: false });
  });

  it("does not reassign when the consent revoke fails", async () => {
    // The failure has to land on the side that stops collection, not the side that
    // collects a new owner under someone else's agreement.
    const { client, calls } = fakeSupabase({
      profiles: [{ data: { id: BOB, full_name: "Bob", deactivated_at: null } }],
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }],
      consent_records: [{ error: { message: "connection reset" } }],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${DEVICE}`,
      payload: { profileId: BOB },
    });

    expect(res.statusCode).toBe(500);
    // One `devices` call — the read. The update never ran.
    expect(forTable(calls, "devices")).toHaveLength(1);
  });
});

describe("GET /api/devices/:deviceId/applications", () => {
  it("returns the inventory for the caller's own device", async () => {
    const { client, calls } = fakeSupabase({
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }],
      device_applications: [{ data: [{ id: 1, name: "VS Code", version: "1.9" }] }],
    });
    const app = await buildTestApp({ supabase: client, session: alice });
    const res = await app.inject({ method: "GET", url: `/api/devices/${DEVICE}/applications` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 1, name: "VS Code", version: "1.9" }]);
    expect(hasEq(forTable(calls, "device_applications")[0]!, "company_id", COMPANY)).toBe(true);
    expect(hasEq(forTable(calls, "device_applications")[0]!, "device_id", DEVICE)).toBe(true);
  });

  it("refuses an employee another person's device before reading the inventory", async () => {
    const { client, calls } = fakeSupabase({
      devices: [{ data: { id: DEVICE, profile_id: BOB } }],
    });
    const app = await buildTestApp({ supabase: client, session: alice });
    const res = await app.inject({ method: "GET", url: `/api/devices/${DEVICE}/applications` });

    expect(res.statusCode).toBe(403);
    // The refusal is worthless if the query ran anyway.
    expect(forTable(calls, "device_applications")).toHaveLength(0);
  });

  it("404s a device in another company", async () => {
    const { client, calls } = fakeSupabase({ devices: [{ data: null }] });
    const app = await buildTestApp({
      supabase: client,
      session: { ...admin, companyId: OTHER_COMPANY },
    });
    const res = await app.inject({ method: "GET", url: `/api/devices/${DEVICE}/applications` });

    expect(res.statusCode).toBe(404);
    expect(hasEq(forTable(calls, "devices")[0]!, "company_id", OTHER_COMPANY)).toBe(true);
  });

  it("rejects a deviceId that is not a uuid", async () => {
    const { client, calls } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: admin });
    const res = await app.inject({ method: "GET", url: "/api/devices/oops/applications" });

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("returns an empty list rather than null when nothing is inventoried", async () => {
    const { client } = fakeSupabase({
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }],
      profiles: [{ data: { id: ALICE, role: "employee" } }],
      device_applications: [{ data: null }],
    });
    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({ method: "GET", url: `/api/devices/${DEVICE}/applications` });

    expect(res.json()).toEqual([]);
  });
});

/**
 * Rank visibility, at the route rather than in `@aems/auth`.
 *
 * The pure rule is tested in `packages/auth/src/roles.test.ts`; these prove the routes
 * actually consult it. That gap is the whole reason the defect existed — `canViewRole`
 * would have refused this all along, but no route ever asked it anything about the
 * person being read.
 */
describe("rank visibility", () => {
  const SUPER = "33333333-3333-4333-8333-333333333333";

  it("refuses a manager the super admin's device, and reads nothing first", async () => {
    const { client, calls } = fakeSupabase({
      devices: [{ data: { id: DEVICE, profile_id: SUPER } }],
      profiles: [{ data: { id: SUPER, role: "super_admin" } }],
    });
    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({ method: "GET", url: `/api/devices/${DEVICE}/telemetry` });

    // 404 rather than 403: telling a manager "forbidden" confirms the id is real, which
    // is the first half of an attack on it. Same answer a stranger's uuid produces.
    expect(res.statusCode).toBe(404);
    expect(forTable(calls, "device_telemetry")).toHaveLength(0);
  });

  it("still lets a manager read an employee's device", async () => {
    const { client } = fakeSupabase({
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }],
      profiles: [{ data: { id: ALICE, role: "employee" } }],
      device_telemetry: [{ data: [] }],
    });
    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({ method: "GET", url: `/api/devices/${DEVICE}/telemetry` });

    expect(res.statusCode).toBe(200);
  });

  it("keeps the super admin's roster unfiltered", async () => {
    const superAdmin: SessionProfile = {
      profileId: SUPER,
      companyId: COMPANY,
      email: "s@x",
      role: "super_admin",
    };
    const { client, calls } = fakeSupabase({ devices: [{ data: [] }] });
    const app = await buildTestApp({ supabase: client, session: superAdmin });

    expect((await app.inject({ method: "GET", url: "/api/devices" })).statusCode).toBe(200);
    // `visibleRoleFilter` returns null for a super admin, so no rank lookup happens at
    // all — the roster query must not pay for a filter that excludes nobody.
    expect(forTable(calls, "profiles")).toHaveLength(0);
    expect(forTable(calls, "devices")[0]!.ops.some((op) => op.fn === "not")).toBe(false);
  });

  it("excludes higher ranks from a manager's device roster", async () => {
    const { client, calls } = fakeSupabase({
      profiles: [{ data: [{ id: SUPER, role: "super_admin" }] }],
      devices: [{ data: [] }],
    });
    const app = await buildTestApp({ supabase: client, session: manager });

    expect((await app.inject({ method: "GET", url: "/api/devices" })).statusCode).toBe(200);
    const notOp = forTable(calls, "devices")[0]!.ops.find((op) => op.fn === "not");
    expect(notOp?.args).toEqual(["profile_id", "in", `(${SUPER})`]);
  });
});

describe("GET /api/devices/:deviceId/telemetry", () => {
  it("returns the newest sample as `latest` alongside the series", async () => {
    const samples = [
      { id: 2, recorded_at: "2026-08-05T11:00:00Z", battery_level: 64 },
      { id: 1, recorded_at: "2026-08-05T10:00:00Z", battery_level: 71 },
    ];
    const { client, calls } = fakeSupabase({
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }],
      profiles: [{ data: { id: ALICE, role: "employee" } }],
      device_telemetry: [{ data: samples }],
    });
    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({ method: "GET", url: `/api/devices/${DEVICE}/telemetry` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ latest: samples[0], samples });

    const query = forTable(calls, "device_telemetry")[0]!;
    expect(hasEq(query, "company_id", COMPANY)).toBe(true);
    expect(query.ops.find((op) => op.fn === "limit")?.args[0]).toBe(50);
  });

  it("reports latest null for a device that has never sent telemetry", async () => {
    const { client } = fakeSupabase({
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }],
      profiles: [{ data: { id: ALICE, role: "employee" } }],
      device_telemetry: [{ data: [] }],
    });
    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({ method: "GET", url: `/api/devices/${DEVICE}/telemetry` });

    expect(res.json()).toEqual({ latest: null, samples: [] });
  });

  it("honours a limit and caps it", async () => {
    const { client, calls } = fakeSupabase({
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }],
      profiles: [{ data: { id: ALICE, role: "employee" } }],
      device_telemetry: [{ data: [] }],
    });
    const app = await buildTestApp({ supabase: client, session: manager });
    await app.inject({ method: "GET", url: `/api/devices/${DEVICE}/telemetry?limit=5` });

    expect(forTable(calls, "device_telemetry")[0]!.ops.find((op) => op.fn === "limit")?.args[0]).toBe(5);

    for (const bad of ["0", "501", "-3", "all"]) {
      const fake = fakeSupabase({ devices: [{ data: { id: DEVICE, profile_id: ALICE } }] });
      const app2 = await buildTestApp({ supabase: fake.client, session: manager });
      const res = await app2.inject({
        method: "GET",
        url: `/api/devices/${DEVICE}/telemetry?limit=${bad}`,
      });
      expect(res.statusCode, `limit=${bad}`).toBe(400);
    }
  });

  it("refuses an employee another person's telemetry", async () => {
    const { client, calls } = fakeSupabase({ devices: [{ data: { id: DEVICE, profile_id: BOB } }] });
    const app = await buildTestApp({ supabase: client, session: alice });
    const res = await app.inject({ method: "GET", url: `/api/devices/${DEVICE}/telemetry` });

    expect(res.statusCode).toBe(403);
    expect(forTable(calls, "device_telemetry")).toHaveLength(0);
  });
});
