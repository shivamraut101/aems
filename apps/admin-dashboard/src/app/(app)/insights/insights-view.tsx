"use client";

import {
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@aems/ui";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";

import { AiInsight } from "@/components/ai-insight";
import { PageHeader } from "@/components/page-header";
import {
  EmptyState,
  ErrorState,
  SkeletonBar,
  TableSkeleton,
} from "@/components/states";
import { describeError, useApiQuery, useSession } from "@/lib/api";
import { duration } from "@/lib/format";
import {
  kindOptionsForRole,
  periodLabel,
  readInsight,
  sortByPeriodDesc,
  type AiSummaryRow,
  type InsightKind,
  type InsightMeasured,
} from "@/lib/queries/insights";

import { employeesQuery } from "../activity/queries";
import { insightsQuery, resolveInsightsRequest } from "./queries";

/**
 * AI Insights — the one surface in the product allowed indigo.
 *
 * The rule the whole screen is built around: a model's reading and a recorded
 * measurement must not look like the same kind of claim. So the seconds the agent
 * actually recorded render in the ordinary palette under the heading "Recorded", and
 * only the model's sentences and its percentage split sit inside the indigo panel. A
 * reader can tell which is which without being told.
 *
 * The summary itself is prefetched by `page.tsx`, so on a normal visit nothing below is
 * ever in a loading state — the skeletons here are for the case where the server
 * prefetch could not answer, which is a real case and not a formality.
 */
export function InsightsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const session = useSession();
  const role = session.data?.role ?? "employee";

  const kinds = useMemo(() => kindOptionsForRole(role), [role]);

  // An employee only ever reads their own; a manager picks from the roster. Resolved by
  // the same function the server used, so the key it warmed is the key read here.
  const request = resolveInsightsRequest({
    kindParam: params.get("kind") ?? undefined,
    profileIdParam: params.get("profileId") ?? undefined,
    fallbackKind: kinds[0]?.value ?? "insight",
    ownProfileId: role === "employee" ? (session.data?.profileId ?? null) : null,
  });

  const activeKind = kinds.find((option) => option.value === request.kind) ?? kinds[0] ?? null;

  const employees = useApiQuery(employeesQuery, { enabled: request.kind !== "insight" });
  const insights = useApiQuery(insightsQuery(request.kind, request.profileId), {
    // A daily summary for a person who has none is a settled answer, and so is a 403.
    retry: false,
    enabled: request.askable,
  });

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

  const needsPerson = !request.askable;
  const showPersonPicker = request.kind !== "insight" && role !== "employee";

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-7">
      <PageHeader
        title="AI Insights"
        subtitle="A model's reading of recorded activity. The measurements beside it are the record itself."
      />

      <div className="mb-5 flex flex-wrap items-end gap-3">
        {/* A filter, not a tab strip: it changes which record is fetched rather than
            which panel is shown, so `aria-pressed` buttons are the honest markup. */}
        <div
          role="group"
          aria-label="Summary kind"
          className="flex shrink-0 items-center gap-0.5 rounded-md border bg-card p-0.5"
        >
          {kinds.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setParam({ kind: option.value, period: null })}
              aria-pressed={option.value === request.kind}
              className={cn(
                // 36px minimum. `py-1.5` alone gave a 32px target, which is under the
                // floor on a phone — and this strip is the primary control on the screen.
                "inline-flex min-h-9 items-center rounded px-2.5 text-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                option.value === request.kind
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {showPersonPicker ? (
          <Field
            label="Person"
            className="w-full min-w-0 sm:w-56"
            // Without this the roster failing renders as a picker with no options
            // beside a body reading "Choose a person" — an outage wearing the empty
            // state's clothes, and a reader with no way to tell they are stuck.
            {...(employees.isError ? { error: describeError(employees.error) } : {})}
          >
            {(field) => (
              <Select
                value={request.profileId ?? ""}
                onValueChange={(value) => setParam({ profileId: value || null, period: null })}
              >
                <SelectTrigger {...field} aria-label="Person">
                  <SelectValue placeholder="Choose a person" />
                </SelectTrigger>
                <SelectContent>
                  {(employees.data ?? []).map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.full_name || person.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
        ) : null}

        {rows.length > 1 ? (
          <Field label="Period" className="w-full min-w-0 sm:w-56">
            {(field) => (
              <Select
                value={selected?.period_start ?? ""}
                onValueChange={(value) => setParam({ period: value })}
              >
                <SelectTrigger {...field} aria-label="Period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {rows.map((row) => (
                    <SelectItem key={row.period_start} value={row.period_start}>
                      {periodLabel(row.kind, row.period_start, row.period_end)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
        ) : null}
      </div>

      {activeKind ? (
        <p className="mb-5 text-sm text-muted-foreground">{activeKind.description}</p>
      ) : null}

      <Body
        loading={insights.isLoading}
        error={insights.isError ? insights.error : null}
        onRetry={() => void insights.refetch()}
        needsPerson={needsPerson}
        kind={request.kind}
        row={selected}
      />
    </div>
  );
}

function Body({
  loading,
  error,
  onRetry,
  needsPerson,
  kind,
  row,
}: {
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  needsPerson: boolean;
  kind: InsightKind;
  row: AiSummaryRow | null;
}) {
  if (needsPerson) {
    return (
      <EmptyState
        title="Choose a person"
        body={`${kind === "daily" ? "Daily" : "Weekly"} summaries are written per employee. Pick someone to read theirs.`}
      />
    );
  }

  // Only a true first load, and only when the server prefetch did not answer: every
  // (kind, person) pair is held in cache, so stepping back to one already read never
  // shows this.
  if (loading) return <InsightBodySkeleton />;

  if (error) {
    /*
     * Every failure here is a real failure.
     *
     * This branch used to test for a 404 first and answer it with an empty state
     * reading "the read path is still to be enabled" — scaffolding from before
     * `GET /api/analytics/insights` existed. It has existed since; the route is
     * registered in `routes/analytics.ts` behind `requireUser` and can only answer 200,
     * 400 or 403. The 404 test was unreachable, and the copy told every reader the
     * backend was unfinished when it was not.
     */
    return (
      <ErrorState
        title="This summary could not be loaded"
        message={describeError(error)}
        onRetry={onRetry}
      />
    );
  }

  if (!row) {
    return (
      <EmptyState
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
      <EmptyState
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
 * Deliberately outside the indigo panel and in the ordinary palette: these seconds come
 * from the same aggregation the timeline and the reports use, so they are the record,
 * and dressing them as AI output would make the whole screen a guess.
 *
 * One column on a phone rather than three. Three cells of "7h 20m" at 375px leaves each
 * about 100px wide, which wraps the label and then wraps the figure — and a measurement
 * broken across two lines stops reading as a measurement.
 */
function Recorded({ measured }: { measured: InsightMeasured }) {
  return (
    <section aria-labelledby="recorded-heading">
      {/* The section-heading size the Overview uses, not the 11px a table header takes —
          this labels a whole half of the page, and it was reading as a column name. */}
      <h2
        id="recorded-heading"
        className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"
      >
        Recorded activity
      </h2>

      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
        <Cell label="Tracked" value={duration(measured.trackedSeconds)} />
        <Cell label="Focused time" value={duration(measured.activeSeconds)} tone="text-success" />
        <Cell label="Idle" value={duration(measured.idleSeconds)} tone="text-warning" />
      </dl>

      {measured.topApps.length > 0 ? (
        <Table containerClassName="mt-3 rounded-lg border bg-card">
          <caption className="sr-only">Applications by time recorded</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col">Application</TableHead>
              <TableHead scope="col" className="text-right">
                Time
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {measured.topApps.map((app) => (
              <TableRow key={app.label}>
                <TableCell className="py-2">{app.label}</TableCell>
                <TableCell className="tabular py-2 text-right text-muted-foreground">
                  {duration(app.seconds)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </section>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </dt>
      <dd className={cn("tabular mt-1 text-xl font-semibold tracking-tight", tone)}>{value}</dd>
    </div>
  );
}

/**
 * The loaded page's shape, without the content.
 *
 * It replaces `<AiInsight summary="" loading />` — a 120px panel standing in for a
 * ~500px page. That collapsed the screen to a fifth of its height and grew it back
 * every time the reader stepped to another period, which is not a first-load cost but a
 * jump on every interaction. Every block below is the same box as its counterpart in
 * {@link Insight}: the three recorded cells, the applications table, the indigo panel,
 * the provenance line.
 *
 * The indigo panel is drawn in the accent, not in grey. Indigo is reserved for AI
 * surfaces per `docs/design.md`, and the reader should be able to see *which* block is
 * about to hold model output before it arrives.
 */
function InsightBodySkeleton() {
  return (
    <div className="space-y-5" aria-busy="true">
      <span className="sr-only" role="status">
        Loading this summary
      </span>

      <section aria-hidden>
        <SkeletonBar className="mb-2 h-3 w-32" />
        {/* Not `StatGridSkeleton`: it sets `grid-template-columns` as an inline style,
            which no responsive class can override, so it would stand three cells wide on
            a phone in front of a grid that lands one cell wide. */}
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="bg-card px-4 py-3">
              <SkeletonBar className="h-3 w-16" />
              <SkeletonBar className="mt-2 h-6 w-20" />
            </div>
          ))}
        </div>
        <TableSkeleton
          className="mt-3"
          minWidthClass="min-w-0"
          caption="Loading applications by time recorded"
          rows={4}
          columns={[
            { key: "app", label: "Application", width: "w-40" },
            { key: "time", label: "Time", align: "right", width: "w-14" },
          ]}
        />
      </section>

      <section
        aria-hidden
        className="min-h-[10rem] rounded-lg border border-accent/25 bg-accent/[0.04] p-5"
      >
        <SkeletonBar className="h-3 w-44" />
        <div className="mt-4 space-y-2">
          <SkeletonBar className="w-full" />
          <SkeletonBar className="w-11/12" />
          <SkeletonBar className="w-3/4" />
        </div>
        {/* Three stacked label/bar/figure rows, matching what the breakdown became.
            A skeleton that is not the shape of its content is a layout shift with a
            pulse on it — see the header of `states/skeletons.tsx`. */}
        <div className="mt-4 space-y-2">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center gap-3">
              <SkeletonBar className="h-3 w-24 shrink-0 sm:w-32" />
              <SkeletonBar className="h-1.5 min-w-0 flex-1" />
              <SkeletonBar className="h-3 w-10 shrink-0" />
            </div>
          ))}
        </div>
        <div className="mt-4 space-y-3">
          {[0, 1].map((index) => (
            <div key={index} className="border-l-2 border-accent/40 pl-3">
              <SkeletonBar className="h-3 w-24" />
              <SkeletonBar className="mt-1.5 h-3.5 w-11/12" />
            </div>
          ))}
        </div>
      </section>

      <SkeletonBar className="h-3 w-72" />
    </div>
  );
}
