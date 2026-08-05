import { buildTimeline, summarisePeriod } from "@aems/analytics";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const rangeSchema = z.object({
  profileId: z.string().uuid(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

const timelineSchema = rangeSchema.extend({
  bucketSeconds: z.coerce.number().int().min(60).max(86_400).default(3600),
});

/** How long a device may go quiet before the dashboard calls it offline. */
const OFFLINE_AFTER_MS = 2 * 60 * 1000;

/**
 * Ceiling on rows pulled into an aggregate.
 *
 * PostgREST caps a response at its own `max-rows` (1000 by default) and says nothing
 * when it does — the request succeeds and the numbers are simply wrong. Without an
 * explicit `.order()` it is not even deterministic *which* thousand you get. A real
 * eight-hour day passes a thousand focus intervals, so this was reachable in normal
 * use rather than at some theoretical limit.
 *
 * Set above PostgREST's own cap so the answer comes from here, and paired with an
 * explicit order so the window is at least the newest rows rather than an arbitrary
 * slice. `truncated` is returned to the caller: a total that silently omits half a
 * day is worse than one that admits it is partial.
 */
const MAX_AGGREGATE_ROWS = 5000;

/**
 * How far back an unclosed idle stretch is still believed.
 *
 * An agent killed mid-idle leaves `idle_end_at` null forever. Without a bound, that
 * row would keep a person amber on the live board indefinitely — a stale claim about
 * somebody's working day, which is exactly the kind of wrongness this product cannot
 * afford. Generous enough to cover a long lunch, short enough that yesterday's crash
 * does not describe today.
 */
const STALE_IDLE_AFTER_MS = 4 * 60 * 60 * 1000;

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  /** Headline numbers for one person over one window. */
  app.get("/productivity", { preHandler: app.requireUser }, async (request, reply) => {
    const parsed = rangeSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_query", message: parsed.error.message, statusCode: 400 });
    }

    const session = request.session!;
    const { profileId, from, to } = parsed.data;

    if (profileId !== session.profileId && session.role === "employee") {
      return reply.code(403).send({ error: "forbidden", message: "Not your data", statusCode: 403 });
    }

    const [{ data: activity }, { data: idle }] = await Promise.all([
      app.supabase
        .from("activity_events")
        .select("*")
        .eq("company_id", session.companyId)
        .eq("profile_id", profileId)
        .lte("started_at", to)
        .or(`ended_at.gte.${from},ended_at.is.null`)
        .order("started_at", { ascending: false })
        .limit(MAX_AGGREGATE_ROWS),
      app.supabase
        .from("idle_events")
        .select("*")
        .eq("company_id", session.companyId)
        .eq("profile_id", profileId)
        .lte("idle_start_at", to)
        .or(`idle_end_at.gte.${from},idle_end_at.is.null`)
        .order("idle_start_at", { ascending: false })
        .limit(MAX_AGGREGATE_ROWS),
    ]);

    const summary = summarisePeriod({
      profileId,
      periodStart: from,
      periodEnd: to,
      activity: activity ?? [],
      idle: idle ?? [],
    });

    return {
      ...summary,
      truncated:
        (activity?.length ?? 0) >= MAX_AGGREGATE_ROWS || (idle?.length ?? 0) >= MAX_AGGREGATE_ROWS,
    };
  });

  /** The timeline strip — the centrepiece of the employee page. */
  app.get("/timeline", { preHandler: app.requireUser }, async (request, reply) => {
    const parsed = timelineSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_query", message: parsed.error.message, statusCode: 400 });
    }

    const session = request.session!;
    const { profileId, from, to, bucketSeconds } = parsed.data;

    if (profileId !== session.profileId && session.role === "employee") {
      return reply.code(403).send({ error: "forbidden", message: "Not your data", statusCode: 403 });
    }

    const [{ data: activity }, { data: idle }, { data: screenshots }, { data: device }] =
      await Promise.all([
        app.supabase
          .from("activity_events")
          .select("*")
          .eq("company_id", session.companyId)
          .eq("profile_id", profileId)
          .lte("started_at", to)
          .or(`ended_at.gte.${from},ended_at.is.null`)
          .order("started_at", { ascending: false })
          .limit(MAX_AGGREGATE_ROWS),
        app.supabase
          .from("idle_events")
          .select("*")
          .eq("company_id", session.companyId)
          .eq("profile_id", profileId)
          .lte("idle_start_at", to)
          .or(`idle_end_at.gte.${from},idle_end_at.is.null`)
          .order("idle_start_at", { ascending: false })
          .limit(MAX_AGGREGATE_ROWS),
        app.supabase
          .from("screenshots")
          .select("*")
          .eq("company_id", session.companyId)
          .eq("profile_id", profileId)
          .gte("captured_at", from)
          .lte("captured_at", to)
          .order("captured_at", { ascending: false })
          .limit(MAX_AGGREGATE_ROWS),
        app.supabase
          .from("devices")
          .select("id")
          .eq("profile_id", profileId)
          .order("last_seen_at", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle(),
      ]);

    return buildTimeline({
      profileId,
      deviceId: device?.id ?? "",
      periodStart: from,
      periodEnd: to,
      bucketSeconds,
      activity: activity ?? [],
      idle: idle ?? [],
      screenshots: screenshots ?? [],
    });
  });

  /** Website usage by domain — scope §2.5. */
  app.get("/websites", { preHandler: app.requireUser }, async (request, reply) => {
    const parsed = rangeSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_query", message: parsed.error.message, statusCode: 400 });
    }

    const session = request.session!;
    const { profileId, from, to } = parsed.data;

    if (profileId !== session.profileId && session.role === "employee") {
      return reply.code(403).send({ error: "forbidden", message: "Not your data", statusCode: 403 });
    }

    const { data } = await app.supabase
      .from("activity_events")
      .select("domain, started_at, ended_at")
      .eq("company_id", session.companyId)
      .eq("profile_id", profileId)
      .not("domain", "is", null)
      .gte("started_at", from)
      .lte("started_at", to);

    const totals = new Map<string, number>();
    const windowEnd = Date.parse(to);

    for (const row of data ?? []) {
      if (!row.domain) continue;
      const start = Date.parse(row.started_at);
      const end = row.ended_at ? Date.parse(row.ended_at) : windowEnd;
      const seconds = Math.max(0, Math.round((end - start) / 1000));
      totals.set(row.domain, (totals.get(row.domain) ?? 0) + seconds);
    }

    return [...totals.entries()]
      .map(([domain, seconds]) => ({ domain, seconds }))
      .sort((a, b) => b.seconds - a.seconds);
  });

  /** Dashboard home KPIs — "how is my company doing today?" */
  app.get("/overview", { preHandler: app.requireManager }, async (request) => {
    const session = request.session!;
    const now = Date.now();
    const dayStart = new Date(new Date(now).setHours(0, 0, 0, 0)).toISOString();

    const [{ data: employees }, { data: devices }, { data: sessions }] = await Promise.all([
      app.supabase
        .from("profiles")
        .select("id", { count: "exact" })
        .eq("company_id", session.companyId),
      app.supabase
        .from("devices")
        .select("id, profile_id, last_seen_at, status")
        .eq("company_id", session.companyId)
        .neq("status", "revoked"),
      app.supabase
        .from("work_sessions")
        .select("profile_id, clock_in_at, clock_out_at")
        .eq("company_id", session.companyId)
        .gte("clock_in_at", dayStart),
    ]);

    const activeProfiles = new Set(
      (devices ?? [])
        .filter((d) => d.last_seen_at && now - Date.parse(d.last_seen_at) < OFFLINE_AFTER_MS)
        .map((d) => d.profile_id),
    );

    const trackedSeconds = (sessions ?? []).reduce((sum, s) => {
      const start = Date.parse(s.clock_in_at);
      const end = s.clock_out_at ? Date.parse(s.clock_out_at) : now;
      return sum + Math.max(0, (end - start) / 1000);
    }, 0);

    return {
      totalEmployees: employees?.length ?? 0,
      activeNow: activeProfiles.size,
      workingToday: new Set((sessions ?? []).map((s) => s.profile_id)).size,
      totalHoursToday: Number((trackedSeconds / 3600).toFixed(1)),
    };
  });

  /** Live workforce strip: who is active, idle, or offline right now. */
  app.get("/live", { preHandler: app.requireManager }, async (request) => {
    const session = request.session!;
    const now = Date.now();

    const [{ data }, { data: openIdle }] = await Promise.all([
      app.supabase
        .from("devices")
        .select("id, platform, label, last_seen_at, status, profiles!inner(id, full_name, email)")
        .eq("company_id", session.companyId)
        .neq("status", "revoked")
        .order("last_seen_at", { ascending: false, nullsFirst: false }),
      // An idle stretch with no end is one still running. This is the only source
      // for the amber row scope 4.3 shows literally — without it `StatusDot` can
      // render three states but `/live` can only ever produce two, so "Sarah, Idle"
      // was unreachable no matter what the agent reported.
      app.supabase
        .from("idle_events")
        .select("device_id, idle_start_at")
        .eq("company_id", session.companyId)
        .is("idle_end_at", null)
        .gte("idle_start_at", new Date(now - STALE_IDLE_AFTER_MS).toISOString()),
    ]);

    const idleSince = new Map(
      (openIdle ?? []).map((row) => [row.device_id, row.idle_start_at] as const),
    );

    return (data ?? []).map((device) => {
      const profile = Array.isArray(device.profiles) ? device.profiles[0] : device.profiles;
      const lastSeen = device.last_seen_at ? Date.parse(device.last_seen_at) : null;
      const online = lastSeen !== null && now - lastSeen < OFFLINE_AFTER_MS;
      const idleAt = idleSince.get(device.id) ?? null;

      // Offline wins over idle: a laptop that stopped reporting mid-idle-stretch is
      // not "idle", it is gone, and leaving it amber would imply we still know.
      const status = !online ? ("offline" as const) : idleAt ? ("idle" as const) : ("active" as const);

      return {
        deviceId: device.id,
        platform: device.platform,
        label: device.label,
        profileId: profile?.id ?? null,
        fullName: profile?.full_name ?? null,
        email: profile?.email ?? null,
        lastSeenAt: device.last_seen_at,
        idleSince: status === "idle" ? idleAt : null,
        status,
      };
    });
  });
};
