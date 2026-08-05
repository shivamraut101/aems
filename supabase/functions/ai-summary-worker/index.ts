import { adminClient, authorize, json } from "../_shared/client.ts";
import {
  ACTIVITY_COLUMNS,
  IDLE_COLUMNS,
  combineFacts,
  summariseFacts,
  type ActivityRow,
  type IdleRow,
  type PeriodFacts,
} from "./aggregate.ts";
import { buildDocument, buildPrompt, SYSTEM_PROMPT } from "./content.ts";
import { parseJobRequest, resolvePeriod, type Period, type SummaryKind } from "./period.ts";
import { ProviderRefusal, summarise } from "./providers.ts";

/**
 * AI summary worker.
 *
 * One deployed function, three schedules. `POST ?kind=daily` (the default) writes a
 * per-employee row for yesterday, `?kind=weekly` one for the last complete week, and
 * `?kind=insight` one company-wide row for that same week. `?date=YYYY-MM-DD` moves
 * the reference point so a missed run can be backfilled.
 *
 * Three properties this file is responsible for:
 *
 * - **The numbers agree with the rest of the product.** Every duration comes from
 *   `summariseFacts`, which is `packages/analytics`' `summarisePeriod` — merged,
 *   clamped, idle subtracted. The AI panel is the most quotable surface in the
 *   product and it must not be the one that disagrees.
 * - **Re-running is safe.** Rows are upserted on
 *   `(company_id, profile_id, kind, period_start)`, which migration
 *   `…0008_ai_summaries_unique.sql` makes unique.
 * - **Only aggregates leave the database.** The select lists live in `aggregate.ts`
 *   and are asserted on by test; no window title, URL or screenshot is read here,
 *   let alone sent to a provider.
 */

/** PostgREST caps a select at 1000 rows; a company week is far more than that. */
const PAGE_SIZE = 1000;

interface Subject {
  profileId: string;
  companyId: string;
  name: string;
}

Deno.serve(async (request: Request) => {
  const denied = authorize(request);
  if (denied) return denied;

  let job;
  try {
    job = parseJobRequest(request.url, await readJsonBody(request));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  const period = resolvePeriod(job.kind, job.reference);
  const supabase = adminClient();

  let sessions: { company_id: string; profile_id: string }[];
  try {
    sessions = await fetchAll((from, to) =>
      supabase
        .from("work_sessions")
        .select("company_id, profile_id")
        .gte("clock_in_at", period.start)
        .lt("clock_in_at", period.end)
        .order("id")
        .range(from, to),
    );
  } catch (err) {
    return json({ error: describe(err) }, 500);
  }

  const candidates = new Map<string, string>();
  for (const session of sessions) {
    candidates.set(session.profile_id, session.company_id);
  }

  if (candidates.size === 0) {
    return json({ kind: period.kind, period, written: 0, skipped: 0, failed: [] });
  }

  const subjects = await loadSubjects(supabase, [...candidates.keys()]);
  const skipped = candidates.size - subjects.length;

  const written: string[] = [];
  const failed: { subject: string; reason: string }[] = [];
  const byCompany = new Map<string, PeriodFacts[]>();

  for (const subject of subjects) {
    try {
      const facts = await loadFacts(supabase, subject, period);

      // Nothing measurable happened: a summary saying so is noise, and writing one
      // would overwrite a good row from an earlier, more complete run.
      if (facts.trackedSeconds === 0) continue;

      const group = byCompany.get(subject.companyId);
      if (group) group.push(facts);
      else byCompany.set(subject.companyId, [facts]);

      // An insight run reads every employee to get the company total right, but
      // writes only the one company row — it must not touch the per-employee rows
      // a daily or weekly run owns.
      if (period.kind === "insight") continue;

      await writeSummary(supabase, {
        companyId: subject.companyId,
        profileId: subject.profileId,
        period,
        facts,
        subject: subject.name,
      });

      written.push(subject.profileId);
    } catch (err) {
      failed.push({ subject: subject.profileId, reason: describe(err) });
    }
  }

  if (period.kind === "insight") {
    for (const [companyId, parts] of byCompany) {
      try {
        const facts = combineFacts(parts, {
          periodStart: period.start,
          periodEnd: period.end,
        });

        await writeSummary(supabase, {
          companyId,
          profileId: null,
          period,
          facts,
          subject: await companyName(supabase, companyId),
        });

        written.push(companyId);
      } catch (err) {
        failed.push({ subject: companyId, reason: describe(err) });
      }
    }
  }

  return json({ kind: period.kind, period, written: written.length, skipped, failed });
});

/**
 * Resolves the people a run may summarise.
 *
 * `monitoring_enabled` is the same switch the agents poll (§4.2). An employee whose
 * monitoring is off has already-collected history in the database, but shipping
 * their aggregates to a third-party model after the company switched them off is
 * not something anyone asked for — so they are skipped, and counted, rather than
 * silently included.
 */
async function loadSubjects(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  profileIds: string[],
): Promise<Subject[]> {
  const subjects: Subject[] = [];

  for (let offset = 0; offset < profileIds.length; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, company_id, full_name, monitoring_enabled")
      .in("id", profileIds.slice(offset, offset + PAGE_SIZE));

    if (error) throw new Error(error.message);

    for (const row of data ?? []) {
      if (row.monitoring_enabled === false) continue;
      subjects.push({
        profileId: row.id,
        companyId: row.company_id,
        // Never render a UUID at a human. An unnamed profile is described by role
        // rather than identified by key.
        name: typeof row.full_name === "string" && row.full_name.length > 0
          ? row.full_name
          : "This employee",
      });
    }
  }

  return subjects;
}

/**
 * How far before the window an event may have started and still overlap it.
 *
 * An event that began before midnight and ran into the day is real — the previous
 * implementation filtered on `started_at >= from` and dropped it. But an open-ended
 * scan backwards cannot use `(company_id, profile_id, started_at)` and would read
 * every stale unclosed row an agent ever crashed out of, so the lookback is bounded
 * instead: `summariseFacts` clamps whatever comes back to the window anyway.
 */
const OVERLAP_LOOKBACK_MS = 86_400_000;

async function loadFacts(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  subject: Subject,
  period: Period,
): Promise<PeriodFacts> {
  const since = new Date(Date.parse(period.start) - OVERLAP_LOOKBACK_MS).toISOString();

  const [activity, idle] = await Promise.all([
    fetchAll<ActivityRow>((from, to) =>
      supabase
        .from("activity_events")
        .select(ACTIVITY_COLUMNS)
        // company_id first: workers run without RLS, so scoping is this query's own
        // job, and it is also the leading column of the composite index.
        .eq("company_id", subject.companyId)
        .eq("profile_id", subject.profileId)
        .gte("started_at", since)
        .lt("started_at", period.end)
        .or(`ended_at.is.null,ended_at.gt.${period.start}`)
        .order("started_at")
        .range(from, to),
    ),
    fetchAll<IdleRow>((from, to) =>
      supabase
        .from("idle_events")
        .select(IDLE_COLUMNS)
        .eq("company_id", subject.companyId)
        .eq("profile_id", subject.profileId)
        .gte("idle_start_at", since)
        .lt("idle_start_at", period.end)
        .or(`idle_end_at.is.null,idle_end_at.gt.${period.start}`)
        .order("idle_start_at")
        .range(from, to),
    ),
  ]);

  return summariseFacts({
    periodStart: period.start,
    periodEnd: period.end,
    activity,
    idle,
  });
}

interface WriteInput {
  companyId: string;
  profileId: string | null;
  period: Period;
  facts: PeriodFacts;
  subject: string;
}

async function writeSummary(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  input: WriteInput,
): Promise<void> {
  const result = await summarise({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt({ facts: input.facts, kind: input.period.kind, subject: input.subject }),
  });

  const document = buildDocument(input.facts, result.content);

  // A document with no prose is a failed run wearing a success's clothes — and an
  // upsert would replace a good earlier row with it.
  if (document.summary.length === 0) {
    throw new Error(`${result.provider} returned no usable text`);
  }

  const { error } = await supabase.from("ai_summaries").upsert(
    {
      company_id: input.companyId,
      profile_id: input.profileId,
      kind: input.period.kind satisfies SummaryKind,
      period_start: input.period.start,
      period_end: input.period.end,
      provider: result.provider,
      model: result.model,
      content: JSON.stringify(document),
    },
    { onConflict: "company_id,profile_id,kind,period_start" },
  );

  if (error) throw new Error(error.message);
}

// deno-lint-ignore no-explicit-any
async function companyName(supabase: any, companyId: string): Promise<string> {
  const { data } = await supabase
    .from("companies")
    .select("name")
    .eq("id", companyId)
    .maybeSingle();

  return typeof data?.name === "string" && data.name.length > 0 ? data.name : "The company";
}

interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/** Walks past PostgREST's 1000-row ceiling instead of silently truncating the day. */
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<PageResult<T>>): Promise<T[]> {
  const rows: T[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);

    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
}

async function readJsonBody(request: Request): Promise<unknown> {
  // pg_cron/pg_net posts an empty body for a plain schedule; that is not an error.
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function describe(err: unknown): string {
  if (err instanceof ProviderRefusal) return `refused: ${err.category ?? "unspecified"}`;
  return err instanceof Error ? err.message : String(err);
}
