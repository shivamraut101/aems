"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";

import { AiInsight } from "@/components/ai-insight";
import { LiveWorkforce } from "@/components/live-workforce";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState, queryViewState } from "@/components/states";
import { VerdictBlock } from "@/components/verdict-block";
import {
  appUsageBars,
  describeError,
  isSessionExpired,
  reportTotal,
  todaySoFar,
  trailingUtcDays,
  useApiQuery,
  useCompanyAppUsage,
  useCompanyWorkPattern,
  workPatternDays,
  type AppUsageBar,
  type WorkPatternDay,
} from "@/lib/api";
import { duration, greeting, longDate } from "@/lib/format";
import {
  isInsightsUnavailable,
  periodLabel,
  readInsight,
  sortByPeriodDesc,
  useInsights,
} from "@/lib/queries/insights";

import { computeVerdict } from "@/lib/verdict";

import { liveWorkforceQuery, overviewQuery } from "./home-queries";

/** How much history the trend answers "compared to what?" with. */
const TREND_DAYS = 7;

/** Both charts stand the same height, so the two panels read as one instrument. */
const CHART_HEIGHT = 188;

/**
 * A value-axis tick, in the unit the day is actually in.
 *
 * Hours alone printed "0h" five times down the axis on any day under thirty
 * minutes — five identical labels next to a bar that plainly was not zero. The
 * first hour of a monitored day is exactly when someone is watching this screen.
 */
function axisTick(seconds: number): string {
  if (seconds <= 0) return "0";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** SVG cannot read a Tailwind class, so the tokens are named here as CSS variables. */
const INK_MUTED = "hsl(var(--muted-foreground))";
const SURFACE = "hsl(var(--card))";

/** SVG paint servers are referenced by id, and only one work-pattern chart exists. */
const MISSING_DAY_PATTERN = "work-pattern-missing-day";

/**
 * The work pattern's three bands, in stack order.
 *
 * Emerald and amber are docs/design.md's status colours, used here as status rather
 * than as identity — focused time is good, idle is a caution, and a declared break is
 * neither, so it takes the neutral ink. They ship with a legend and a tooltip that
 * names each band, never colour alone, because the emerald/amber pair sits at the
 * lower end of the colour-blind separation range.
 */
const PATTERN_SERIES = [
  { key: "focusedSeconds", label: "Focused", color: "hsl(var(--success))" },
  { key: "idleSeconds", label: "Idle", color: "hsl(var(--warning))" },
  { key: "breakSeconds", label: "Break", color: INK_MUTED },
] as const;

/**
 * The viewer's own clock, available only after mount.
 *
 * `greeting()` reads the local hour and `longDate()` the local timezone AND locale.
 * A "use client" component is still server-rendered for the first paint, and the
 * server knows neither: it produced "Good afternoon"/"Wednesday 5 August" in the
 * server's zone while the browser produced its own, and React threw a hydration
 * mismatch on this page.
 *
 * Deferring is the fix rather than `suppressHydrationWarning`, which only silences
 * the warning and KEEPS the server's text — so a server an ocean away would wish a
 * user good morning at 9pm. In a product about when people work, that is not a
 * detail worth trading for one frame.
 *
 * The charts below lean on the same signal for a second reason: their reporting
 * windows are anchored to the reader's own instant, so they cannot be requested
 * until this resolves — and pinning `now` once keeps the query keys stable rather
 * than minting a new window, and a new fetch, on every render.
 */
function useLocalNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  return now;
}

/**
 * True on a phone-width viewport.
 *
 * Recharts lays out in pixels — an axis width, a label offset, a font size — and CSS
 * cannot reach any of it, so the one place in this app that needs a breakpoint in
 * JavaScript is here. `matchMedia` rather than a resize listener: the browser
 * evaluates the query and calls back only when the *answer* changes, so dragging a
 * window edge is one state update rather than sixty.
 *
 * Resolved after mount, like `useLocalNow` and for the same reason: the server has no
 * viewport. Nothing flashes as a result, because both charts already render their
 * skeleton until the local clock is known, and that happens on the same tick.
 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    // 640px is Tailwind's `sm`, so the JS breakpoint and the CSS ones agree.
    const query = window.matchMedia("(max-width: 639px)");
    const apply = () => setNarrow(query.matches);

    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  return narrow;
}

/**
 * Dashboard home.
 *
 * Answers one question — "how is my company doing today?" — in the order a manager
 * actually asks it: the numbers, then who is working, then what the week looked
 * like, then what the model makes of it. Nothing on this page is written into the
 * source; every figure below comes back from the API or is not shown.
 *
 * The client half of the two-file page: `page.tsx` beside it prefetches the headline
 * metrics and the live board on the server, so both are in the first paint rather
 * than swapped in after hydration.
 */
export function OverviewView() {
  const now = useLocalNow();
  const narrow = useNarrow();
  const today = useMemo(() => (now ? todaySoFar(now) : null), [now]);
  // Both panels share one window so "the last seven days" means the same seven days
  // in each. It is UTC-aligned because the per-day report buckets by UTC day, and a
  // request that starts mid-bucket comes back with a sliver bar on the front.
  const week = useMemo(() => (now ? trailingUtcDays(TREND_DAYS, now) : null), [now]);

  // Warmed by `page.tsx`, so the KPI row holds real figures in the first paint. It
  // used to render four em dashes and swap.
  const overview = useApiQuery(overviewQuery);
  const overviewState = queryViewState(overview);
  const todayPattern = useCompanyWorkPattern(today);

  // Both were warmed on the server by page.tsx, so the verdict is in the first paint
  // rather than swapped in a beat later. `now` gates it for the same reason the
  // greeting is gated: the staleness threshold is measured against the reader clock.
  const live = useApiQuery(liveWorkforceQuery);
  const verdict = useMemo(
    () => (now ? computeVerdict(overview.data, live.data, now.getTime()) : null),
    [overview.data, live.data, now],
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-7">
      <header className="mb-6">
        {/* Non-breaking spaces hold both lines' height for the one frame before the
            local clock is known, so the page does not jump as it settles. */}
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">
          {now ? greeting(now) : " "}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{now ? longDate(now) : " "}</p>
      </header>

      {overviewState === "error" ? (
        // Without this branch `isLoading` is false and `data` is undefined on any
        // failure, so the row painted "Employees 0 · Active now 0 · Hours 0h". An
        // outage, an expired session and a company with nobody in it were pixel
        // identical, and the zeros read as a statement about the business.
        <Failure error={overview.error} onRetry={() => void overview.refetch()} />
      ) : (
        /*
         * The verdict, not a row of five equal numbers.
         *
         * The figures survive underneath it — leading with a conclusion is not the
         * same as hiding the evidence — but the sentence above them is what a manager
         * actually opens this page for. `KpiRow` is unused here as a result; it is
         * still the right component for the employee tabs, where the reader has
         * already chosen who they are looking at and wants the measurements.
         */
        <VerdictBlock
          loading={overviewState === "loading" || now === null}
          verdict={verdict}
          figures={[
            { label: "Active right now", value: String(overview.data?.activeNow ?? 0) },
            { label: "Tracked today", value: `${overview.data?.totalHoursToday ?? 0}h` },
            focusedFigure(todayPattern.data, todayPattern.isError),
            { label: "Working today", value: String(overview.data?.workingToday ?? 0) },
            { label: "People", value: String(overview.data?.totalEmployees ?? 0) },
          ]}
        />
      )}

      <section className="mt-9">
        <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          Live workforce
        </h2>
        <LiveWorkforce />
      </section>

      <section className="mt-9">
        <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          Activity intelligence
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <AppUsagePanel period={week} narrow={narrow} />
          <WorkPatternPanel period={week} narrow={narrow} />
        </div>
      </section>

      <section className="mt-8">
        <AiPanel />
      </section>
    </div>
  );
}

/**
 * The fifth headline number, as a work pattern rather than a score.
 *
 * `docs/scope.md` §4.1 names five metrics and this row showed four. The fifth it
 * names is "average productivity", which `docs/design.md` explicitly rejects as a
 * bare percentage — "Focused time 7h 20m" is the same measurement stated as
 * something a manager can act on. It is the merged active total from the same
 * aggregation the reports and the CSV export quote, so the three cannot drift.
 */
/**
 * Focused time, as one of the verdict's supporting figures.
 *
 * An em dash rather than "0m" when the report could not be read: zero is a claim that
 * nobody did any focused work today, and an outage must not be allowed to make it.
 */
function focusedFigure(
  document: Parameters<typeof reportTotal>[0],
  failed: boolean,
): { label: string; value: string } {
  if (failed || !document) return { label: "Focused", value: "—" };
  return { label: "Focused", value: duration(reportTotal(document, "active")) };
}

/* -------------------------------------------------------------------------- */
/* Activity intelligence                                                       */
/* -------------------------------------------------------------------------- */

/** Time in each application across the company — docs/design.md's "App Usage". */
function AppUsagePanel({
  period,
  narrow,
}: {
  period: { from: string; to: string } | null;
  narrow: boolean;
}) {
  const query = useCompanyAppUsage(period);
  const bars = useMemo(() => appUsageBars(query.data), [query.data]);

  return (
    <Panel title="App usage" subtitle={`Last ${TREND_DAYS} days`}>
      {query.isError ? (
        <Failure error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading || period === null ? (
        <ChartSkeleton />
      ) : bars.length === 0 ? (
        <Empty
          title="No application time yet"
          body={`The desktop agent reports which application is in front as people work. Nothing has arrived in the last ${TREND_DAYS} days.`}
        />
      ) : (
        // A single hue, because this is one measure compared across categories —
        // a colour per application would encode identity nobody needs to read.
        <ResponsiveContainer width="100%" height={Math.max(bars.length * 30 + 10, CHART_HEIGHT)}>
          <BarChart
            data={bars}
            layout="vertical"
            // The right margin is where the direct labels go, and the Y axis is where
            // the app names go. Both are a third of a 375px screen at desktop sizes,
            // which leaves a bar chart with almost no bar.
            margin={{ top: 0, right: narrow ? 44 : 64, left: 0, bottom: 0 }}
            barCategoryGap={10}
          >
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="label"
              width={narrow ? 84 : 112}
              tickLine={false}
              axisLine={false}
              tick={{ fill: INK_MUTED, fontSize: narrow ? 11 : 12 }}
              // Recharts wraps a category tick that will not fit, so "Visual Studio
              // Code" became three stacked lines colliding with the rows above and
              // below it. One line, clipped, with the full name still in the tooltip:
              // a chart row is a label, not a place to read a sentence.
              tickFormatter={(value: string) => {
                const limit = narrow ? 12 : 17;
                return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
              }}
            />
            <Tooltip cursor={{ fill: "hsl(var(--secondary))" }} content={<AppTooltip />} />
            <Bar
              dataKey="seconds"
              // Held back from full-strength navy. At 100% these six bars were the
              // heaviest ink on the page, which put reference data above the verdict
              // and the live board in the reading order.
              fill="hsl(var(--primary)/0.72)"
              radius={[0, 4, 4, 0]}
              barSize={12}
              isAnimationActive={false}
            >
              {/* Direct labels rather than a value axis: six numbers read faster
                  beside their bars than against a ruler. */}
              <LabelList
                dataKey="seconds"
                position="right"
                offset={narrow ? 6 : 8}
                fill={INK_MUTED}
                fontSize={narrow ? 10 : 11}
                formatter={(value: number) => duration(value)}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </Panel>
  );
}

/** Focused / idle / break per day — docs/design.md's "Productivity Trend". */
function WorkPatternPanel({
  period,
  narrow,
}: {
  period: { from: string; to: string } | null;
  narrow: boolean;
}) {
  const query = useCompanyWorkPattern(period);
  const days = useMemo(() => workPatternDays(query.data), [query.data]);
  const empty = days.every((day) => day.trackedSeconds === 0);

  /*
   * A day nobody worked stacks to zero, so it draws nothing at all — and a week with
   * one working day in it rendered as one bar beside six blank columns, which reads as
   * a chart that failed rather than as a company that did not work. The stub is a
   * fixed fraction of the tallest day so it scales with the axis: too short to be
   * mistaken for a measurement, tall enough to say "we looked, there was nothing".
   */
  const plotted = useMemo(() => {
    const tallest = days.reduce((max, day) => Math.max(max, day.trackedSeconds), 0);
    return days.map((day) => ({
      ...day,
      missingSeconds: day.trackedSeconds === 0 ? tallest * 0.05 : 0,
    }));
  }, [days]);
  const anyMissing = plotted.some((day) => day.missingSeconds > 0);

  return (
    <Panel title="Work pattern" subtitle={`Last ${TREND_DAYS} days`}>
      {query.isError ? (
        <Failure error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading || period === null ? (
        <ChartSkeleton />
      ) : days.length === 0 || empty ? (
        <Empty
          title="No tracked time yet"
          body={`A day appears here once an agent has reported work on it. None of the last ${TREND_DAYS} days has any.`}
        />
      ) : (
        <>
          <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
            <BarChart
              data={plotted}
              margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
              barCategoryGap="30%"
            >
              <defs>
                {/* Hatching rather than a flat grey: a solid stub of any colour is a
                    fourth band, and a reader would have to be told it means nothing.
                    A hatch is not a quantity anywhere on this page. */}
                <pattern
                  id={MISSING_DAY_PATTERN}
                  width={5}
                  height={5}
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <line
                    x1={0}
                    y1={0}
                    x2={0}
                    y2={5}
                    stroke={INK_MUTED}
                    strokeWidth={1.5}
                    strokeOpacity={0.4}
                  />
                </pattern>
              </defs>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="2 4" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                // Recharts drops colliding labels rather than overlapping them, so
                // seven days on a phone thin themselves out instead of turning to mud.
                minTickGap={narrow ? 12 : 5}
                tick={{ fill: INK_MUTED, fontSize: narrow ? 10 : 11 }}
              />
              <YAxis
                width={narrow ? 30 : 40}
                tickLine={false}
                axisLine={false}
                tick={{ fill: INK_MUTED, fontSize: narrow ? 10 : 11 }}
                tickFormatter={axisTick}
              />
              <Tooltip cursor={{ fill: "hsl(var(--secondary))" }} content={<PatternTooltip />} />
              {PATTERN_SERIES.map((series) => (
                <Bar
                  key={series.key}
                  dataKey={series.key}
                  name={series.label}
                  stackId="day"
                  fill={series.color}
                  // A hairline in the surface colour separates the bands, so two
                  // adjacent fills never read as one block.
                  stroke={SURFACE}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
              ))}
              {/* Last in the stack, and only ever non-zero when the other three are
                  zero, so it never sits on top of a real reading. */}
              <Bar
                dataKey="missingSeconds"
                name="No tracked time"
                stackId="day"
                fill={`url(#${MISSING_DAY_PATTERN})`}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>

          {/* Identity is never carried by colour alone. */}
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            {PATTERN_SERIES.map((series) => (
              <li key={series.key} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-[2px]"
                  style={{ backgroundColor: series.color }}
                />
                {series.label}
              </li>
            ))}
            {anyMissing ? (
              <li className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-[2px]"
                  style={{
                    backgroundImage: `repeating-linear-gradient(45deg, ${INK_MUTED} 0 1px, transparent 1px 3px)`,
                  }}
                />
                No tracked time
              </li>
            ) : null}
          </ul>

          <PatternTable days={days} />
        </>
      )}
    </Panel>
  );
}

/**
 * The same numbers as a table, for a reader the chart does not serve.
 *
 * A stacked bar encodes three quantities per column in emerald, amber and grey at
 * small sizes; none of that survives a screen reader, and the emerald/amber pair is
 * close enough under colour blindness that the legend alone is thin relief.
 */
function PatternTable({ days }: { days: WorkPatternDay[] }) {
  return (
    <table className="sr-only">
      <caption>Work pattern by day</caption>
      <thead>
        <tr>
          <th scope="col">Day</th>
          {PATTERN_SERIES.map((series) => (
            <th key={series.key} scope="col">
              {series.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {days.map((day) => (
          <tr key={day.key}>
            <th scope="row">{day.label}</th>
            <td>{duration(day.focusedSeconds)}</td>
            <td>{duration(day.idleSeconds)}</td>
            <td>{duration(day.breakSeconds)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AppTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;

  const point = payload[0]?.payload as AppUsageBar | undefined;
  if (!point) return null;

  return (
    <TooltipCard title={point.label}>
      <span className="tabular">
        {duration(point.seconds)} · {Math.round(point.share * 100)}% of tracked time
      </span>
    </TooltipCard>
  );
}

function PatternTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;

  const day = payload[0]?.payload as WorkPatternDay | undefined;
  if (!day) return null;

  // Matches the hatched stub: three zeroes would read as three measurements that all
  // came out at nothing, which is a different claim from "no agent reported that day".
  if (day.trackedSeconds === 0) {
    return <TooltipCard title={day.label}>No tracked time</TooltipCard>;
  }

  return (
    <TooltipCard title={day.label}>
      <span className="tabular block">Focused {duration(day.focusedSeconds)}</span>
      <span className="tabular block">Idle {duration(day.idleSeconds)}</span>
      <span className="tabular block">Break {duration(day.breakSeconds)}</span>
      <span className="tabular mt-1 block border-t pt-1">
        Tracked {duration(day.trackedSeconds)}
      </span>
    </TooltipCard>
  );
}

function TooltipCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-popover px-2.5 py-2 text-xs shadow-sm">
      <p className="font-medium text-popover-foreground">{title}</p>
      <div className="mt-0.5 text-muted-foreground">{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* AI                                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The company insight the AI worker has written, if it has written one.
 *
 * This panel used to render two sentences from the source — "Deploy
 * supabase/functions/ai-summary and schedule it to enable this panel" — on the one
 * surface the product reserves for model output. It said the same thing whether
 * `ai_summaries` held nothing or held a week of readings, which is worse than an
 * empty panel: it is a developer note in the model's voice. Every branch below is
 * now driven by what `GET /api/analytics/insights?kind=insight` actually answered.
 */
function AiPanel() {
  const insights = useInsights("insight");

  const rows = useMemo(() => sortByPeriodDesc(insights.data ?? []), [insights.data]);
  const latest = rows[0] ?? null;
  const view = useMemo(() => (latest ? readInsight(latest.content) : null), [latest]);

  if (insights.isLoading) return <AiInsight summary="" loading />;

  if (insights.isError) {
    // A missing read path is an unfinished backend, not something the reader did,
    // and an error banner on the AI surface reads as though the model failed.
    if (isInsightsUnavailable(insights.error)) {
      return (
        <AiInsight
          summary=""
          notice={{
            title: "Summaries are not being served yet",
            body: "The summary worker writes them on a schedule; the read path that serves them to this screen is still to be enabled.",
          }}
        />
      );
    }

    return <Failure error={insights.error} onRetry={() => void insights.refetch()} />;
  }

  if (!latest || !view) {
    return (
      <AiInsight
        summary=""
        notice={{
          // "No company insight yet" was true and told the reader nothing they could
          // act on: not what produces one, not what it needs, not when to look again.
          title: "The first weekly insight has not been written yet",
          body: "One reading is written per week from the activity your agents have already recorded — so a week with tracked time in it produces one, and an empty week does not. The next scheduled run of the summary worker writes it.",
        }}
      />
    );
  }

  if (view.summary.length === 0) {
    return (
      <AiInsight
        summary=""
        notice={{
          title: "This summary could not be read",
          body: "The stored document is in a shape this version of the dashboard does not recognise. The next scheduled run replaces it.",
        }}
      />
    );
  }

  return (
    <>
      <AiInsight
        summary={view.summary}
        breakdown={view.breakdown}
        observation={view.observation}
        recommendation={view.recommendation}
      />
      {/* When it was written, not only which period it covers. A weekly reading is
          only actionable if the reader knows whether it is three hours or three weeks
          old, and the two are indistinguishable from the period label alone. */}
      <p className="mt-2 text-xs text-muted-foreground">
        Written <RelativeTime iso={latest.created_at} /> by {latest.provider} · {latest.model} for{" "}
        {periodLabel(latest.kind, latest.period_start, latest.period_end)}.{" "}
        <Link
          href="/insights"
          className="underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          All insights
        </Link>
      </p>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                               */
/* -------------------------------------------------------------------------- */

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-[var(--shadow-sm)]">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * A failed query, described to the person rather than to the developer.
 *
 * `describeError` rather than `error.message`, and a way forward that matches the
 * failure: retrying a 401 spends another round trip to be refused identically, so
 * an expired session gets the sign-in link instead of a button.
 */
function Failure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
    >
      <p className="text-sm">{describeError(error)}</p>

      {/* Both are 36px tall, not padding-sized. Measured at 375px they came out 30,
          and the one control on a failed panel is the one a thumb must not miss. */}
      {isSessionExpired(error) ? (
        <Link
          href="/login"
          className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Sign in
        </Link>
      ) : (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Try again
        </button>
      )}
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div
      className="animate-pulse rounded-md bg-muted"
      style={{ height: CHART_HEIGHT }}
      aria-hidden
    />
  );
}

/**
 * The shared empty state, held to the chart's own height.
 *
 * `EmptyState` sizes to its content, and a panel that collapses from 188px to 130px the
 * moment an empty answer lands is the layout shift the skeletons exist to prevent — so
 * the box is fixed here and the copy comes from the shared component.
 */
function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex rounded-md border border-dashed" style={{ height: CHART_HEIGHT }}>
      <EmptyState bordered={false} className="m-auto py-0" title={title} body={body} />
    </div>
  );
}
