"use client";

import { cn } from "@aems/ui";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";

import { AiInsight } from "@/components/ai-insight";
import { PageHeader } from "@/components/page-header";
import { describeError, useEmployees, useSession } from "@/lib/api";
import { duration } from "@/lib/format";
import {
  isInsightsUnavailable,
  kindOptionsForRole,
  periodLabel,
  readInsight,
  sortByPeriodDesc,
  useInsights,
  type AiSummaryRow,
  type InsightKind,
  type InsightMeasured,
} from "@/lib/queries/insights";

/**
 * AI Insights — the one surface in the product allowed indigo.
 *
 * The rule the whole screen is built around: a model's reading and a recorded
 * measurement must not look like the same kind of claim. So the seconds the agent
 * actually recorded render in the ordinary palette under the heading "Recorded", and
 * only the model's sentences and its percentage split sit inside the indigo panel.
 * A reader can tell which is which without being told.
 */
export default function InsightsPage() {
  return (
    <Suspense fallback={<InsightsSkeleton />}>
      <InsightsScreen />
    </Suspense>
  );
}

function InsightsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const session = useSession();
  const employees = useEmployees();

  const kinds = useMemo(() => kindOptionsForRole(session.data?.role ?? "employee"), [session.data?.role]);
  const kind = (params.get("kind") as InsightKind | null) ?? kinds[0]?.value ?? "insight";
  const activeKind = kinds.find((option) => option.value === kind) ?? kinds[0] ?? null;

  // An employee only ever reads their own; a manager picks from the roster.
  const ownProfile = session.data?.role === "employee" ? (session.data.profileId ?? null) : null;
  const profileId = kind === "insight" ? null : (ownProfile ?? params.get("profileId"));

  const insights = useInsights(kind, profileId);
  const rows = useMemo(() => sortByPeriodDesc(insights.data ?? []), [insights.data]);

  const selectedPeriod = params.get("period");
  const selected: AiSummaryRow | null =
    rows.find((row) => row.period_start === selectedPeriod) ?? rows[0] ?? null;

  function setParam(next: Record<string, string | null>) {
    const query = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null) query.delete(key);
      else query.set(key, value);
    }
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  }

  const needsPerson = kind !== "insight" && !profileId;

  return (
    <div className="mx-auto max-w-5xl px-6 py-7">
      <PageHeader
        title="AI Insights"
        subtitle="A model's reading of recorded activity. The measurements beside it are the record itself."
      />

      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Summary kind" className="flex items-center gap-0.5 rounded-md border bg-card p-0.5">
          {kinds.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setParam({ kind: option.value, period: null })}
              aria-pressed={option.value === kind}
              className={cn(
                "rounded px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                option.value === kind
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {kind !== "insight" && !ownProfile ? (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Person</span>
            <select
              value={profileId ?? ""}
              onChange={(event) => setParam({ profileId: event.target.value || null, period: null })}
              className="h-9 w-56 rounded-md border bg-card px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Choose a person</option>
              {(employees.data ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.full_name || person.email}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {rows.length > 1 ? (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Period</span>
            <select
              value={selected?.period_start ?? ""}
              onChange={(event) => setParam({ period: event.target.value })}
              className="h-9 w-56 rounded-md border bg-card px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {rows.map((row) => (
                <option key={row.period_start} value={row.period_start}>
                  {periodLabel(row.kind, row.period_start, row.period_end)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {activeKind ? (
        <p className="mb-5 text-sm text-muted-foreground">{activeKind.description}</p>
      ) : null}

      <Body
        loading={insights.isLoading}
        error={insights.isError ? insights.error : null}
        needsPerson={needsPerson}
        row={selected}
      />
    </div>
  );
}

function Body({
  loading,
  error,
  needsPerson,
  row,
}: {
  loading: boolean;
  error: unknown;
  needsPerson: boolean;
  row: AiSummaryRow | null;
}) {
  if (needsPerson) {
    return (
      <Empty
        title="Choose a person"
        body="Daily and weekly summaries are written per employee. Pick someone to read theirs."
      />
    );
  }

  if (loading) return <AiInsight summary="" loading />;

  if (error) {
    // A missing read path is an unfinished backend, not something the reader did —
    // and an error banner on the AI screen reads like the model failed.
    if (isInsightsUnavailable(error)) {
      return (
        <Empty
          title="Summaries are not being served yet"
          body="The summary worker writes them on a schedule; the read path that serves them to this screen is still to be enabled."
        />
      );
    }

    return (
      <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
        {describeError(error)}
      </p>
    );
  }

  if (!row) {
    return (
      <Empty
        title="No summary for this period yet"
        body="Summaries are written once per period, after the activity they describe. The first one appears the day after an agent starts reporting."
      />
    );
  }

  return <Insight row={row} />;
}

function Insight({ row }: { row: AiSummaryRow }) {
  const view = useMemo(() => readInsight(row.content), [row.content]);

  if (view.summary.length === 0) {
    return (
      <Empty
        title="This summary could not be read"
        body="The stored document is in a shape this version of the dashboard does not recognise. The next scheduled run replaces it."
      />
    );
  }

  return (
    <div className="space-y-5">
      {view.measured ? <Recorded measured={view.measured} /> : null}

      <AiInsight
        summary={view.summary}
        breakdown={view.breakdown}
        observation={view.observation}
        recommendation={view.recommendation}
      />

      <p className="text-xs text-muted-foreground">
        {view.breakdown.length > 0
          ? "The split above is the model's reading of recorded activity, not a separate measurement. "
          : ""}
        Written by {row.provider} · {row.model} for {periodLabel(row.kind, row.period_start, row.period_end)}.
      </p>
    </div>
  );
}

/**
 * The recorded half.
 *
 * Deliberately outside the indigo panel and in the ordinary palette: these seconds
 * come from the same aggregation the timeline and the reports use, so they are the
 * record, and dressing them as AI output would make the whole screen a guess.
 */
function Recorded({ measured }: { measured: InsightMeasured }) {
  return (
    <section aria-labelledby="recorded-heading">
      <h2
        id="recorded-heading"
        className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Recorded activity
      </h2>

      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border">
        <Cell label="Tracked" value={duration(measured.trackedSeconds)} />
        <Cell label="Focused time" value={duration(measured.activeSeconds)} tone="text-[hsl(var(--success))]" />
        <Cell label="Idle" value={duration(measured.idleSeconds)} tone="text-[hsl(var(--warning))]" />
      </dl>

      {measured.topApps.length > 0 ? (
        <div className="mt-3 overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <caption className="sr-only">Applications by time recorded</caption>
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">Application</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {measured.topApps.map((app) => (
                <tr key={app.label} className="border-b last:border-0">
                  <td className="px-4 py-2">{app.label}</td>
                  <td className="tabular px-4 py-2 text-right text-muted-foreground">
                    {duration(app.seconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("tabular mt-1 text-xl font-semibold tracking-tight", tone)}>{value}</dd>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function InsightsSkeleton() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-7">
      <div className="mb-6 h-7 w-40 animate-pulse rounded bg-muted" />
      <div className="h-44 animate-pulse rounded-lg border bg-card" />
    </div>
  );
}
