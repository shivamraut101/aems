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
import { KpiRow } from "@/components/kpi-row";
import { LiveWorkforce } from "@/components/live-workforce";
import { queryViewState } from "@/components/states";
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

import { overviewQuery } from "./home-queries";

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
        <KpiRow
          loading={overviewState === "loading"}
          items={[
            { label: "Employees", value: String(overview.data?.totalEmployees ?? 0) },
            { label: "Active now", value: String(overview.data?.activeNow ?? 0) },
            { label: "Working today", value: String(overview.data?.workingToday ?? 0) },
            { label: "Hours tracked", value: `${overview.data?.totalHoursToday ?? 0}h` },
            focusedTile(todayPattern.data, todayPattern.isError),
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
function focusedTile(
  document: Parameters<typeof reportTotal>[0],
  failed: boolean,
): { label: string; value: string; hint: string } {
  if (failed) return { label: "Focused time", value: "—", hint: "Could not be read" };
  if (!document) return { label: "Focused time", value: "—", hint: "Active time today" };

  return {
    label: "Focused time",
    value: duration(reportTotal(document, "active")),
    hint: "Active time today",
  };
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
        <Empty body="No application time has been recorded in this period. The desktop agent reports it as people work." />
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
              fill="hsl(var(--primary))"
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

  return (
    <Panel title="Work pattern" subtitle={`Last ${TREND_DAYS} days`}>
      {query.isError ? (
        <Failure error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading || period === null ? (
        <ChartSkeleton />
      ) : days.length === 0 || empty ? (
        <Empty body="No tracked time in this period. Days appear here as agents report them." />
      ) : (
        <>
          <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
            <BarChart data={days} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap="30%">
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
          title: "No company insight yet",
          body: "One reading is written per week from recorded activity. The first appears after the summary worker's next scheduled run.",
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
      <p className="mt-2 text-xs text-muted-foreground">
        Written by {latest.provider} · {latest.model} for{" "}
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
    <section className="rounded-lg border bg-card p-4">
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

function Empty({ body }: { body: string }) {
  return (
    <div
      className="flex items-center justify-center rounded-md border border-dashed px-4"
      style={{ height: CHART_HEIGHT }}
    >
      <p className="max-w-xs text-center text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
