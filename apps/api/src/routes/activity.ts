import {
  categorizeEvent,
  compileRules,
  type CategoryRule,
  type CompiledRuleSet,
  type Productivity,
} from "@aems/analytics";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { canViewOthers } from "@aems/auth";

import { resolveCollection } from "../plugins/context.js";
import { validationFailure } from "../lib/validation.js";

const activityEventSchema = z.object({
  clientEventId: z.string().uuid(),
  appName: z.string().min(1).max(200),
  windowTitle: z.string().max(500).nullish(),
  url: z.string().max(2000).nullish(),
  domain: z.string().max(253).nullish(),
  /**
   * Accepted and ignored.
   *
   * Categories are company data that a super admin changes without shipping an agent
   * release, so the server decides them — see `category_rules` and
   * `@aems/analytics/categorize`. The field stays in the contract because deployed
   * agents still send it; rejecting the batch over it would be worse than dropping it.
   */
  category: z.string().max(60).nullish(),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullish(),
});

const idleEventSchema = z.object({
  clientEventId: z.string().uuid(),
  idleStartAt: z.string().datetime({ offset: true }),
  idleEndAt: z.string().datetime({ offset: true }).nullish(),
});

const breakEventSchema = z.object({
  clientEventId: z.string().uuid(),
  breakStartAt: z.string().datetime({ offset: true }),
  breakEndAt: z.string().datetime({ offset: true }).nullish(),
});

/**
 * §3.5. Bounds are asserted here as well as in the CHECK constraint, so a malformed
 * fix is a 400 naming the field rather than a 500 from Postgres — the agent classifies
 * a 500 as retryable, which would wedge the device's queue on a single bad point.
 */
const locationPointSchema = z.object({
  clientEventId: z.string().uuid(),
  recordedAt: z.string().datetime({ offset: true }),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).nullish(),
});

const locationQuerySchema = z.object({
  profileId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  // A trail is read a day at a time; the ceiling stops an unbounded range from
  // dragging a month of points through the API by accident.
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

const batchSchema = z.object({
  deviceId: z.string().uuid(),
  workSessionId: z.number().int().nullish(),
  activity: z.array(activityEventSchema).max(1000).optional(),
  idle: z.array(idleEventSchema).max(1000).optional(),
  breaks: z.array(breakEventSchema).max(1000).optional(),
  locations: z.array(locationPointSchema).max(1000).optional(),
});

// ---------------------------------------------------------------------------
// Category rules
// ---------------------------------------------------------------------------

const PRODUCTIVITY = ["productive", "neutral", "unproductive"] as const;

const ruleInputSchema = z.object({
  path: z.array(z.string().trim().min(1).max(60)).min(1).max(4),
  productivity: z.enum(PRODUCTIVITY),
  priority: z.number().int().min(0).max(100_000).default(100),
  matchApp: z.string().trim().min(1).max(400).nullish(),
  matchDomain: z.string().trim().min(1).max(400).nullish(),
  matchTitle: z.string().trim().min(1).max(400).nullish(),
  ignoreCase: z.boolean().default(true),
});

const rulePatchSchema = ruleInputSchema.partial();

interface CategoryRuleRow {
  id: string;
  company_id: string;
  priority: number;
  category_path: string[];
  productivity: Productivity;
  match_app: string | null;
  match_domain: string | null;
  match_title: string | null;
  ignore_case: boolean;
  created_at: string;
  updated_at: string;
}

interface CategoryRuleDto {
  id: string;
  path: string[];
  productivity: Productivity;
  priority: number;
  matchApp: string | null;
  matchDomain: string | null;
  matchTitle: string | null;
  ignoreCase: boolean;
  createdAt: string;
  updatedAt: string;
}

type CategoryRuleWrite = Omit<CategoryRuleRow, "id" | "created_at" | "updated_at">;

/**
 * A narrow structural view of `category_rules`.
 *
 * NOTE (integration, 2026-08-05): migration ...0007 is now applied and
 * `@aems/types` declares the table, so this escape hatch is no longer required —
 * it is kept only because these handlers have no HTTP-level test and swapping them
 * onto the typed builder is an unverifiable change. Delete it alongside the first
 * route test, not before.
 *
 * Narrowing the hatch to one structural interface keeps every call site checked
 * against a real row shape instead of scattering `any` through the route.
 */
interface PgResponse<T> {
  data: T;
  error: { message: string } | null;
}

interface RuleQuery<T> extends PromiseLike<PgResponse<T>> {
  eq(column: string, value: string | number): RuleQuery<T>;
  order(column: string, options: { ascending: boolean }): RuleQuery<T>;
  select(columns: string): RuleQuery<CategoryRuleRow[] | null>;
  single(): PromiseLike<PgResponse<CategoryRuleRow | null>>;
  maybeSingle(): PromiseLike<PgResponse<CategoryRuleRow | null>>;
}

interface RuleTable {
  select(columns: string): RuleQuery<CategoryRuleRow[] | null>;
  insert(row: CategoryRuleWrite): RuleQuery<null>;
  update(patch: Partial<CategoryRuleWrite>): RuleQuery<null>;
  delete(): RuleQuery<null>;
}

function ruleTable(app: FastifyInstance): RuleTable {
  return (app.supabase as unknown as { from(table: "category_rules"): RuleTable }).from(
    "category_rules",
  );
}

/**
 * How long a compiled rule set is reused before it is re-read.
 *
 * Compiling ~20 regexes per ingested batch would be pure waste, and every agent in the
 * company flushes on its own timer. Short enough that a rule change lands within a
 * minute even on another API instance; writes below also evict directly, so the admin
 * who made the change sees it at once.
 */
const RULE_CACHE_TTL_MS = 60_000;

const ruleCache = new Map<string, { expiresAt: number; set: CompiledRuleSet }>();

function toRule(row: CategoryRuleRow): CategoryRule {
  return {
    id: row.id,
    path: row.category_path,
    productivity: row.productivity,
    priority: row.priority,
    matchApp: row.match_app,
    matchDomain: row.match_domain,
    matchTitle: row.match_title,
    ignoreCase: row.ignore_case,
  };
}

function toDto(row: CategoryRuleRow): CategoryRuleDto {
  return {
    id: row.id,
    path: row.category_path,
    productivity: row.productivity,
    priority: row.priority,
    matchApp: row.match_app,
    matchDomain: row.match_domain,
    matchTitle: row.match_title,
    ignoreCase: row.ignore_case,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readRules(app: FastifyInstance, companyId: string): Promise<CategoryRuleRow[] | null> {
  const { data, error } = await ruleTable(app)
    .select("*")
    .eq("company_id", companyId)
    .order("priority", { ascending: true })
    .order("id", { ascending: true });

  return error ? null : (data ?? []);
}

/**
 * The company's compiled rules, memoised.
 *
 * A read failure yields an empty set rather than an error: everything lands in
 * `Uncategorized`, which is recoverable at read time, whereas refusing the batch
 * would throw away collected work over a config lookup. Failures are never cached.
 */
async function ruleSetFor(app: FastifyInstance, companyId: string): Promise<CompiledRuleSet> {
  const cached = ruleCache.get(companyId);
  if (cached && cached.expiresAt > Date.now()) return cached.set;

  const rows = await readRules(app, companyId);
  if (rows === null) return compileRules([]);

  const set = compileRules(rows.map(toRule));
  ruleCache.set(companyId, { expiresAt: Date.now() + RULE_CACHE_TTL_MS, set });
  return set;
}

/**
 * A category-to-productivity lookup for one company, off the same cached rule set.
 *
 * Exported so the analytics routes can split active time three ways without a second
 * read of `category_rules` — one cache, one source of truth, and a rule edit changes
 * both surfaces at the same moment. A lookup rather than the rule set itself, because
 * the caller has already-categorised rows and needs to score a stored category string,
 * not re-run the matchers over raw events.
 *
 * Anything no rule names resolves to `neutral`, matching `UNCATEGORIZED_RESULT`: an
 * application nobody wrote a rule for is evidence of nothing, and this product does
 * not count "we don't know" against a person.
 */
export async function productivityLookupFor(
  app: FastifyInstance,
  companyId: string,
): Promise<(category: string | null) => Productivity> {
  const set = await ruleSetFor(app, companyId);
  const byCategory = new Map<string, Productivity>();

  // Later rules lose: `rules` is already in evaluation order, so the first mention of
  // a category is the one that would have won when the event was classified.
  for (const rule of set.rules) {
    if (!byCategory.has(rule.category)) byCategory.set(rule.category, rule.productivity);
  }

  return (category) => (category === null ? "neutral" : (byCategory.get(category) ?? "neutral"));
}

export const activityRoutes: FastifyPluginAsync = async (app) => {
  /** Clock in. The partial unique index on the table makes a second open session impossible. */
  app.post("/sessions", { preHandler: app.requireDevice }, async (request, reply) => {
    const device = request.device!;

    // Gated on the consent row existing, not on any one type: a work session is the
    // container everything else hangs on, and switching it off per person is what
    // `profiles.monitoring_enabled` already does.
    const consent = await resolveCollection(app.supabase, device);
    if (!consent.ok) {
      return reply
        .code(403)
        .send({ error: "consent_required", message: consent.message, statusCode: 403 });
    }

    const { data: existing } = await app.supabase
      .from("work_sessions")
      .select("*")
      .eq("device_id", device.deviceId)
      .is("clock_out_at", null)
      .maybeSingle();

    // Agents restart. Hand back the session already running rather than failing or
    // silently starting a second one.
    if (existing) return existing;

    const { data, error } = await app.supabase
      .from("work_sessions")
      .insert({
        company_id: device.companyId,
        profile_id: device.profileId,
        device_id: device.deviceId,
      })
      .select("*")
      .single();

    if (error || !data) {
      return reply
        .code(500)
        .send({ error: "session_failed", message: error?.message ?? "Could not start session", statusCode: 500 });
    }

    return data;
  });

  /** Clock out. */
  app.post("/sessions/:id/end", { preHandler: app.requireDevice }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = request.device!;
    const sessionId = Number(id);

    if (!Number.isInteger(sessionId)) {
      return reply
        .code(400)
        .send({ error: "invalid_id", message: "Session id must be an integer", statusCode: 400 });
    }

    const { data, error } = await app.supabase
      .from("work_sessions")
      .update({ clock_out_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("device_id", device.deviceId)
      .is("clock_out_at", null)
      .select("*")
      .maybeSingle();

    if (error || !data) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "No open session with that id for this device", statusCode: 404 });
    }

    return data;
  });

  /**
   * Bulk ingestion.
   *
   * Agents buffer while offline and flush on reconnect, so the same batch can arrive
   * more than once. Every row carries a clientEventId with a unique index behind it;
   * `ignoreDuplicates` turns a replay into a no-op instead of a duplicate row.
   */
  app.post("/events", { preHandler: app.requireDevice }, async (request, reply) => {
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_body"));
    }

    const device = request.device!;
    const body = parsed.data;

    if (body.deviceId !== device.deviceId) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Token does not match device", statusCode: 403 });
    }

    const consent = await resolveCollection(app.supabase, device);
    if (!consent.ok) {
      return reply
        .code(403)
        .send({ error: "consent_required", message: consent.message, statusCode: 403 });
    }

    // One gate, four data types. Each block below consults `types` independently
    // rather than the whole batch being refused, because an agent that has one type
    // switched off is otherwise perfectly entitled to send the rest — and a 403 over
    // the whole batch would make it retry the permitted rows forever.
    const { types } = consent;

    const base = {
      company_id: device.companyId,
      profile_id: device.profileId,
      device_id: device.deviceId,
    };

    let acceptedActivity = 0;
    let acceptedIdle = 0;
    let acceptedBreaks = 0;
    let acceptedLocations = 0;

    // Counted and reported rather than folded into `duplicates`, which would tell the
    // agent its rows were already stored when in fact they were dropped.
    const refusedActivity = types.has("applications") ? 0 : (body.activity?.length ?? 0);
    const refusedIdle = types.has("idle") ? 0 : (body.idle?.length ?? 0);
    const refusedLocations = types.has("location") ? 0 : (body.locations?.length ?? 0);

    if (body.activity?.length && types.has("applications")) {
      // Categorise here, not on the device. Storing the label keeps `rankApps`, the
      // report worker and the dashboard fast; reads that need yesterday relabelled by
      // a rule written today re-run the same pure function instead of waiting for a
      // backfill.
      const rules = await ruleSetFor(app, device.companyId);

      const { data, error } = await app.supabase
        .from("activity_events")
        .upsert(
          body.activity.map((event) => ({
            ...base,
            work_session_id: body.workSessionId ?? null,
            app_name: event.appName,
            window_title: event.windowTitle ?? null,
            // Nulled rather than the row being dropped: `url` and `domain` ride on the
            // same row as `app_name`, and discarding it to enforce a website setting
            // would delete application activity the employee did agree to.
            url: types.has("websites") ? (event.url ?? null) : null,
            domain: types.has("websites") ? (event.domain ?? null) : null,
            category: categorizeEvent(rules, {
              appName: event.appName,
              windowTitle: event.windowTitle ?? null,
              domain: types.has("websites") ? (event.domain ?? null) : null,
            }).category,
            started_at: event.startedAt,
            ended_at: event.endedAt ?? null,
            client_event_id: event.clientEventId,
          })),
          { onConflict: "device_id,client_event_id", ignoreDuplicates: true },
        )
        .select("id");

      if (error) {
        return reply
          .code(500)
          .send({ error: "ingest_failed", message: error.message, statusCode: 500 });
      }
      acceptedActivity = data?.length ?? 0;
    }

    if (body.idle?.length && types.has("idle")) {
      const { data, error } = await app.supabase
        .from("idle_events")
        .upsert(
          body.idle.map((event) => ({
            ...base,
            idle_start_at: event.idleStartAt,
            idle_end_at: event.idleEndAt ?? null,
            client_event_id: event.clientEventId,
          })),
          { onConflict: "device_id,client_event_id", ignoreDuplicates: true },
        )
        .select("id");

      if (error) {
        return reply
          .code(500)
          .send({ error: "ingest_failed", message: error.message, statusCode: 500 });
      }
      acceptedIdle = data?.length ?? 0;
    }

    // Never gated by type. A declared break is the employee's own statement about
    // their day, not an observation made about them.
    if (body.breaks?.length) {
      const { data, error } = await app.supabase
        .from("break_events")
        .upsert(
          body.breaks.map((event) => ({
            ...base,
            work_session_id: body.workSessionId ?? null,
            break_start_at: event.breakStartAt,
            break_end_at: event.breakEndAt ?? null,
            client_event_id: event.clientEventId,
          })),
          { onConflict: "device_id,client_event_id", ignoreDuplicates: true },
        )
        .select("id");

      if (error) {
        return reply
          .code(500)
          .send({ error: "ingest_failed", message: error.message, statusCode: 500 });
      }
      acceptedBreaks = data?.length ?? 0;
    }

    // `location` is absent from both desktop platform sets, so this is also what stops
    // a laptop's token writing position fixes that no screen in the product renders.
    if (body.locations?.length && types.has("location")) {
      const { data, error } = await app.supabase
        .from("location_points")
        .upsert(
          body.locations.map((point) => ({
            ...base,
            work_session_id: body.workSessionId ?? null,
            recorded_at: point.recordedAt,
            latitude: point.latitude,
            longitude: point.longitude,
            accuracy_m: point.accuracyM ?? null,
            client_event_id: point.clientEventId,
          })),
          { onConflict: "device_id,client_event_id", ignoreDuplicates: true },
        )
        .select("id");

      if (error) {
        return reply
          .code(500)
          .send({ error: "ingest_failed", message: error.message, statusCode: 500 });
      }
      acceptedLocations = data?.length ?? 0;
    }

    const submitted =
      (body.activity?.length ?? 0) +
      (body.idle?.length ?? 0) +
      (body.breaks?.length ?? 0) +
      (body.locations?.length ?? 0);

    return {
      acceptedActivity,
      acceptedIdle,
      acceptedBreaks,
      acceptedLocations,
      duplicates:
        submitted -
        acceptedActivity -
        acceptedIdle -
        acceptedBreaks -
        acceptedLocations -
        refusedActivity -
        refusedIdle -
        refusedLocations,
      refusedActivity,
      refusedIdle,
      refusedLocations,
    };
  });

  /**
   * §3.5 location history for one person over one window.
   *
   * The scoping here is the whole access control, not a convenience: this route runs on
   * the service-role key, which bypasses RLS, so the checks RLS would have made have to
   * be made in code. Two of them — the requester may only ask about themselves unless
   * they are a manager, and the company filter is applied to the query rather than to
   * the answer, so a valid profile id from another tenant returns nothing rather than
   * somebody else's movements.
   */
  app.get("/locations", { preHandler: app.requireUser }, async (request, reply) => {
    const session = request.session!;

    const parsed = locationQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send(validationFailure(parsed.error, "invalid_query"));
    }

    const profileId = parsed.data.profileId ?? session.profileId;

    if (profileId !== session.profileId && !canViewOthers(session.role)) {
      return reply.code(403).send({
        error: "forbidden",
        message: "You can only view your own location history",
        statusCode: 403,
      });
    }

    let query = app.supabase
      .from("location_points")
      .select("id, device_id, recorded_at, latitude, longitude, accuracy_m, work_session_id")
      .eq("company_id", session.companyId)
      .eq("profile_id", profileId)
      .order("recorded_at", { ascending: false })
      .limit(parsed.data.limit);

    if (parsed.data.from !== undefined) query = query.gte("recorded_at", parsed.data.from);
    if (parsed.data.to !== undefined) query = query.lte("recorded_at", parsed.data.to);

    const { data, error } = await query;

    if (error) {
      return reply
        .code(500)
        .send({ error: "locations_unavailable", message: error.message, statusCode: 500 });
    }

    const points = (data ?? []).map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      recordedAt: row.recorded_at,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracyM: row.accuracy_m,
      workSessionId: row.work_session_id,
    }));

    return { points };
  });

  /**
   * The company's classification rules, in evaluation order.
   *
   * Readable by every role, not just managers: an employee is entitled to see the
   * rules being applied to their own activity. A classification somebody cannot
   * inspect is a judgement made about them in private.
   */
  app.get("/categories", { preHandler: app.requireUser }, async (request, reply) => {
    const session = request.session!;

    const rows = await readRules(app, session.companyId);
    if (rows === null) {
      return reply
        .code(500)
        .send({ error: "rules_unavailable", message: "Could not load category rules", statusCode: 500 });
    }

    const compiled = compileRules(rows.map(toRule));
    const order = new Map(compiled.rules.map((rule, index) => [rule.id, index]));

    // Rules the engine refused still come back, at the end, so a settings screen can
    // show and repair them instead of leaving an admin wondering why nothing matches.
    const rules = rows
      .map(toDto)
      .sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));

    return { rules, rejected: [...compiled.rejected] };
  });

  /** Create a rule. Super admin only — a manager who could rewrite the rules could rewrite the report. */
  app.post("/categories", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const parsed = ruleInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_body"));
    }

    const session = request.session!;
    const refusal = refuseUnusableRule({ id: "new", ...parsed.data });
    if (refusal) {
      return reply.code(400).send({ error: "invalid_rule", message: refusal, statusCode: 400 });
    }

    const { data, error } = await ruleTable(app)
      .insert(toRow(session.companyId, parsed.data))
      .select("*")
      .single();

    if (error || !data) {
      return reply
        .code(500)
        .send({ error: "rule_write_failed", message: error?.message ?? "Could not create the rule", statusCode: 500 });
    }

    ruleCache.delete(session.companyId);
    return reply.code(201).send(toDto(data));
  });

  /** Update a rule. */
  app.patch("/categories/:id", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = rulePatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(validationFailure(parsed.error, "invalid_body"));
    }

    const session = request.session!;

    const rows = await readRules(app, session.companyId);
    const existing = rows?.find((row) => row.id === id);
    if (!existing) {
      return reply.code(404).send({ error: "not_found", message: "No such rule", statusCode: 404 });
    }

    // Validate the rule as it will be *after* the patch: a patch that clears the last
    // match field, or introduces a pattern the engine cannot run, must be refused with
    // a reason rather than stored and silently skipped at match time.
    const merged = { ...toRule(existing), ...stripUndefined(parsed.data) };
    const refusal = refuseUnusableRule(merged);
    if (refusal) {
      return reply.code(400).send({ error: "invalid_rule", message: refusal, statusCode: 400 });
    }

    const { data, error } = await ruleTable(app)
      .update(toRow(session.companyId, merged))
      .eq("id", id)
      .eq("company_id", session.companyId)
      .select("*")
      .maybeSingle();

    if (error || !data) {
      return reply
        .code(500)
        .send({ error: "rule_write_failed", message: error?.message ?? "Could not update the rule", statusCode: 500 });
    }

    ruleCache.delete(session.companyId);
    return toDto(data);
  });

  /** Delete a rule. History keeps its stored label until something recategorises it. */
  app.delete("/categories/:id", { preHandler: app.requireSuperAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = request.session!;

    const { data, error } = await ruleTable(app)
      .delete()
      .eq("id", id)
      .eq("company_id", session.companyId)
      .select("id")
      .maybeSingle();

    if (error) {
      return reply
        .code(500)
        .send({ error: "rule_write_failed", message: error.message, statusCode: 500 });
    }
    if (!data) {
      return reply.code(404).send({ error: "not_found", message: "No such rule", statusCode: 404 });
    }

    ruleCache.delete(session.companyId);
    return reply.code(204).send();
  });
};

interface RuleInput {
  path: string[];
  productivity: Productivity;
  priority: number;
  matchApp?: string | null;
  matchDomain?: string | null;
  matchTitle?: string | null;
  ignoreCase?: boolean | null;
}

function toRow(companyId: string, rule: RuleInput): CategoryRuleWrite {
  return {
    company_id: companyId,
    priority: rule.priority,
    category_path: rule.path,
    productivity: rule.productivity,
    match_app: rule.matchApp ?? null,
    match_domain: rule.matchDomain ?? null,
    match_title: rule.matchTitle ?? null,
    // Matches the engine's default: only an explicit false turns case sensitivity on.
    ignore_case: rule.ignoreCase !== false,
  };
}

/**
 * Runs a candidate through the engine before it is stored.
 *
 * The matcher is the only authority on what a usable rule is — a pattern that could
 * backtrack catastrophically, or a rule with no condition, is refused at the door
 * rather than saved and then quietly skipped on every event forever.
 */
function refuseUnusableRule(rule: CategoryRule): string | null {
  const rejected = compileRules([rule]).rejected[0];
  return rejected ? `${rejected.field}: ${rejected.reason}` : null;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
