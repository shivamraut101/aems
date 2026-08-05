import {
  categorizeEvent,
  compileRules,
  type CategoryRule,
  type CompiledRuleSet,
  type Productivity,
} from "@aems/analytics";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { assertConsent } from "../plugins/context.js";
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

const batchSchema = z.object({
  deviceId: z.string().uuid(),
  workSessionId: z.number().int().nullish(),
  activity: z.array(activityEventSchema).max(1000).optional(),
  idle: z.array(idleEventSchema).max(1000).optional(),
  breaks: z.array(breakEventSchema).max(1000).optional(),
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

export const activityRoutes: FastifyPluginAsync = async (app) => {
  /** Clock in. The partial unique index on the table makes a second open session impossible. */
  app.post("/sessions", { preHandler: app.requireDevice }, async (request, reply) => {
    const device = request.device!;

    const consent = await assertConsent(app.supabase, device.deviceId);
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

    const consent = await assertConsent(app.supabase, device.deviceId);
    if (!consent.ok) {
      return reply
        .code(403)
        .send({ error: "consent_required", message: consent.message, statusCode: 403 });
    }

    const base = {
      company_id: device.companyId,
      profile_id: device.profileId,
      device_id: device.deviceId,
    };

    let acceptedActivity = 0;
    let acceptedIdle = 0;
    let acceptedBreaks = 0;

    if (body.activity?.length) {
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
            url: event.url ?? null,
            domain: event.domain ?? null,
            category: categorizeEvent(rules, {
              appName: event.appName,
              windowTitle: event.windowTitle ?? null,
              domain: event.domain ?? null,
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

    if (body.idle?.length) {
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

    const submitted =
      (body.activity?.length ?? 0) + (body.idle?.length ?? 0) + (body.breaks?.length ?? 0);

    return {
      acceptedActivity,
      acceptedIdle,
      acceptedBreaks,
      duplicates: submitted - acceptedActivity - acceptedIdle - acceptedBreaks,
    };
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
