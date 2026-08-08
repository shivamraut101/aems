import type { SessionProfile } from "@aems/auth";
import type { AemsSupabaseClient } from "@aems/supabase";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import type { Env } from "../env.js";
import type { DeviceContext } from "../plugins/context.js";

import { activityRoutes } from "./activity.js";
import { deviceRoutes } from "./devices.js";
import { screenshotRoutes } from "./screenshots.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const EVENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const admin: SessionProfile = { profileId: ADMIN, companyId: COMPANY, email: "a@x", role: "super_admin" };
const manager: SessionProfile = { profileId: BOB, companyId: COMPANY, email: "m@x", role: "manager" };
const alice: SessionProfile = { profileId: ALICE, companyId: COMPANY, email: "e@x", role: "employee" };

const laptop: DeviceContext = {
  deviceId: DEVICE,
  companyId: COMPANY,
  profileId: ALICE,
  platform: "windows",
};
const phone: DeviceContext = { ...laptop, platform: "android" };

// ---------------------------------------------------------------------------
// The same recording stand-in the other route suites use: the property under test
// is usually the query that was BUILT, not the value that came back. A refusal that
// answers 403 after the row was already written is not a refusal.
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

const forTable = (calls: Call[], table: string): Call[] => calls.filter((c) => c.table === table);

function hasEq(call: Call, column: string, value: unknown): boolean {
  return call.ops.some((op) => op.fn === "eq" && op.args[0] === column && op.args[1] === value);
}

function payloadOf(call: Call, fn: "update" | "insert" | "upsert"): Record<string, unknown> | undefined {
  const arg = call.ops.find((op) => op.fn === fn)?.args[0];
  return (Array.isArray(arg) ? arg[0] : arg) as Record<string, unknown> | undefined;
}

function rowsOf(call: Call, fn: "insert" | "upsert"): Record<string, unknown>[] {
  const arg = call.ops.find((op) => op.fn === fn)?.args[0];
  return (Array.isArray(arg) ? arg : [arg]) as Record<string, unknown>[];
}

/** A live consent covering everything — the state every existing device is in. */
const CONSENT_ANY = { data: { id: "c1", granted_types: null } };
/** No decision has ever been made about this device. Every device, today. */
const NO_SETTINGS = { data: [] };

function settings(...rows: [string, boolean][]) {
  return { data: rows.map(([data_type, enabled]) => ({ data_type, enabled })) };
}

async function buildTestApp(opts: {
  supabase: AemsSupabaseClient;
  session?: SessionProfile;
  device?: DeviceContext;
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
  app.decorate("requireDevice", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!opts.device) {
      await reply.code(401).send({ error: "unauthorized", message: "no device", statusCode: 401 });
      return;
    }
    request.device = opts.device;
  });

  await app.register(deviceRoutes, { prefix: "/api/devices" });
  await app.register(activityRoutes, { prefix: "/api/activity" });
  await app.register(screenshotRoutes, { prefix: "/api/screenshots" });
  return app;
}

const activityEvent = (over: Record<string, unknown> = {}) => ({
  clientEventId: EVENT,
  appName: "Chrome",
  windowTitle: "GitHub",
  url: "https://github.com/aems/api",
  domain: "github.com",
  startedAt: "2026-08-08T09:00:00.000Z",
  endedAt: "2026-08-08T09:05:00.000Z",
  ...over,
});

const idleEvent = {
  clientEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01",
  idleStartAt: "2026-08-08T10:00:00.000Z",
  idleEndAt: "2026-08-08T10:06:00.000Z",
};

const locationPoint = {
  clientEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02",
  recordedAt: "2026-08-08T10:00:00.000Z",
  latitude: 12.97,
  longitude: 77.59,
  accuracyM: 18,
};

// ---------------------------------------------------------------------------
// The regression that matters most: nothing on the estate has a settings row.
// ---------------------------------------------------------------------------

describe("a device with no collection settings", () => {
  it("ingests activity, websites, idle and breaks exactly as it did before", async () => {
    const { client, calls } = fakeSupabase({
      consent_records: [CONSENT_ANY],
      device_collection_settings: [NO_SETTINGS],
      activity_events: [{ data: [{ id: 1 }] }],
      idle_events: [{ data: [{ id: 2 }] }],
      break_events: [{ data: [{ id: 3 }] }],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });
    const res = await app.inject({
      method: "POST",
      url: "/api/activity/events",
      payload: {
        deviceId: DEVICE,
        activity: [activityEvent()],
        idle: [idleEvent],
        breaks: [
          {
            clientEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03",
            breakStartAt: "2026-08-08T12:00:00.000Z",
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      acceptedActivity: 1,
      acceptedIdle: 1,
      acceptedBreaks: 1,
      duplicates: 0,
      refusedActivity: 0,
      refusedIdle: 0,
    });

    // The website fields still ride the row — absence of a row is permission.
    const row = rowsOf(forTable(calls, "activity_events")[0]!, "upsert")[0]!;
    expect(row.url).toBe("https://github.com/aems/api");
    expect(row.domain).toBe("github.com");
  });

  it("still accepts telemetry and an installed-application inventory", async () => {
    const { client, calls } = fakeSupabase({
      consent_records: [CONSENT_ANY, CONSENT_ANY],
      device_collection_settings: [NO_SETTINGS, NO_SETTINGS],
      device_telemetry: [{}],
      device_applications: [{}],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/devices/telemetry",
          payload: { batteryLevel: 71, networkType: "wifi" },
        })
      ).statusCode,
    ).toBe(200);
    expect(payloadOf(forTable(calls, "device_telemetry")[0]!, "insert")).toMatchObject({
      battery_level: 71,
    });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/devices/applications",
          payload: { applications: [{ name: "VS Code", version: "1.9" }] },
        })
      ).json(),
    ).toEqual({ upserted: 1 });
  });

  it("keeps refusing everything when consent is missing, with the same error as before", async () => {
    const { client, calls } = fakeSupabase({
      consent_records: [{ data: null }],
      device_collection_settings: [NO_SETTINGS],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });
    const res = await app.inject({
      method: "POST",
      url: "/api/activity/events",
      payload: { deviceId: DEVICE, activity: [activityEvent()] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "consent_required", statusCode: 403 });
    expect(forTable(calls, "activity_events")).toHaveLength(0);
  });

  it("lets an Android device write location points, because its platform has them", async () => {
    const { client, calls } = fakeSupabase({
      consent_records: [CONSENT_ANY],
      device_collection_settings: [NO_SETTINGS],
      location_points: [{ data: [{ id: 1 }] }],
    });
    const app = await buildTestApp({ supabase: client, device: phone });
    const res = await app.inject({
      method: "POST",
      url: "/api/activity/events",
      payload: { deviceId: DEVICE, locations: [locationPoint] },
    });

    expect(res.json()).toMatchObject({ acceptedLocations: 1, refusedLocations: 0 });
    expect(forTable(calls, "location_points")).toHaveLength(1);
  });

  it("refuses location points from a desktop token even with no settings row", async () => {
    // The live hole this closes: `DeviceContext` carried no platform, so a laptop's
    // token could store position fixes that the dashboard never renders for a laptop —
    // retained under no rule and invisible on the one screen that would have shown them.
    const { client, calls } = fakeSupabase({
      consent_records: [CONSENT_ANY],
      device_collection_settings: [NO_SETTINGS],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });
    const res = await app.inject({
      method: "POST",
      url: "/api/activity/events",
      payload: { deviceId: DEVICE, locations: [locationPoint] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ acceptedLocations: 0, refusedLocations: 1, duplicates: 0 });
    expect(forTable(calls, "location_points")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A type an admin switched off.
// ---------------------------------------------------------------------------

describe("a data type the device may not collect", () => {
  it("skips the activity block and reports it as refused, not as duplicates", async () => {
    // `duplicates` means "already stored". Folding a refusal into it would tell the
    // agent its rows had landed, and it would drop them from its buffer.
    const { client, calls } = fakeSupabase({
      consent_records: [CONSENT_ANY],
      device_collection_settings: [settings(["applications", false])],
      idle_events: [{ data: [{ id: 2 }] }],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });
    const res = await app.inject({
      method: "POST",
      url: "/api/activity/events",
      payload: { deviceId: DEVICE, activity: [activityEvent()], idle: [idleEvent] },
    });

    expect(res.json()).toMatchObject({
      acceptedActivity: 0,
      refusedActivity: 1,
      acceptedIdle: 1,
      duplicates: 0,
    });
    expect(forTable(calls, "activity_events")).toHaveLength(0);
    // The other types in the same batch are unaffected — one gate, four decisions.
    expect(forTable(calls, "idle_events")).toHaveLength(1);
  });

  it("nulls url and domain when websites are off but still stores the focus interval", async () => {
    // The two fields ride the same row as `app_name`. Dropping the row to enforce a
    // website setting would delete application activity the employee did agree to.
    const { client, calls } = fakeSupabase({
      consent_records: [CONSENT_ANY],
      device_collection_settings: [settings(["websites", false])],
      activity_events: [{ data: [{ id: 1 }] }],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });
    const res = await app.inject({
      method: "POST",
      url: "/api/activity/events",
      payload: { deviceId: DEVICE, activity: [activityEvent()] },
    });

    expect(res.json()).toMatchObject({ acceptedActivity: 1, refusedActivity: 0 });
    const row = rowsOf(forTable(calls, "activity_events")[0]!, "upsert")[0]!;
    expect(row.app_name).toBe("Chrome");
    expect(row.url).toBeNull();
    expect(row.domain).toBeNull();
  });

  it("refuses idle stretches while leaving declared breaks alone", async () => {
    // A break is the employee's own statement about their day, not an observation.
    const { client, calls } = fakeSupabase({
      consent_records: [CONSENT_ANY],
      device_collection_settings: [settings(["idle", false])],
      break_events: [{ data: [{ id: 3 }] }],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });
    const res = await app.inject({
      method: "POST",
      url: "/api/activity/events",
      payload: {
        deviceId: DEVICE,
        idle: [idleEvent],
        breaks: [
          {
            clientEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03",
            breakStartAt: "2026-08-08T12:00:00.000Z",
          },
        ],
      },
    });

    expect(res.json()).toMatchObject({ refusedIdle: 1, acceptedIdle: 0, acceptedBreaks: 1 });
    expect(forTable(calls, "idle_events")).toHaveLength(0);
  });

  it("refuses a screenshot before the multipart body is read", async () => {
    const { client, calls } = fakeSupabase({
      consent_records: [CONSENT_ANY],
      device_collection_settings: [settings(["screenshots", false])],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });
    const res = await app.inject({ method: "POST", url: "/api/screenshots" });

    expect(res.statusCode).toBe(403);
    // Distinct from `consent_required`: one says nobody agreed, the other says somebody
    // decided. An agent that conflated them would send a person to a consent screen
    // over a decision they cannot fix by agreeing.
    expect(res.json()).toMatchObject({ error: "collection_disabled", statusCode: 403 });
    expect(forTable(calls, "screenshots")).toHaveLength(0);
  });

  it("refuses telemetry and installed applications, writing nothing", async () => {
    for (const [type, url, payload] of [
      ["telemetry", "/api/devices/telemetry", { batteryLevel: 50 }],
      ["installed_apps", "/api/devices/applications", { applications: [{ name: "VS Code" }] }],
    ] as const) {
      const { client, calls } = fakeSupabase({
        consent_records: [CONSENT_ANY],
        device_collection_settings: [settings([type, false])],
      });
      const app = await buildTestApp({ supabase: client, device: laptop });
      const res = await app.inject({ method: "POST", url, payload });

      expect(res.statusCode, type).toBe(403);
      expect(res.json().error, type).toBe("collection_disabled");
      expect(forTable(calls, "device_telemetry")).toHaveLength(0);
      expect(forTable(calls, "device_applications")).toHaveLength(0);
    }
  });

  it("is enforced by what the employee agreed to, not only by the admin's switches", async () => {
    // Three sets intersected. A consent that names fewer types than the platform allows
    // narrows just as hard as a denial row does.
    const { client, calls } = fakeSupabase({
      consent_records: [{ data: { id: "c1", granted_types: ["applications"] } }],
      device_collection_settings: [NO_SETTINGS],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });
    const res = await app.inject({
      method: "POST",
      url: "/api/devices/telemetry",
      payload: { batteryLevel: 50 },
    });

    expect(res.statusCode).toBe(403);
    expect(forTable(calls, "device_telemetry")).toHaveLength(0);
  });

  it("fails closed when the settings read itself fails", async () => {
    // A read that failed cannot prove a type was NOT switched off. Guessing "permitted"
    // here collects something an administrator turned off.
    const { client, calls } = fakeSupabase({
      consent_records: [CONSENT_ANY],
      device_collection_settings: [{ error: { message: "connection reset" } }],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });
    const res = await app.inject({
      method: "POST",
      url: "/api/devices/telemetry",
      payload: { batteryLevel: 50 },
    });

    expect(res.statusCode).toBe(403);
    expect(forTable(calls, "device_telemetry")).toHaveLength(0);
  });

  it("still lets a work session open, because it is the container and not an observation", async () => {
    const { client } = fakeSupabase({
      consent_records: [CONSENT_ANY],
      device_collection_settings: [
        settings(["applications", false], ["idle", false], ["screenshots", false]),
      ],
      work_sessions: [{ data: null }, { data: { id: 9 } }],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });
    const res = await app.inject({ method: "POST", url: "/api/activity/sessions" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 9 });
  });
});

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

describe("POST /api/devices/enrollment-codes", () => {
  it("stores the chosen scope on the code and names it in the audit entry", async () => {
    const { client, calls } = fakeSupabase({
      profiles: [
        // Minting a code is now rank-gated too, so the owner is resolved first.
        { data: { id: ALICE, role: "employee" } },
        { data: { id: ALICE, full_name: "Alice", email: "a@x", deactivated_at: null } },
      ],
      device_enrollment_codes: [{}],
      audit_log_entries: [{}],
    });
    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({
      method: "POST",
      url: "/api/devices/enrollment-codes",
      payload: { profileId: ALICE, deniedTypes: ["screenshots", "screenshots", "websites"] },
    });

    expect(res.statusCode).toBe(200);
    expect(payloadOf(forTable(calls, "device_enrollment_codes")[0]!, "insert")).toMatchObject({
      denied_types: ["screenshots", "websites"],
    });

    const audit = payloadOf(forTable(calls, "audit_log_entries")[0]!, "insert")!;
    expect(audit.metadata).toMatchObject({ deniedTypes: ["screenshots", "websites"] });
    // The code itself is still absent — an audit log is not a place for a credential.
    expect(JSON.stringify(audit)).not.toContain(res.json().code);
  });

  it("defaults to denying nothing, so an old dashboard build mints an unrestricted code", async () => {
    const { client, calls } = fakeSupabase({
      // No rank lookup here: Alice is enrolling her own machine, and
      // `profileVisibilityDenial` short-circuits on self before it queries.
      profiles: [{ data: { id: ALICE, full_name: "Alice", email: "a@x", deactivated_at: null } }],
      device_enrollment_codes: [{}],
      audit_log_entries: [{}],
    });
    const app = await buildTestApp({ supabase: client, session: alice });
    await app.inject({ method: "POST", url: "/api/devices/enrollment-codes", payload: {} });

    expect(payloadOf(forTable(calls, "device_enrollment_codes")[0]!, "insert")).toMatchObject({
      denied_types: [],
    });
  });

  it("refuses a type that is not in the vocabulary rather than letting Postgres do it", async () => {
    const { client, calls } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({
      method: "POST",
      url: "/api/devices/enrollment-codes",
      payload: { deniedTypes: ["keystrokes"] },
    });

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/devices/enroll-with-code", () => {
  const BODY = { code: "ABCD1234", platform: "windows", label: "Alice Laptop" };

  function redeemable(
    deniedTypes: string[],
    scopeWrite: Result = {},
    // Undefined models a row selected before the column existed, which is how every
    // pre-existing code reads. It must behave as "any platform may redeem this".
    platform: string | undefined = "windows",
  ) {
    return fakeSupabase({
      device_enrollment_codes: [
        {
          data: {
            id: "code-1",
            company_id: COMPANY,
            profile_id: ALICE,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            consumed_at: null,
            denied_types: deniedTypes,
            created_by: ADMIN,
            ...(platform === undefined ? {} : { platform }),
          },
        },
        { data: { id: "code-1" } },
      ],
      profiles: [{ data: { id: ALICE, deactivated_at: null } }],
      devices: [{ data: { id: DEVICE } }],
      device_collection_settings: [scopeWrite],
      policies: [
        {
          data: {
            version: "1.0.0",
            name: "Standard",
            screenshot_interval_seconds: 600,
            idle_threshold_seconds: 300,
            tracked_categories: [],
          },
        },
      ],
      audit_log_entries: [{}],
    });
  }

  it("expands the code's scope into settings rows and tells the agent what it may collect", async () => {
    const { client, calls } = redeemable(["screenshots"]);
    const app = await buildTestApp({ supabase: client });
    const res = await app.inject({ method: "POST", url: "/api/devices/enroll-with-code", payload: BODY });

    expect(res.statusCode).toBe(200);
    // The platform's capability minus the denial. Not `location`: this is a laptop.
    expect(res.json().collection).toEqual([
      "applications",
      "websites",
      "idle",
      "telemetry",
      "installed_apps",
    ]);
    expect(res.json().policy).toMatchObject({ version: "1.0.0" });

    const row = rowsOf(forTable(calls, "device_collection_settings")[0]!, "insert")[0]!;
    expect(row).toMatchObject({
      company_id: COMPANY,
      device_id: DEVICE,
      data_type: "screenshots",
      enabled: false,
      // The person who minted the code, not the person redeeming it.
      changed_by: ADMIN,
    });
  });

  it("writes no settings rows at all when the code denied nothing", async () => {
    const { client, calls } = redeemable([]);
    const app = await buildTestApp({ supabase: client });
    const res = await app.inject({ method: "POST", url: "/api/devices/enroll-with-code", payload: BODY });

    expect(res.statusCode).toBe(200);
    expect(forTable(calls, "device_collection_settings")).toHaveLength(0);
  });

  it("refuses a code minted for one platform and redeemed by another", async () => {
    // Scope is chosen against a platform's vocabulary. An Android code applied to a
    // laptop would carry a phone's deny list to a machine with different capabilities,
    // permitting things the admin was never shown a checkbox for — so it is refused
    // rather than reconciled.
    const { client } = redeemable(["screenshots"], {}, "android");
    const app = await buildTestApp({ supabase: client });
    const res = await app.inject({ method: "POST", url: "/api/devices/enroll-with-code", payload: BODY });

    expect(res.statusCode).toBe(401);
    // Worded exactly like every other refusal on this unauthenticated route: saying
    // *why* would turn it into an oracle for which codes exist.
    expect(res.json().error).toBe("invalid_code");
  });

  it("still accepts a code that names no platform, as every code minted before …0018", async () => {
    // The regression that matters. A strict `!== null` check refused these, which is
    // every code already in the field — the exact devices the migration was written to
    // leave alone.
    const { client } = redeemable([], {}, undefined);
    const app = await buildTestApp({ supabase: client });
    const res = await app.inject({ method: "POST", url: "/api/devices/enroll-with-code", payload: BODY });

    expect(res.statusCode).toBe(200);
  });

  it("does not enrol at all if the scope could not be recorded", async () => {
    // Better no device than a device that collects everything because a write nobody
    // watched failed to land.
    const { client, calls } = redeemable(["screenshots"], {
      error: { message: "constraint violation" },
    });
    const app = await buildTestApp({ supabase: client });
    const res = await app.inject({ method: "POST", url: "/api/devices/enroll-with-code", payload: BODY });

    expect(res.statusCode).toBe(500);
    // The half-made device is deleted rather than left behind unscoped.
    expect(forTable(calls, "devices")[1]?.ops.some((op) => op.fn === "delete")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delivery back to the agent, and the dashboard's read/write pair.
// ---------------------------------------------------------------------------

describe("POST /api/devices/heartbeat", () => {
  const BODY = { deviceId: DEVICE };

  it("carries the enforced scope and the types still awaiting agreement", async () => {
    const { client } = fakeSupabase({
      devices: [{}],
      policies: [{ data: { version: "1.2.0" } }],
      // Screenshots were switched back on after the employee agreed without them.
      consent_records: [{ data: { granted_types: ["applications", "idle"] } }],
      device_collection_settings: [settings(["telemetry", false], ["screenshots", true])],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });
    const res = await app.inject({ method: "POST", url: "/api/devices/heartbeat", payload: BODY });

    expect(res.json()).toEqual({
      ok: true,
      policyVersion: "1.2.0",
      collection: ["applications", "idle"],
      // Widening does not resume collection; it asks.
      pendingTypes: ["websites", "screenshots", "installed_apps"],
    });
  });

  it("reports nothing collectable while consent is missing", async () => {
    const { client } = fakeSupabase({
      devices: [{}],
      policies: [{ data: { version: "1.2.0" } }],
      consent_records: [{ data: null }],
      device_collection_settings: [NO_SETTINGS],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });

    expect(
      (await app.inject({ method: "POST", url: "/api/devices/heartbeat", payload: BODY })).json(),
    ).toMatchObject({ ok: true, collection: [], pendingTypes: [] });
  });

  it("omits both arrays rather than guessing when the settings read fails", async () => {
    // Absent means "no new information" and the agent keeps what it last heard.
    // Guessing "nothing is denied" would tell it to resume a type an admin switched off.
    const { client } = fakeSupabase({
      devices: [{}],
      policies: [{ data: { version: "1.2.0" } }],
      consent_records: [CONSENT_ANY],
      device_collection_settings: [{ error: { message: "timeout" } }],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });

    expect(
      (await app.inject({ method: "POST", url: "/api/devices/heartbeat", payload: BODY })).json(),
    ).toEqual({ ok: true, policyVersion: "1.2.0" });
  });

  it("still answers ok for a company with no published policy", async () => {
    const { client } = fakeSupabase({
      devices: [{}],
      policies: [{ data: null }],
      consent_records: [CONSENT_ANY],
      device_collection_settings: [NO_SETTINGS],
    });
    const app = await buildTestApp({ supabase: client, device: laptop });
    const body = (
      await app.inject({ method: "POST", url: "/api/devices/heartbeat", payload: BODY })
    ).json();

    expect(body.ok).toBe(true);
    expect(body.policyVersion).toBeUndefined();
  });
});

describe("GET /api/devices/:deviceId/collection", () => {
  const embedded = {
    data: [
      {
        data_type: "screenshots",
        enabled: false,
        changed_at: "2026-08-08T09:00:00.000Z",
        profiles: { full_name: "Sam Patel" },
      },
      {
        data_type: "telemetry",
        enabled: true,
        changed_at: "2026-08-08T10:00:00.000Z",
        profiles: null,
      },
    ],
  };

  it("gives an employee their own device's scope with the attribution", async () => {
    // Non-negotiable #3: an employee reads what is being collected about them without
    // asking anyone. The name comes off the settings row, not the audit log, which only
    // a super admin can read.
    const { client, calls } = fakeSupabase({
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }],
      device_collection_settings: [embedded],
    });
    const app = await buildTestApp({ supabase: client, session: alice });
    const res = await app.inject({ method: "GET", url: `/api/devices/${DEVICE}/collection` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        dataType: "screenshots",
        enabled: false,
        changedByName: "Sam Patel",
        changedAt: "2026-08-08T09:00:00.000Z",
      },
      // Null when whoever made the change has left. The decision outlives them.
      { dataType: "telemetry", enabled: true, changedByName: null, changedAt: "2026-08-08T10:00:00.000Z" },
    ]);
    expect(hasEq(forTable(calls, "device_collection_settings")[0]!, "company_id", COMPANY)).toBe(true);
  });

  it("returns an empty list for a device nobody has made a decision about", async () => {
    const { client } = fakeSupabase({
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }],
      profiles: [{ data: { id: ALICE, role: "employee" } }],
      device_collection_settings: [{ data: null }],
    });
    const app = await buildTestApp({ supabase: client, session: manager });

    expect(
      (await app.inject({ method: "GET", url: `/api/devices/${DEVICE}/collection` })).json(),
    ).toEqual([]);
  });

  it("refuses an employee somebody else's device before reading the scope", async () => {
    const { client, calls } = fakeSupabase({ devices: [{ data: { id: DEVICE, profile_id: BOB } }] });
    const app = await buildTestApp({ supabase: client, session: alice });
    const res = await app.inject({ method: "GET", url: `/api/devices/${DEVICE}/collection` });

    expect(res.statusCode).toBe(403);
    expect(forTable(calls, "device_collection_settings")).toHaveLength(0);
  });
});

describe("PATCH /api/devices/:deviceId/collection", () => {
  function patchable() {
    return fakeSupabase({
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }],
      device_collection_settings: [
        // Current state, then the upsert, then the read-back.
        settings(["screenshots", false]),
        {},
        settings(["screenshots", true]),
      ],
      audit_log_entries: [{}],
    });
  }

  it("is closed to employees, before any query runs", async () => {
    const { client, calls } = fakeSupabase({});
    const app = await buildTestApp({ supabase: client, session: alice });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${DEVICE}/collection`,
      payload: { types: { screenshots: true } },
    });

    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("stamps who changed it and when, per type", async () => {
    const { client, calls } = patchable();
    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${DEVICE}/collection`,
      payload: { types: { screenshots: true } },
    });

    expect(res.statusCode).toBe(200);
    const upsert = forTable(calls, "device_collection_settings")[1]!;
    expect(rowsOf(upsert, "upsert")[0]).toMatchObject({
      company_id: COMPANY,
      device_id: DEVICE,
      data_type: "screenshots",
      enabled: true,
      changed_by: BOB,
    });
    // Re-enabling updates the row rather than deleting it: "Sam turned screenshots back
    // on" is a fact the compliance surfaces have to be able to state.
    expect(upsert.ops.find((op) => op.fn === "upsert")?.args[1]).toMatchObject({
      onConflict: "device_id,data_type",
    });
  });

  it("audits the change with both the before and the after", async () => {
    const { client, calls } = patchable();
    const app = await buildTestApp({ supabase: client, session: manager });
    await app.inject({
      method: "PATCH",
      url: `/api/devices/${DEVICE}/collection`,
      payload: { types: { screenshots: true } },
    });

    expect(payloadOf(forTable(calls, "audit_log_entries")[0]!, "insert")).toMatchObject({
      company_id: COMPANY,
      actor_id: BOB,
      action: "collection.changed",
      target_id: DEVICE,
      metadata: {
        profileId: ALICE,
        before: { screenshots: false },
        after: { screenshots: true },
      },
    });
  });

  it("reads absence as permitted when describing what changed", async () => {
    const { client, calls } = fakeSupabase({
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }],
      device_collection_settings: [NO_SETTINGS, {}, settings(["telemetry", false])],
      audit_log_entries: [{}],
    });
    const app = await buildTestApp({ supabase: client, session: admin });
    await app.inject({
      method: "PATCH",
      url: `/api/devices/${DEVICE}/collection`,
      payload: { types: { telemetry: false } },
    });

    expect(payloadOf(forTable(calls, "audit_log_entries")[0]!, "insert")).toMatchObject({
      metadata: { before: { telemetry: true }, after: { telemetry: false } },
    });
  });

  it("404s a device in another company and writes nothing", async () => {
    const { client, calls } = fakeSupabase({ devices: [{ data: null }] });
    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${DEVICE}/collection`,
      payload: { types: { screenshots: true } },
    });

    expect(res.statusCode).toBe(404);
    expect(hasEq(forTable(calls, "devices")[0]!, "company_id", COMPANY)).toBe(true);
    expect(forTable(calls, "device_collection_settings")).toHaveLength(0);
  });

  it("rejects an unknown type, an empty patch and a bad uuid before touching the database", async () => {
    for (const [url, payload] of [
      [`/api/devices/${DEVICE}/collection`, { types: { keystrokes: true } }],
      [`/api/devices/${DEVICE}/collection`, { types: {} }],
      [`/api/devices/${DEVICE}/collection`, { types: { screenshots: "yes" } }],
      ["/api/devices/not-a-uuid/collection", { types: { screenshots: true } }],
    ] as const) {
      const { client, calls } = fakeSupabase({});
      const app = await buildTestApp({ supabase: client, session: manager });
      const res = await app.inject({ method: "PATCH", url, payload });

      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(calls).toHaveLength(0);
    }
  });

  it("changes nothing when the current scope could not be read", async () => {
    // Without the before-state the audit entry would be a guess, and an unattributable
    // change to what a machine records is the one thing this table exists to prevent.
    const { client, calls } = fakeSupabase({
      devices: [{ data: { id: DEVICE, profile_id: ALICE } }],
      device_collection_settings: [{ error: { message: "timeout" } }],
    });
    const app = await buildTestApp({ supabase: client, session: manager });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/devices/${DEVICE}/collection`,
      payload: { types: { screenshots: true } },
    });

    expect(res.statusCode).toBe(500);
    expect(forTable(calls, "device_collection_settings")).toHaveLength(1);
    expect(forTable(calls, "audit_log_entries")).toHaveLength(0);
  });
});
