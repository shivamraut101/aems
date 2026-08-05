import {
  DEFAULT_SLOT_SECONDS,
  SLOT_SECONDS_OPTIONS,
  buildDayTimeline,
  resolveScreenshots,
  screenshotPaths,
  screenshotsInSlot,
  signedUrlIndex,
  summarisePeriod,
} from "@aems/analytics";
import { canViewOthers, type SessionProfile } from "@aems/auth";
import { AEMS_BUCKET } from "@aems/supabase";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

// One definition of how long a screenshot link lives, shared with the route that
// already owns that decision. Two constants would drift.
import { SIGNED_URL_TTL_SECONDS } from "./screenshots.js";

const rangeSchema = z.object({
  profileId: z.string().uuid(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

/**
 * The grid is a fixed set, not a free range.
 *
 * The ribbon, the screenshot review and the app list line up because they share one
 * unit. A caller-chosen width lets one view ask for a grid the other two do not use,
 * and the three silently stop agreeing about which capture belongs to which stretch.
 */
const timelineSchema = rangeSchema.extend({
  bucketSeconds: z.coerce
    .number()
    .int()
    .refine((value) => (SLOT_SECONDS_OPTIONS as readonly number[]).includes(value), {
      message: `bucketSeconds must be one of ${SLOT_SECONDS_OPTIONS.join(", ")}`,
    })
    .default(DEFAULT_SLOT_SECONDS),
});

/**
 * `profileId` is required for the two per-person kinds and meaningless for the
 * company one, so the rule lives in the schema rather than in the handler. Asking
 * for a daily summary without saying whose is a malformed request, not an empty one.
 */
export const insightsSchema = z
  .object({
    kind: z.enum(["daily", "weekly", "insight"]),
    profileId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(90).default(14),
  })
  .refine((value) => value.kind === "insight" || value.profileId !== undefined, {
    message: "profileId is required for daily and weekly summaries",
    path: ["profileId"],
  });

export type InsightsQuery = z.infer<typeof insightsSchema>;

/**
 * May this caller read these summaries? Pure, so it can be tested without a database.
 *
 * Split out of the handler deliberately: this is the whole of the authorisation
 * decision for AI summaries, and inline in a route it could only be exercised by
 * standing up Postgres, Supabase Auth and a signed JWT.
 */
export function insightsDenial(
  query: Pick<InsightsQuery, "kind" | "profileId">,
  session: Pick<SessionProfile, "role" | "profileId">,
): { statusCode: 403; message: string } | null {
  // `canViewOthers`, not `role !== "employee"`. Asking what a role MAY do fails closed
  // when a role is added later and forgotten here (`ROLE_RANK[unknown]` is undefined,
  // and `undefined >= 1` is false); asking what it is NOT fails open, handing the new
  // role manager rights by default.
  //
  // Note `@aems/auth` describes itself as a UX layer with the database as the real
  // boundary. That holds for the dashboard's own Supabase reads, where RLS is enforced.
  // It does NOT hold here: `app.supabase` is the service-role client and bypasses RLS
  // entirely, so on this path these checks are the only boundary there is.
  if (canViewOthers(session.role)) return null;

  // The company insight aggregates colleagues, so it is other people's data under
  // another name and an employee may not have it whatever `profileId` they send.
  //
  // Order relative to the ownership check below is cosmetic, not security: both are
  // sequential denials, so either ordering refuses the same requests and only the
  // message changes. Verified by mutation — swapping them leaves the suite green.
  if (query.kind === "insight") {
    return { statusCode: 403, message: "Company insights are for managers and admins" };
  }

  if (query.profileId !== session.profileId) {
    return { statusCode: 403, message: "Not your data" };
  }

  return null;
}

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

    if (profileId !== session.profileId && !canViewOthers(session.role)) {
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

    if (profileId !== session.profileId && !canViewOthers(session.role)) {
      return reply.code(403).send({ error: "forbidden", message: "Not your data", statusCode: 403 });
    }

    // Five sources, not two. Scope §2.7's worked example opens with "09:00 Login" and
    // §2.2 makes break time a first-class number — neither is expressible from
    // activity and idle alone, and both tables were already being written and read by
    // nothing. The device query is gone: stamping one device's id onto every entry was
    // a fiction the moment a person had a laptop and a phone.
    const [
      { data: activity },
      { data: idle },
      { data: breaks },
      { data: sessions },
      { data: screenshots },
    ] = await Promise.all([
      app.supabase
        .from("activity_events")
        .select("app_name, window_title, category, started_at, ended_at")
        .eq("company_id", session.companyId)
        .eq("profile_id", profileId)
        .lte("started_at", to)
        .or(`ended_at.gte.${from},ended_at.is.null`)
        .order("started_at", { ascending: false })
        .limit(MAX_AGGREGATE_ROWS),
      app.supabase
        .from("idle_events")
        .select("idle_start_at, idle_end_at")
        .eq("company_id", session.companyId)
        .eq("profile_id", profileId)
        .lte("idle_start_at", to)
        .or(`idle_end_at.gte.${from},idle_end_at.is.null`)
        .order("idle_start_at", { ascending: false })
        .limit(MAX_AGGREGATE_ROWS),
      app.supabase
        .from("break_events")
        .select("break_start_at, break_end_at")
        .eq("company_id", session.companyId)
        .eq("profile_id", profileId)
        .lte("break_start_at", to)
        .or(`break_end_at.gte.${from},break_end_at.is.null`)
        .order("break_start_at", { ascending: false })
        .limit(MAX_AGGREGATE_ROWS),
      app.supabase
        .from("work_sessions")
        .select("clock_in_at, clock_out_at")
        .eq("company_id", session.companyId)
        .eq("profile_id", profileId)
        .lte("clock_in_at", to)
        .or(`clock_out_at.gte.${from},clock_out_at.is.null`)
        .order("clock_in_at", { ascending: false })
        .limit(MAX_AGGREGATE_ROWS),
      app.supabase
        .from("screenshots")
        .select("id, captured_at, storage_path, thumbnail_path, blurred, work_session_id")
        .eq("company_id", session.companyId)
        .eq("profile_id", profileId)
        .gte("captured_at", from)
        .lte("captured_at", to)
        .order("captured_at", { ascending: false })
        .limit(MAX_AGGREGATE_ROWS),
    ]);

    // The bucket is private, so an id alone renders nothing. Sign every capture on the
    // page in one call — never one per slot, and never one per tile from the browser.
    const refs = screenshotsInSlot(screenshots ?? [], {
      start: Date.parse(from),
      end: Date.parse(to),
    });
    const paths = screenshotPaths(refs);
    const { data: signed } = paths.length
      ? await app.supabase.storage.from(AEMS_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
      : { data: [] };

    return buildDayTimeline({
      profileId,
      periodStart: from,
      periodEnd: to,
      slotSeconds: bucketSeconds,
      activity: activity ?? [],
      idle: idle ?? [],
      breaks: breaks ?? [],
      sessions: sessions ?? [],
      screenshots: resolveScreenshots(refs, signedUrlIndex(signed ?? [])),
      // Any one source hitting the cap makes every number here a floor. Saying so is
      // the difference between a partial day and a wrong day.
      truncated: [activity, idle, breaks, sessions, screenshots].some(
        (rows) => (rows?.length ?? 0) >= MAX_AGGREGATE_ROWS,
      ),
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

    if (profileId !== session.profileId && !canViewOthers(session.role)) {
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

    const [{ count: employeeCount }, { data: devices }, { data: sessions }] = await Promise.all([
      // `head: true` asks Postgres for the count and no rows. The previous version
      // requested `{ count: "exact" }` and then returned `employees?.length`, which
      // throws the count away and reports however many rows PostgREST was willing
      // to return — capped at its max-rows setting. It also counted off-boarded
      // people, so the moment an admin deactivated someone the home KPI said 4
      // while the People page said 3, on the same screen at the same moment.
      app.supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("company_id", session.companyId)
        .is("deactivated_at", null),
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
      totalEmployees: employeeCount ?? 0,
      activeNow: activeProfiles.size,
      workingToday: new Set((sessions ?? []).map((s) => s.profile_id)).size,
      totalHoursToday: Number((trackedSeconds / 3600).toFixed(1)),
    };
  });

  /**
   * Live workforce strip: who is active, idle, or offline right now.
   *
   * One row per PERSON, not per device. This used to select from `devices` with
   * `profiles!inner`, which answered a subtly different question and got both
   * ends wrong: an employee who had not enrolled anything was missing from the
   * strip entirely (a company of three with one laptop rendered a single row),
   * and anyone with a laptop and a phone was listed twice as if they were two
   * people. `docs/scope.md` §4.3 asks for the workforce, so the workforce —
   * `profiles` — is what this is driven by, with devices joined on.
   *
   * Deactivated people are excluded so this agrees with the roster.
   */
  app.get("/live", { preHandler: app.requireManager }, async (request) => {
    const session = request.session!;
    const now = Date.now();

    const [{ data: people }, { data: openIdle }] = await Promise.all([
      app.supabase
        .from("profiles")
        .select("id, full_name, email, devices(id, platform, label, last_seen_at, status)")
        .eq("company_id", session.companyId)
        .is("deactivated_at", null)
        .order("full_name", { ascending: true }),
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

    const seenAt = (value: string | null): number => {
      const parsed = value ? Date.parse(value) : NaN;
      return Number.isFinite(parsed) ? parsed : -Infinity;
    };

    return (people ?? []).map((person) => {
      // A revoked device is not evidence: its token no longer works, so whatever
      // it last reported says nothing about where the person is now.
      const usable = (person.devices ?? []).filter((d) => d.status !== "revoked");

      // The most recently heard-from device speaks for the person — a laptop and
      // a phone both enrolled is normal, and the quiet one is not the interesting
      // answer. Mirrors `resolvePresence` in the dashboard so the strip and the
      // employee header cannot disagree about the same person.
      const device =
        usable.length === 0
          ? null
          : usable.reduce((newest, candidate) =>
              seenAt(candidate.last_seen_at) > seenAt(newest.last_seen_at) ? candidate : newest,
            );

      const lastSeen = device ? seenAt(device.last_seen_at) : -Infinity;
      const online = Number.isFinite(lastSeen) && now - lastSeen < OFFLINE_AFTER_MS;
      const idleAt = device ? (idleSince.get(device.id) ?? null) : null;

      // Offline wins over idle: a laptop that stopped reporting mid-idle-stretch is
      // not "idle", it is gone, and leaving it amber would imply we still know.
      const status = !online ? ("offline" as const) : idleAt ? ("idle" as const) : ("active" as const);

      return {
        // Null for someone who has enrolled nothing. The dashboard keys the strip
        // on `profileId` for exactly that reason.
        deviceId: device?.id ?? null,
        platform: device?.platform ?? null,
        label: device?.label ?? null,
        profileId: person.id,
        fullName: person.full_name,
        email: person.email,
        lastSeenAt: device?.last_seen_at ?? null,
        idleSince: status === "idle" ? idleAt : null,
        status,
      };
    });
  });

  /**
   * Summaries the AI worker has already written. Read-only — nothing here calls a model.
   *
   * `docs/scope.md` §6 names three: a daily employee summary, a weekly one, and
   * company-wide insights. The first two belong to a person and the third does not,
   * which is why `profile_id` is nullable on the table and why `kind` alone decides
   * whether `profileId` is required.
   */
  app.get("/insights", { preHandler: app.requireUser }, async (request, reply) => {
    const parsed = insightsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_query", message: parsed.error.message, statusCode: 400 });
    }

    const session = request.session!;
    const { kind, profileId, limit } = parsed.data;

    // The dashboard already hides the company option from employees, and only ever
    // asks for the signed-in person's own summaries. Both are courtesies, not
    // controls — the request still has to be refused here.
    const denial = insightsDenial({ kind, profileId }, session);
    if (denial !== null) {
      return reply
        .code(denial.statusCode)
        .send({ error: "forbidden", message: denial.message, statusCode: denial.statusCode });
    }

    let query = app.supabase
      .from("ai_summaries")
      .select("*")
      .eq("company_id", session.companyId)
      .eq("kind", kind);

    // A company insight has no owner, so filtering it by profile would return nothing
    // at all rather than the row the caller asked for.
    query = kind === "insight" ? query.is("profile_id", null) : query.eq("profile_id", profileId!);

    const { data } = await query.order("period_start", { ascending: false }).limit(limit);

    return data ?? [];
  });
};
