import { canViewOthers, type SessionProfile } from "@aems/auth";
import {
  DATA_TYPE_IDS,
  DATA_TYPE_LABEL,
  effectiveTypes,
  pendingTypes,
  type DataTypeId,
  type Json,
} from "@aems/types";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";

import { recordAudit } from "../lib/audit.js";
import { sendInBackground } from "../lib/email/mailer.js";
import { collectionChangedEmail, nameOrEmail } from "../lib/email/templates.js";
import { validationFailure } from "../lib/validation.js";
import { issueDeviceToken } from "../lib/device-token.js";
import {
  CODE_TTL_MS,
  codeRejection,
  generateCode,
  hashCode,
  normaliseCode,
} from "../lib/enrollment-code.js";
import { collectionDenial, deniedTypesFor, resolveCollection } from "../plugins/context.js";

const KNOWN_TYPES = new Set<string>(DATA_TYPE_IDS);

/** Body accepted when redeeming a code. Same device facts, plus the code itself. */
const enrollWithCodeSchema = z.object({
  code: z.string().min(4).max(40),
});

const mintCodeSchema = z.object({
  // Omit it and you are enrolling your own machine, which is the common case.
  profileId: z.string().uuid().optional(),
  /**
   * Which kind of machine this code is for (migration …0018).
   *
   * Optional, so an older dashboard that does not send it keeps working and its codes
   * stay redeemable by anything — but the dialog now always sends it, because scope is
   * chosen against a platform's vocabulary. Offering Screenshots for a phone, or
   * Location for a laptop, is offering a choice that does nothing.
   */
  platform: z.enum(["windows", "macos", "android"]).optional(),
  /**
   * Types this machine must NOT collect, chosen when the code is minted.
   *
   * Still a deny list even now that the code names a platform. An allow list would be
   * frozen at mint time: a data type added to the product later would be denied on
   * every code already issued, and on every device that redeemed one. Absent means
   * everything the platform supports, which is what makes "no policy" the safe default.
   */
  deniedTypes: z
    .array(z.string())
    .max(DATA_TYPE_IDS.length)
    .default([])
    .refine((types) => types.every((type) => KNOWN_TYPES.has(type)), {
      message: `deniedTypes must be drawn from ${DATA_TYPE_IDS.join(", ")}`,
    })
    .transform((types) => [...new Set(types)] as DataTypeId[]),
});

/**
 * Manager-only change to a live device's scope.
 *
 * Keys are validated against the vocabulary rather than typed as a `z.record` of the
 * enum, because this body is written straight into a CHECK-constrained column and the
 * refusal should name the field rather than arrive as a Postgres error.
 */
const collectionPatchSchema = z.object({
  types: z
    .record(z.string(), z.boolean())
    .refine((types) => Object.keys(types).length > 0, { message: "types must not be empty" })
    .refine((types) => Object.keys(types).every((type) => KNOWN_TYPES.has(type)), {
      message: `types keys must be drawn from ${DATA_TYPE_IDS.join(", ")}`,
    }),
});

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
   * The decisions on record for one device, newest first, with the name attached.
   *
   * The embed names its foreign key explicitly because `profiles` is reachable from
   * this table by more than one path once `devices` is joined; `pnpm check:wiring`
   * verifies the constraint name exists.
   */
  async function readCollection(companyId: string, deviceId: string) {
    const { data } = await app.supabase
      .from("device_collection_settings")
      .select(
        "data_type, enabled, changed_at, profiles!device_collection_settings_changed_by_fkey(full_name)",
      )
      .eq("company_id", companyId)
      .eq("device_id", deviceId)
      .order("data_type");

    return (data ?? []).map((row) => {
      const changedBy = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      return {
        dataType: row.data_type,
        enabled: row.enabled,
        // Null when the person who made the change has left; the decision outlives them.
        changedByName: changedBy?.full_name ?? null,
        changedAt: row.changed_at,
      };
    });
  }

  /**
   * Creates the device row, mints its token and answers the agent.
   *
   * Shared by both enrolment paths so a machine bound with a code is byte-identical
   * to one bound with a session. Two copies of this would drift, and the thing that
   * drifted would be which policy the device thinks it is under.
   */
  async function completeEnrolment(
    reply: FastifyReply,
    ids: { companyId: string; profileId: string; actorId: string },
    body: z.infer<typeof enrollSchema>,
    audit: Record<string, unknown>,
    /**
     * The scope chosen when the code was minted, read off the code row rather than
     * sent by the agent — `/enroll-with-code` is unauthenticated by design, so nothing
     * the redeeming machine says about its own scope can be trusted.
     *
     * A parameter rather than a lookup inside this function, so both enrolment paths
     * stay byte-identical: the session path simply has no code to read one from.
     */
    scope?: { deniedTypes: DataTypeId[]; changedBy: string | null },
  ) {
    const { data: device, error } = await app.supabase
      .from("devices")
      .insert({
        company_id: ids.companyId,
        profile_id: ids.profileId,
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
      return {
        sent: reply
          .code(500)
          .send({ error: "enroll_failed", message: error?.message ?? "Could not enrol device", statusCode: 500 }),
        device: null,
      };
    }

    const denied = scope?.deniedTypes ?? [];

    if (denied.length > 0) {
      const { error: scopeError } = await app.supabase.from("device_collection_settings").insert(
        denied.map((dataType) => ({
          company_id: ids.companyId,
          device_id: device.id,
          data_type: dataType,
          enabled: false,
          changed_by: scope?.changedBy ?? null,
        })),
      );

      // Refused rather than enrolled wide open. The alternative is a machine that
      // collects everything because a write nobody saw fail did not land.
      if (scopeError) {
        await app.supabase.from("devices").delete().eq("id", device.id);
        return {
          sent: reply.code(500).send({
            error: "enroll_failed",
            message: "Could not record what this device may collect, so it was not enrolled",
            statusCode: 500,
          }),
          device: null,
        };
      }
    }

    const { data: policy } = await app.supabase
      .from("policies")
      .select("version, name, screenshot_interval_seconds, idle_threshold_seconds, tracked_categories")
      .eq("company_id", ids.companyId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!policy) {
      return {
        sent: reply.code(409).send({
          error: "no_policy",
          message: "This company has no monitoring policy yet — an admin must create one first",
          statusCode: 409,
        }),
        device: null,
      };
    }

    await recordAudit(
      app.supabase,
      {
        companyId: ids.companyId,
        actorId: ids.actorId,
        action: "device.enrolled",
        targetType: "device",
        targetId: device.id,
        metadata: { platform: body.platform, label: body.label, deniedTypes: denied, ...audit } as Json,
      },
      app.log,
    );

    return {
      sent: null,
      device,
      payload: {
        deviceId: device.id,
        companyId: ids.companyId,
        profileId: ids.profileId,
        deviceToken: issueDeviceToken(
          {
            deviceId: device.id,
            companyId: ids.companyId,
            profileId: ids.profileId,
            issuedAt: Date.now(),
          },
          app.env.DEVICE_TOKEN_SECRET,
        ),
        // Freshly enrolled devices always need consent before collecting anything.
        consentRequired: true,
        // What this machine may collect, so the consent screen lists exactly that and
        // does not ask an employee to agree to something the server would refuse.
        // `null` for granted: nothing has been agreed to yet, and a null narrows nothing.
        collection: effectiveTypes(body.platform, denied, null),
        policy: {
          version: policy.version,
          name: policy.name,
          screenshotIntervalSeconds: policy.screenshot_interval_seconds,
          idleThresholdSeconds: policy.idle_threshold_seconds,
          trackedCategories: policy.tracked_categories,
        },
      },
    };
  }

  /**
   * Mints a sign-in code for the dashboard's Devices → Add device.
   *
   * Anyone may mint one for themselves — that is the self-service path, and it is the
   * only reason an employee needs the dashboard at all before their agent runs.
   * Minting one for someone ELSE is a manager's act, because it hands over the right
   * to bind a machine that will report under that person's name.
   */
  app.post("/enrollment-codes", { preHandler: app.requireUser }, async (request, reply) => {
    const parsed = mintCodeSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_body"));
    }

    const session = request.session!;
    const subjectId = parsed.data.profileId ?? session.profileId;

    if (subjectId !== session.profileId && !canViewOthers(session.role)) {
      return reply.code(403).send({
        error: "forbidden",
        message: "You can only generate a code for your own device",
        statusCode: 403,
      });
    }

    // Company-scoped: the service-role key bypasses RLS, so this lookup is the whole
    // tenant boundary. It also refuses a deactivated person, because a code is a way
    // back into collection and off-boarding must not leave one lying around.
    const { data: subject } = await app.supabase
      .from("profiles")
      .select("id, full_name, email, deactivated_at")
      .eq("id", subjectId)
      .eq("company_id", session.companyId)
      .maybeSingle();

    if (!subject) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "No such employee in your company", statusCode: 404 });
    }

    if (subject.deactivated_at !== null) {
      return reply.code(409).send({
        error: "employee_deactivated",
        message: "Reactivate this employee before enrolling a device for them",
        statusCode: 409,
      });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

    const { error } = await app.supabase.from("device_enrollment_codes").insert({
      company_id: session.companyId,
      profile_id: subjectId,
      code_hash: hashCode(code),
      expires_at: expiresAt,
      created_by: session.profileId,
      denied_types: parsed.data.deniedTypes,
      // Recorded so redemption can refuse the wrong kind of machine, and so the audit
      // trail says what the admin was choosing scope FOR.
      platform: parsed.data.platform ?? null,
    });

    if (error) {
      return reply
        .code(500)
        .send({ error: "code_failed", message: error.message, statusCode: 500 });
    }

    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "device.enrollment_code_issued",
        targetType: "profile",
        targetId: subjectId,
        // The code itself is deliberately absent: an audit log readable by admins is
        // not a place to leave a live credential. The scope is not a credential.
        metadata: { expiresAt, deniedTypes: parsed.data.deniedTypes } as Json,
      },
      app.log,
    );

    // The only time the plaintext exists outside the agent's hands.
    return {
      code,
      expiresAt,
      profileId: subjectId,
      fullName: subject.full_name,
      email: subject.email,
    };
  });

  /**
   * Enrolment by code. **Deliberately unauthenticated** — the code IS the credential.
   *
   * This is what makes the product usable: an employee reads eight characters off the
   * dashboard and types them into the agent, instead of pasting an access token that
   * no screen in the product will ever show them.
   */
  app.post("/enroll-with-code", async (request, reply) => {
    const parsed = enrollSchema.merge(enrollWithCodeSchema).safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_body"));
    }

    const body = parsed.data;

    // Looked up BY HASH, so there is no query here that could enumerate codes.
    const { data: row } = await app.supabase
      .from("device_enrollment_codes")
      .select("id, company_id, profile_id, expires_at, consumed_at, denied_types, created_by, platform")
      .eq("code_hash", hashCode(body.code))
      .maybeSingle();

    const rejection = codeRejection(row, Date.now());
    if (rejection) return reply.code(rejection.statusCode).send(rejection);

    /*
     * The right kind of machine for this code.
     *
     * Not tidiness. Scope was chosen against one platform's vocabulary, so a code minted
     * for Android and redeemed by a laptop applies a phone's deny list to a machine with
     * different capabilities — quietly collecting things the admin believed they had
     * excluded, because the checkbox that would have excluded them was never shown.
     *
     * Null platform means a code minted before …0018: those accept anything, as they
     * always did. Reported as `invalid_code` in the same words as every other refusal on
     * this route — an unauthenticated endpoint must not tell a caller *why* a code was
     * refused, or it becomes an oracle for what codes exist.
     */
    // `== null` catches undefined as well as null, and both mean the same thing here:
    // no platform was recorded, so anything may redeem it. Strict `!== null` refused
    // every code that predates …0018 — the exact devices this was supposed to leave
    // alone — because a row selected before the column existed reads as undefined.
    if (row!.platform != null && row!.platform !== body.platform) {
      app.log.warn(
        { codePlatform: row!.platform, devicePlatform: body.platform },
        "enrolment code redeemed by the wrong platform",
      );
      return reply.code(401).send({
        error: "invalid_code",
        message: "That sign-in code is not valid any more. Generate a new one from the dashboard.",
        statusCode: 401,
      });
    }

    // Monitoring disabled or the person off-boarded between minting and redeeming.
    const { data: subject } = await app.supabase
      .from("profiles")
      .select("id, deactivated_at")
      .eq("id", row!.profile_id)
      .maybeSingle();

    if (!subject || subject.deactivated_at !== null) {
      return reply.code(401).send({
        error: "invalid_code",
        message: "That sign-in code is not valid any more. Generate a new one from the dashboard.",
        statusCode: 401,
      });
    }

    const result = await completeEnrolment(
      reply,
      { companyId: row!.company_id, profileId: row!.profile_id, actorId: row!.profile_id },
      body,
      { via: "enrollment_code" },
      { deniedTypes: row!.denied_types ?? [], changedBy: row!.created_by },
    );
    if (result.sent) return result.sent;

    // Burned only AFTER the device exists. The reverse order would consume the code
    // and then fail to enrol, leaving the person holding a dead code and no device —
    // the one failure mode they cannot recover from without asking for another.
    //
    // The `is("consumed_at", null)` filter is the race guard: two agents redeeming the
    // same code concurrently both pass the check above, and exactly one wins here.
    const { data: burned } = await app.supabase
      .from("device_enrollment_codes")
      .update({ consumed_at: new Date().toISOString(), consumed_device_id: result.device!.id })
      .eq("id", row!.id)
      .is("consumed_at", null)
      .select("id")
      .maybeSingle();

    if (!burned) {
      // Someone else redeemed it first. Undo the device we just made rather than
      // leaving an orphan bound to a code that produced two machines.
      await app.supabase.from("devices").delete().eq("id", result.device!.id);
      return reply.code(401).send({
        error: "invalid_code",
        message: "That sign-in code is not valid any more. Generate a new one from the dashboard.",
        statusCode: 401,
      });
    }

    return result.payload;
  });

  /**
   * Enrolment under the employee's own Supabase session.
   *
   * Kept for scripts and tests. The agent uses the code path above, because a person
   * cannot be handed a JWT.
   */
  app.post("/enroll", { preHandler: app.requireUser }, async (request, reply) => {
    const parsed = enrollSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_body"));
    }

    const session = request.session!;
    const result = await completeEnrolment(
      reply,
      { companyId: session.companyId, profileId: session.profileId, actorId: session.profileId },
      parsed.data,
      { via: "session" },
    );

    return result.sent ?? result.payload;
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

  /**
   * Keeps `last_seen_at` fresh — this is what drives online/idle/offline in the UI —
   * and carries the current collection scope back to the agent.
   *
   * The scope rides the heartbeat rather than a new endpoint because this already runs
   * every 60 seconds, already re-reads the device row, and is already the consent-exempt
   * channel a revocation travels on. A second poll would buy nothing but two arrays.
   * Every field past `ok` is additive, so an agent that ignores them keeps working.
   */
  app.post("/heartbeat", { preHandler: app.requireDevice }, async (request, reply) => {
    const parsed = heartbeatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_body"));
    }

    const device = request.device!;
    if (parsed.data.deviceId !== device.deviceId) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Token does not match device", statusCode: 403 });
    }

    const [, policyResult, consentResult, denied] = await Promise.all([
      app.supabase
        .from("devices")
        .update({ last_seen_at: new Date().toISOString(), status: "active" })
        .eq("id", device.deviceId),
      app.supabase
        .from("policies")
        .select("version")
        .eq("company_id", device.companyId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      app.supabase
        .from("consent_records")
        .select("granted_types")
        .eq("device_id", device.deviceId)
        .is("revoked_at", null)
        .maybeSingle(),
      deniedTypesFor(app.supabase, device.deviceId),
    ]);

    const policyVersion = policyResult.data?.version;

    // A failed settings read omits both arrays rather than guessing. Absent means "no
    // new information" to the agent, which keeps whatever it last heard; guessing
    // "nothing is denied" would tell it to resume a type an admin switched off.
    if (denied === null) {
      return { ok: true as const, ...(policyVersion ? { policyVersion } : {}) };
    }

    // No live consent means nothing may be collected at all, whatever the settings say.
    const granted = consentResult.data ? (consentResult.data.granted_types ?? null) : null;

    return {
      ok: true as const,
      ...(policyVersion ? { policyVersion } : {}),
      collection: consentResult.data ? effectiveTypes(device.platform, denied, granted) : [],
      pendingTypes: consentResult.data ? pendingTypes(device.platform, denied, granted) : [],
    };
  });

  /** Battery, network, storage, screen time. Append-only series. */
  app.post("/telemetry", { preHandler: app.requireDevice }, async (request, reply) => {
    const parsed = telemetrySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_body"));
    }

    const device = request.device!;

    // Battery, network and screen-active time are collected data, not liveness —
    // the same consent gate as /activity and /screenshots applies. Only
    // /heartbeat is exempt, because it carries no observation and is the channel
    // through which a revoked agent finds out it has been revoked.
    const consent = await resolveCollection(app.supabase, device);
    if (!consent.ok) {
      return reply
        .code(403)
        .send({ error: "consent_required", message: consent.message, statusCode: 403 });
    }

    if (!consent.types.has("telemetry")) {
      return reply.code(403).send(collectionDenial("telemetry"));
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
        .send(validationFailure(parsed.error, "invalid_body"));
    }

    const device = request.device!;

    // The list of software on someone's machine is monitoring data. Enrolment
    // reports inventory before consent is accepted, so without this gate a
    // device that never consented — or whose consent was withdrawn — would still
    // hand over its installed-application list.
    const consent = await resolveCollection(app.supabase, device);
    if (!consent.ok) {
      return reply
        .code(403)
        .send({ error: "consent_required", message: consent.message, statusCode: 403 });
    }

    if (!consent.types.has("installed_apps")) {
      return reply.code(403).send(collectionDenial("installed_apps"));
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
        .send(validationFailure(parsed.error, "invalid_body"));
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
        .send(validationFailure(parsedQuery.error, "invalid_query"));
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

  /**
   * A device's collection scope, with who last changed each entry.
   *
   * Only types somebody has made a decision about appear; everything else is permitted
   * by absence, which is why an empty list is the normal answer and not an error.
   *
   * `requireUser` guarded by `deviceReadDenial`, the same as the two reads above, so an
   * employee can read their own machine's scope without asking anyone — non-negotiable
   * #3. The attribution comes off the settings row rather than the audit log, because
   * `audit_log_entries` is readable by super admins only and a manager reading this
   * screen could not see it there.
   */
  app.get("/:deviceId/collection", { preHandler: app.requireUser }, async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    if (!deviceIdSchema.safeParse(deviceId).success) {
      return reply
        .code(400)
        .send({ error: "invalid_device_id", message: "deviceId must be a uuid", statusCode: 400 });
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

    return readCollection(session.companyId, deviceId);
  });

  /**
   * Narrow or widen what one machine collects.
   *
   * `requireManager`, matching `POST /:deviceId/primary` rather than the super-admin
   * routes either side: the person who knows what a given machine should be recording
   * is the manager responsible for it.
   *
   * Widening does not resume collection on its own. The server enforces
   * `granted ∩ allowed`, so a type switched back on is simply not collected until the
   * employee agrees to it — that is what the heartbeat's `pendingTypes` carries. The
   * reverse needs no re-consent: collecting less than was agreed is still covered.
   *
   * Re-enabling updates the row rather than deleting it. "Sam turned screenshots back
   * on on 9 Aug" is a fact the compliance surfaces have to be able to state, and a
   * deleted row states nothing.
   */
  app.patch("/:deviceId/collection", { preHandler: app.requireManager }, async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    if (!deviceIdSchema.safeParse(deviceId).success) {
      return reply
        .code(400)
        .send({ error: "invalid_device_id", message: "deviceId must be a uuid", statusCode: 400 });
    }

    const parsed = collectionPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationFailure(parsed.error, "invalid_body"));
    }

    const session = request.session!;
    const patch = parsed.data.types as Partial<Record<DataTypeId, boolean>>;

    // Company-scoped: the service-role key has already bypassed RLS, so this read is
    // the whole tenant boundary on a write that changes what a machine records.
    // `label` comes back for the email — it is how the owner tells this machine from
    // the other two assigned to them.
    const { data: device } = await app.supabase
      .from("devices")
      .select("id, profile_id, label")
      .eq("id", deviceId)
      .eq("company_id", session.companyId)
      .maybeSingle();

    if (!device) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "Device not found", statusCode: 404 });
    }

    const previous = await deniedTypesFor(app.supabase, deviceId);
    if (previous === null) {
      return reply.code(500).send({
        error: "collection_read_failed",
        message: "Could not read this device's current scope, so nothing was changed",
        statusCode: 500,
      });
    }

    const changedAt = new Date().toISOString();
    const entries = Object.entries(patch) as [DataTypeId, boolean][];

    const { error } = await app.supabase.from("device_collection_settings").upsert(
      entries.map(([dataType, enabled]) => ({
        company_id: session.companyId,
        device_id: deviceId,
        data_type: dataType,
        enabled,
        changed_by: session.profileId,
        changed_at: changedAt,
      })),
      { onConflict: "device_id,data_type" },
    );

    if (error) {
      return reply
        .code(500)
        .send({ error: "collection_write_failed", message: error.message, statusCode: 500 });
    }

    // Before and after, the same shape `policy.published` uses, so a mailer added later
    // reads the row the in-product notice reads rather than inventing a second source.
    const wasDenied = new Set(previous);
    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "collection.changed",
        targetType: "device",
        targetId: deviceId,
        metadata: {
          profileId: device.profile_id,
          before: Object.fromEntries(entries.map(([type]) => [type, !wasDenied.has(type)])),
          after: Object.fromEntries(entries),
        } as Json,
      },
      app.log,
    );

    /*
     * Tell the person whose device it is.
     *
     * Non-negotiable #1 makes consent the basis of collection, so a change to its
     * scope is a change to what they agreed to — and learning about that by accident
     * is what turns a workforce product into one people warn each other about.
     *
     * In the background: the database has already agreed, and this answer should not
     * wait on a mail provider or fail because of one. `sendInBackground` swallows
     * everything, so a bad address costs a log line and not the change.
     *
     * Only the types that actually moved are named. Re-sending the full list every
     * time trains people to stop reading it, and the one line that matters — what is
     * newly recorded — would be buried among six that did not change.
     */
    const moved = entries.filter(([type, enabled]) => wasDenied.has(type) === enabled);

    if (moved.length > 0) {
      const { data: owner } = await app.supabase
        .from("profiles")
        .select("email, full_name, companies(name)")
        .eq("id", device.profile_id)
        .maybeSingle();

      if (owner?.email) {
        const company = Array.isArray(owner.companies) ? owner.companies[0] : owner.companies;
        const message = collectionChangedEmail(
          {
            recipientName: nameOrEmail(owner.full_name, owner.email),
            companyName: company?.name ?? "your company",
            dashboardUrl: app.dashboardUrl,
          },
          {
            deviceLabel: device.label,
            changedByName: session.email,
            changes: moved.map(([type, enabled]) => ({
              label: DATA_TYPE_LABEL[type],
              enabled,
            })),
          },
        );

        sendInBackground(app.mailer, { ...message, to: owner.email }, app.log);
      }
    }

    return readCollection(session.companyId, deviceId);
  });

  /**
   * Names the machine whose activity and idle define this person's working hours.
   *
   * `requireManager`, not `requireSuperAdmin` like the two routes either side. Asked
   * for by name — the person who knows which machine is somebody's work computer is
   * their manager, not a company administrator. It is still a consequential setting:
   * it changes the hours a person is judged on, which is why it is audited.
   *
   * A separate route rather than a field on `PATCH /:deviceId`, because that one
   * reassigns ownership and revokes the outgoing owner's consent as it goes. Choosing
   * a primary device must never carry that.
   */
  app.post("/:deviceId/primary", { preHandler: app.requireManager }, async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const session = request.session!;

    if (!deviceIdSchema.safeParse(deviceId).success) {
      return reply
        .code(400)
        .send({ error: "invalid_device_id", message: "deviceId must be a uuid", statusCode: 400 });
    }

    // Company-scoped: the service-role key bypasses RLS, so this read is the tenant
    // boundary. A revoked device is refused because hours must not be defined by a
    // machine that has been told to stop reporting.
    const { data: device } = await app.supabase
      .from("devices")
      .select("id, profile_id, status, label")
      .eq("id", deviceId)
      .eq("company_id", session.companyId)
      .maybeSingle();

    if (!device) {
      return reply.code(404).send({ error: "not_found", message: "No such device", statusCode: 404 });
    }

    if (device.status === "revoked") {
      return reply.code(409).send({
        error: "device_revoked",
        message: "A revoked device cannot define working hours",
        statusCode: 409,
      });
    }

    // Cleared first, because `devices_one_primary_per_profile` is a unique index: two
    // rows claiming to be the system of record cannot both exist, and setting before
    // clearing would be refused by the database rather than swapping.
    await app.supabase
      .from("devices")
      .update({ is_primary: false })
      .eq("company_id", session.companyId)
      .eq("profile_id", device.profile_id)
      .eq("is_primary", true);

    const { data, error } = await app.supabase
      .from("devices")
      .update({ is_primary: true })
      .eq("id", deviceId)
      .eq("company_id", session.companyId)
      .select("id, is_primary")
      .maybeSingle();

    if (error || !data) {
      return reply.code(500).send({
        error: "primary_failed",
        message: error?.message ?? "Could not set the primary device",
        statusCode: 500,
      });
    }

    await recordAudit(
      app.supabase,
      {
        companyId: session.companyId,
        actorId: session.profileId,
        action: "device.primary_set",
        targetType: "device",
        targetId: deviceId,
        metadata: { profileId: device.profile_id, label: device.label } as Json,
      },
      app.log,
    );

    return data;
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
