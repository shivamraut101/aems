import { canViewOthers } from "@aems/auth";
import {
  REPORT_KINDS,
  buildReportDocument,
  columnsFor,
  findReportType,
  getReportType,
  isGroupingAllowed,
  listReportTypes,
  planPdf,
  renderCsv,
  type Grouping,
  type ReportActivityRow,
  type ReportBreakRow,
  type ReportDataset,
  type ReportDocument,
  type ReportFormat,
  type ReportIdleRow,
  type ReportKind,
  type ReportProfileRow,
} from "@aems/analytics";
import { AEMS_BUCKET } from "@aems/supabase";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { validationFailure } from "../lib/validation.js";

/**
 * Ceiling on rows pulled into one report.
 *
 * PostgREST caps a response at `max_rows` (1000 here) and says nothing when it does,
 * so a report over half a day was already silently wrong. Paging past that cap is
 * the fix; this is the point past which we stop and say so instead, because a
 * 30-day team report is a database problem, not a fetch-harder problem.
 */
const MAX_REPORT_ROWS = 50_000;

/** Below PostgREST's own cap, so a page is never truncated under us. */
const PAGE_SIZE = 900;

/** Beyond this an `in.(...)` filter builds a URL the server will reject. */
const MAX_INLINE_PROFILE_IDS = 100;

const scopeSchema = z.enum(["self", "profiles", "my_team", "company"]);
type ReportScope = z.infer<typeof scopeSchema>;

const specSchema = z.object({
  kind: z.enum(REPORT_KINDS),
  grouping: z.string().optional(),
  scope: scopeSchema.default("company"),
  profileIds: z.array(z.string().uuid()).max(500).optional(),
  periodStart: z.string().datetime({ offset: true }),
  periodEnd: z.string().datetime({ offset: true }),
  decimalDuration: z.boolean().default(false),
});

const exportSchema = specSchema.extend({ format: z.enum(["csv", "pdf"]).default("csv") });
const queueSchema = exportSchema;

type ReportSpec = z.infer<typeof specSchema>;

/**
 * Persisted spec.
 *
 * The generated table types in `@aems/types` predate migration `…0010`, which added
 * format, grouping, params, requested_by, row_count and failure_reason. Regenerate
 * with `pnpm db:types` and these local shapes can go.
 */
interface StoredReport {
  id: number;
  company_id: string;
  profile_id: string | null;
  kind: string;
  period_start: string;
  period_end: string;
  status: "pending" | "ready" | "failed";
  storage_path: string | null;
  format: ReportFormat;
  grouping: string;
  params: { scope?: ReportScope; profileIds?: string[]; decimalDuration?: boolean } | null;
}

export const reportRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The catalogue.
   *
   * The dashboard renders this rather than hardcoding a list of its own, so a new
   * report type appears in the UI without a frontend change — and so the list a
   * user sees is derived from their role instead of being filtered client-side.
   */
  app.get("/types", { preHandler: app.requireUser }, async (request) => {
    const session = request.session!;

    return {
      types: listReportTypes(session.role).map((type) => ({
        id: type.id,
        label: type.label,
        description: type.description,
        groupings: type.groupings,
        defaultGrouping: type.defaultGrouping,
        minRole: type.minRole,
        columnsByGrouping: Object.fromEntries(
          type.groupings.map((grouping) => [grouping, columnsFor(type.id, grouping)]),
        ),
      })),
    };
  });

  /**
   * Render to screen.
   *
   * Cattr's split, adopted: the same filters either render now or queue a file. A
   * manager who has to wait for a background job to see a number will not use the
   * feature, so this path is synchronous and returns the document the renderers
   * consume — the table on screen and the CSV in the download are the same object.
   */
  app.post("/run", { preHandler: app.requireUser }, async (request, reply) => {
    const resolved = await resolveSpec(app, request, reply, specSchema);
    if (!resolved) return reply;

    const data = await fetchDataset(app, resolved.companyId, resolved.profileIds, resolved.spec);
    return buildDocument(resolved.spec, data, resolved.subtitle);
  });

  /**
   * Export to file, synchronously, as CSV.
   *
   * PDF is queued instead: `pdf-lib` lives in the report worker's Deno runtime, not
   * in this process. See `POST /` and the worker for that path.
   */
  app.post("/export", { preHandler: app.requireUser }, async (request, reply) => {
    const resolved = await resolveSpec(app, request, reply, exportSchema);
    if (!resolved) return reply;

    if (resolved.body.format === "pdf") {
      return reply.code(400).send({
        error: "pdf_is_queued",
        message: "PDF exports are queued. Post the same filters to /api/reports and poll for it.",
        statusCode: 400,
      });
    }

    const data = await fetchDataset(app, resolved.companyId, resolved.profileIds, resolved.spec);
    const document = buildDocument(resolved.spec, data, resolved.subtitle);
    const filename = `${resolved.spec.kind}-${resolved.spec.periodStart.slice(0, 10)}.csv`;

    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(renderCsv(document));
  });

  app.get("/", { preHandler: app.requireUser }, async (request) => {
    const session = request.session!;

    let query = app.supabase
      .from("reports")
      .select("*")
      .eq("company_id", session.companyId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (!canViewOthers(session.role)) {
      query = query.eq("profile_id", session.profileId);
    }

    const { data } = await query;
    return data ?? [];
  });

  /**
   * Queues a report.
   *
   * The row is created as `pending`; the report Edge Function picks it up, renders
   * it, and flips it to `ready`. Generation is not done inline because a team report
   * over a long window would hold an HTTP connection open for minutes — and because
   * PDF rendering lives in the worker's runtime.
   */
  app.post("/", { preHandler: app.requireUser }, async (request, reply) => {
    const resolved = await resolveSpec(app, request, reply, queueSchema);
    if (!resolved) return reply;

    const { spec, companyId, body } = resolved;
    const format: ReportFormat = body.format;

    // `as never`: the generated Insert type predates migration …0010's columns.
    const { data, error } = await app.supabase
      .from("reports")
      .insert({
        company_id: companyId,
        profile_id: spec.scope === "self" ? request.session!.profileId : null,
        kind: spec.kind,
        format,
        grouping: resolveGrouping(spec.kind, spec.grouping),
        params: {
          scope: spec.scope,
          profileIds: resolved.profileIds,
          decimalDuration: spec.decimalDuration,
        },
        requested_by: request.session!.profileId,
        period_start: spec.periodStart,
        period_end: spec.periodEnd,
        status: "pending",
      } as never)
      .select("*")
      .single();

    if (error || !data) {
      return reply.code(500).send({
        error: "report_failed",
        message: error?.message ?? "Could not queue report",
        statusCode: 500,
      });
    }

    return data;
  });

  /** Signed download link for a finished report. */
  app.get("/:id/download", { preHandler: app.requireUser }, async (request, reply) => {
    const session = request.session!;
    const reportId = Number((request.params as { id: string }).id);

    if (!Number.isInteger(reportId)) {
      return reply
        .code(400)
        .send({ error: "invalid_id", message: "Report id must be an integer", statusCode: 400 });
    }

    const { data: report } = await app.supabase
      .from("reports")
      .select("*")
      .eq("id", reportId)
      .eq("company_id", session.companyId)
      .maybeSingle();

    if (!report) {
      return reply.code(404).send({ error: "not_found", message: "No such report", statusCode: 404 });
    }

    if (!canViewOthers(session.role) && report.profile_id !== session.profileId) {
      return reply.code(403).send({ error: "forbidden", message: "Not your report", statusCode: 403 });
    }

    if (report.status !== "ready" || !report.storage_path) {
      return reply.code(409).send({
        error: "not_ready",
        message: `Report is ${report.status}`,
        statusCode: 409,
      });
    }

    const { data: signed, error } = await app.supabase.storage
      .from(AEMS_BUCKET)
      .createSignedUrl(report.storage_path, 60 * 5);

    if (error || !signed) {
      return reply
        .code(500)
        .send({ error: "sign_failed", message: error?.message ?? "Could not sign URL", statusCode: 500 });
    }

    return { url: signed.signedUrl };
  });

  /**
   * Internal: everything the worker needs to write one queued report.
   *
   * The worker holds no arithmetic of its own. It used to, and it got four things
   * wrong that the dashboard got right — idle never subtracted, the window never
   * clamped, events overlapping the window dropped, and each app's spans merged
   * independently so two devices doubled the day. The numbers are computed here,
   * once, from the same `packages/analytics` code every screen uses; the worker
   * serialises and uploads.
   */
  app.get("/:id/render", async (request, reply) => {
    const secret = process.env["WORKER_SECRET"];
    if (!secret) {
      // Fail closed. An unauthenticated endpoint here would hand a company's whole
      // activity history to anyone who can reach the API.
      return reply.code(503).send({
        error: "worker_disabled",
        message: "Worker rendering is not configured",
        statusCode: 503,
      });
    }

    const given = request.headers["x-worker-secret"];
    if ((Array.isArray(given) ? given[0] : given) !== secret) {
      return reply
        .code(401)
        .send({ error: "unauthorized", message: "Invalid worker secret", statusCode: 401 });
    }

    const reportId = Number((request.params as { id: string }).id);
    if (!Number.isInteger(reportId)) {
      return reply
        .code(400)
        .send({ error: "invalid_id", message: "Report id must be an integer", statusCode: 400 });
    }

    const { data } = await app.supabase.from("reports").select("*").eq("id", reportId).maybeSingle();
    if (!data) {
      return reply.code(404).send({ error: "not_found", message: "No such report", statusCode: 404 });
    }

    const report = data as unknown as StoredReport;
    const type = findReportType(report.kind);
    if (!type) {
      return reply.code(422).send({
        error: "unsupported_kind",
        message: `Report kind "${report.kind}" predates the report registry and cannot be rendered`,
        statusCode: 422,
      });
    }

    const params = report.params ?? {};
    const profileIds = await resolveProfileIds(
      app,
      report.company_id,
      params.scope ?? "company",
      params.profileIds ?? (report.profile_id ? [report.profile_id] : []),
      report.profile_id,
    );

    const spec: ReportSpec = {
      kind: type.id,
      grouping: report.grouping,
      scope: params.scope ?? "company",
      profileIds,
      periodStart: report.period_start,
      periodEnd: report.period_end,
      decimalDuration: params.decimalDuration ?? false,
    };

    const dataset = await fetchDataset(app, report.company_id, profileIds, spec);
    const document = buildDocument(spec, dataset, subtitleFor(spec.scope, profileIds.length));
    const extension = report.format === "pdf" ? "pdf" : "csv";

    return {
      storagePath: `${report.company_id}/${report.profile_id ?? "company"}/reports/${report.kind}-${report.id}.${extension}`,
      filename: `${report.kind}-${report.period_start.slice(0, 10)}.${extension}`,
      contentType: report.format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
      format: report.format,
      rowCount: document.rowCount,
      // Exactly one of these is present. The worker never chooses the numbers,
      // only how they are drawn.
      csv: report.format === "csv" ? renderCsv(document) : null,
      plan: report.format === "pdf" ? planPdf(document) : null,
    };
  });
};

/* ------------------------------------------------------------------------- */
/* Request resolution                                                         */
/* ------------------------------------------------------------------------- */

interface ResolvedRequest<T> {
  spec: ReportSpec;
  /** The parsed body, keeping fields the base spec does not carry (`format`). */
  body: T;
  companyId: string;
  profileIds: string[];
  subtitle: string;
}

/**
 * Validates the body and turns a scope into a concrete set of people.
 *
 * An employee is pinned to their own data no matter what they asked for. RLS is the
 * real boundary — this is here so the API never hands back a refusal the UI could
 * have avoided offering, and so a widened scope cannot leak through a service-role
 * client that RLS does not constrain.
 */
async function resolveSpec<TBody extends ReportSpec>(
  app: Parameters<FastifyPluginAsync>[0],
  request: FastifyRequest,
  reply: FastifyReply,
  // Input left as `unknown`: the body is untrusted, and pinning it would make
  // every schema with a `.default()` fail to match this signature.
  schema: z.ZodType<TBody, z.ZodTypeDef, unknown>,
): Promise<ResolvedRequest<TBody> | null> {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    reply
      .code(400)
      .send(validationFailure(parsed.error, "invalid_body"));
    return null;
  }

  const session = request.session!;
  const body = parsed.data;
  const spec: ReportSpec = body;

  if (Date.parse(spec.periodEnd) <= Date.parse(spec.periodStart)) {
    reply.code(400).send({
      error: "invalid_period",
      message: "The period must end after it starts",
      statusCode: 400,
    });
    return null;
  }

  const type = getReportType(spec.kind);
  if (!canViewOthers(session.role) && type.minRole !== "employee") {
    reply.code(403).send({
      error: "forbidden",
      message: `${type.label} is a manager report`,
      statusCode: 403,
    });
    return null;
  }

  const scope: ReportScope = !canViewOthers(session.role) ? "self" : spec.scope;
  const profileIds = await resolveProfileIds(
    app,
    session.companyId,
    scope,
    scope === "self" ? [session.profileId] : (spec.profileIds ?? []),
    session.profileId,
  );

  return {
    spec: { ...spec, scope, grouping: resolveGrouping(spec.kind, spec.grouping) },
    body,
    companyId: session.companyId,
    profileIds,
    subtitle: subtitleFor(scope, profileIds.length),
  };
}

function subtitleFor(scope: ReportScope, count: number): string {
  switch (scope) {
    case "self":
      return "Your own activity";
    case "my_team":
      return `Your team — ${count} ${count === 1 ? "person" : "people"}`;
    case "profiles":
      return `${count} selected ${count === 1 ? "person" : "people"}`;
    case "company":
    default:
      return "Whole company";
  }
}

function resolveGrouping(kind: ReportKind, requested: string | undefined): Grouping {
  const type = getReportType(kind);
  return requested && isGroupingAllowed(kind, requested as Grouping)
    ? (requested as Grouping)
    : type.defaultGrouping;
}

/**
 * Turns a scope into profile ids, always constrained to the caller's company.
 *
 * `company` returns an empty list on purpose: the fetch then filters on company_id
 * alone, which is both correct and far cheaper than an `in.(...)` over every
 * employee.
 */
async function resolveProfileIds(
  app: Parameters<FastifyPluginAsync>[0],
  companyId: string,
  scope: ReportScope,
  requested: string[],
  selfId: string | null,
): Promise<string[]> {
  if (scope === "company") return [];

  if (scope === "my_team") {
    // Without a manager there is no team. Passing a null through to `.eq` would
    // match every employee who has no manager set — the opposite of narrowing.
    if (!selfId) return [];

    const { data } = await app.supabase
      .from("profiles")
      .select("id")
      .eq("company_id", companyId)
      .eq("manager_id", selfId);

    return [...new Set([...(data ?? []).map((row) => row.id), selfId])];
  }

  if (requested.length === 0) return selfId ? [selfId] : [];

  // Never trust the ids in the body: confirm each one is in this company before it
  // becomes a filter on a service-role query, which RLS does not police.
  const { data } = await app.supabase
    .from("profiles")
    .select("id")
    .eq("company_id", companyId)
    .in("id", requested.slice(0, 500));

  return (data ?? []).map((row) => row.id);
}

/* ------------------------------------------------------------------------- */
/* Data access                                                                */
/* ------------------------------------------------------------------------- */

function buildDocument(spec: ReportSpec, data: ReportDataset, subtitle: string): ReportDocument {
  return buildReportDocument(
    {
      kind: spec.kind,
      grouping: (spec.grouping ?? getReportType(spec.kind).defaultGrouping) as Grouping,
      periodStart: spec.periodStart,
      periodEnd: spec.periodEnd,
      decimalDuration: spec.decimalDuration,
      subtitle,
    },
    data,
  );
}

async function fetchDataset(
  app: Parameters<FastifyPluginAsync>[0],
  companyId: string,
  profileIds: string[],
  spec: ReportSpec,
): Promise<ReportDataset> {
  const { periodStart, periodEnd } = spec;
  // Only pull what the chosen report actually reads.
  const wantsActivity = spec.kind !== "work_breaks";
  const wantsIdle = spec.kind === "time_and_activity";
  const wantsBreaks = spec.kind === "time_and_activity" || spec.kind === "work_breaks";

  const [profiles, activity, idle, breaks] = await Promise.all([
    fetchProfiles(app, companyId, profileIds),
    wantsActivity
      ? fetchPaged<ReportActivityRow>(app, {
          table: "activity_events",
          columns: "profile_id, app_name, category, domain, started_at, ended_at",
          companyId,
          profileIds,
          startColumn: "started_at",
          endColumn: "ended_at",
          periodStart,
          periodEnd,
        })
      : Promise.resolve({ rows: [] as ReportActivityRow[], truncated: false }),
    wantsIdle
      ? fetchPaged<ReportIdleRow>(app, {
          table: "idle_events",
          columns: "profile_id, idle_start_at, idle_end_at",
          companyId,
          profileIds,
          startColumn: "idle_start_at",
          endColumn: "idle_end_at",
          periodStart,
          periodEnd,
        })
      : Promise.resolve({ rows: [] as ReportIdleRow[], truncated: false }),
    wantsBreaks
      ? fetchPaged<ReportBreakRow>(app, {
          table: "break_events",
          columns: "profile_id, break_start_at, break_end_at",
          companyId,
          profileIds,
          startColumn: "break_start_at",
          endColumn: "break_end_at",
          periodStart,
          periodEnd,
        })
      : Promise.resolve({ rows: [] as ReportBreakRow[], truncated: false }),
  ]);

  return {
    profiles,
    activity: activity.rows,
    idle: idle.rows,
    breaks: breaks.rows,
    truncated: activity.truncated || idle.truncated || breaks.truncated,
  };
}

async function fetchProfiles(
  app: Parameters<FastifyPluginAsync>[0],
  companyId: string,
  profileIds: string[],
): Promise<ReportProfileRow[]> {
  let query = app.supabase
    .from("profiles")
    .select("id, full_name, email, department")
    .eq("company_id", companyId);

  if (profileIds.length > 0 && profileIds.length <= MAX_INLINE_PROFILE_IDS) {
    query = query.in("id", profileIds);
  }

  const { data } = await query;
  return data ?? [];
}

interface PagedQuery {
  table: "activity_events" | "idle_events" | "break_events";
  columns: string;
  companyId: string;
  profileIds: string[];
  startColumn: string;
  endColumn: string;
  periodStart: string;
  periodEnd: string;
}

/**
 * Pages through a table with overlap semantics.
 *
 * Two defects rolled into one helper. First, `started_at >= period_start` drops an
 * event that began before the window and ran into it — a shift that started at 08:45
 * against a 09:00 window vanished entirely. Overlap keeps it and the aggregation
 * clamps it. Second, a single `select` silently stops at PostgREST's `max_rows`, and
 * a real eight-hour day passes that in focus intervals alone, so every report longer
 * than about half a day was quietly missing rows.
 */
async function fetchPaged<T>(
  app: Parameters<FastifyPluginAsync>[0],
  spec: PagedQuery,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  const inlineIds =
    spec.profileIds.length > 0 && spec.profileIds.length <= MAX_INLINE_PROFILE_IDS
      ? spec.profileIds
      : null;
  const filterInMemory = spec.profileIds.length > MAX_INLINE_PROFILE_IDS
    ? new Set(spec.profileIds)
    : null;

  for (let offset = 0; offset < MAX_REPORT_ROWS; offset += PAGE_SIZE) {
    let query = app.supabase
      .from(spec.table)
      .select(spec.columns)
      .eq("company_id", spec.companyId)
      .lt(spec.startColumn, spec.periodEnd)
      .or(`${spec.endColumn}.gt.${spec.periodStart},${spec.endColumn}.is.null`)
      // Paging without a stable order returns an arbitrary and possibly repeating
      // slice; `id` is the only strictly unique ordering these tables have.
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (inlineIds) query = query.in("profile_id", inlineIds);

    const { data, error } = await query;
    // A failed page leaves the loop, which falls through to `truncated: true`.
    // A partial report that says it is partial beats one that quietly is.
    if (error || !data) break;

    const page = data as unknown as T[];
    for (const row of page) {
      if (filterInMemory) {
        const profileId = (row as { profile_id?: string }).profile_id;
        if (profileId && !filterInMemory.has(profileId)) continue;
      }
      rows.push(row);
    }

    if (page.length < PAGE_SIZE) return { rows, truncated: false };
  }

  // Hit the ceiling: the document says so rather than quietly under-reporting.
  return { rows, truncated: true };
}
