"use client";

import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aems/ui";
import { Camera, LogIn, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { KpiRow } from "@/components/kpi-row";
import { SkeletonBar } from "@/components/states";
import { describeError } from "@/lib/api";
import { duration, timeOfDay } from "@/lib/format";
import { useEmployeeDay } from "@/lib/queries/employee";

import type { DayWindow } from "./day-window";
import {
  buildOverviewKpis,
  describeDay,
  summariseDay,
  topApplications,
  type DayVerdict,
  type DaySummary,
} from "./overview-model";
import {
  EmptyState,
  ErrorState,
  Panel,
  SectionHeading,
  SkeletonLines,
  TruncationNotice,
} from "./states";
import { dayHref } from "./tabs";
import { useDayWindow } from "./use-day-window";
import { WorkPatternBlock } from "./work-pattern-block";
import { buildWorkPattern } from "./work-pattern";

/**
 * The Overview tab — scope §4.4's "Today" block, plus docs/design.md's Work Pattern.
 *
 * One request serves the whole tab. `/api/analytics/timeline` already reduces the day
 * server-side into totals, spans, markers and app rankings, and it is the same request
 * the Timeline tab makes, so switching between the two costs nothing.
 */
export function OverviewTab({
  profileId,
  appsHref,
}: {
  profileId: string;
  /**
   * Where "All applications" points, or null for no link at all.
   *
   * Defaults to the manager route this tab was built for. `/me` passes null: an
   * employee reaching `/people/:id/apps` is refused by `canAccessPath`, so offering
   * the link would hand them a dead end the shell then blocks.
   */
  appsHref?: string | null;
}) {
  const day = useDayWindow();
  const { data, isLoading, isError, error, refetch } = useEmployeeDay(
    profileId,
    day?.from ?? "",
    day?.to ?? "",
  );

  if (isError) {
    return (
      <ErrorState
        title="Could not load this day"
        message={describeError(error)}
        onRetry={() => void refetch()}
      />
    );
  }

  if (!day || isLoading || !data) return <OverviewSkeleton />;

  const pattern = buildWorkPattern(data);
  const summary = summariseDay(data);
  const apps = topApplications(data);
  const nothingRecorded =
    data.totals.trackedSeconds === 0 && data.markers.length === 0 && apps.length === 0;

  if (nothingRecorded) return <NoActivity day={day} />;

  return (
    <div className="space-y-6">
      {data.truncated ? <TruncationNotice /> : null}

      <DayVerdictBlock verdict={describeDay(data, pattern)} summary={summary} />

      <KpiRow items={buildOverviewKpis(data, pattern)} />

      <div className="grid gap-6 lg:grid-cols-2">
        <WorkPatternBlock pattern={pattern} />
        <TopApplications
          apps={apps}
          total={data.topApps.length}
          appsHref={
            appsHref === undefined ? `/people/${encodeURIComponent(profileId)}/apps` : appsHref
          }
        />
      </div>
    </div>
  );
}

/**
 * What the day amounts to, above the figures that evidence it.
 *
 * The same shape as `components/verdict-block.tsx` on the Overview page, for the same
 * reason: a reader opening a person's day wants to know whether it was an ordinary
 * one before they want four durations. The sentence itself is decided in
 * `overview-model.ts` and tested there; this file only draws it.
 *
 * The clock-in / clock-out / captures line is scope §2.2's "Work Started: 09:05 AM",
 * and it lives here as the block's footer rather than as its own bar underneath —
 * those three are the anchor the headline needs, not a separate reading. Its
 * condition is unchanged: nothing is drawn for a day with neither a session nor a
 * capture, because three em dashes is not an answer.
 */
function DayVerdictBlock({ verdict, summary }: { verdict: DayVerdict; summary: DaySummary }) {
  const hasMoments = Boolean(summary.clockInAt) || summary.screenshotCount > 0;

  return (
    <section
      aria-label="This day at a glance"
      className="rounded-lg border bg-card p-5 shadow-[var(--shadow-sm)] sm:p-6"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="tabular text-2xl font-semibold tracking-[-0.025em] sm:text-[26px]">
          {verdict.headline}
        </h2>
        {/* A state, so it takes the dot. Never indigo and never destructive: a finished
            day is not a fault, and neither is an open one. */}
        {verdict.state === "working" ? (
          <Badge variant="success" dot>
            Still working
          </Badge>
        ) : verdict.state === "finished" ? (
          <Badge variant="secondary" dot>
            Day finished
          </Badge>
        ) : null}
      </div>

      <p className="mt-2 max-w-[64ch] text-sm text-muted-foreground">{verdict.sentence}</p>

      {hasMoments ? (
        <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-3 border-t pt-4 text-sm">
          {summary.clockInAt ? (
            <Moment icon={<LogIn className="h-3.5 w-3.5" aria-hidden />} label="Started">
              {timeOfDay(summary.clockInAt)}
            </Moment>
          ) : null}

          <Moment icon={<LogOut className="h-3.5 w-3.5" aria-hidden />} label="Finished">
            {summary.openSession
              ? "Still working"
              : summary.clockOutAt
                ? timeOfDay(summary.clockOutAt)
                : "—"}
          </Moment>

          <Moment icon={<Camera className="h-3.5 w-3.5" aria-hidden />} label="Captures">
            {summary.screenshotCount}
          </Moment>
        </dl>
      ) : null}
    </section>
  );
}

function Moment({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="tabular font-medium">{children}</dd>
    </div>
  );
}

/**
 * Applications by time. A table, not cards — docs/design.md puts operations in tables.
 *
 * Five rows and a link out: the Apps tab owns the full list, and duplicating it here
 * would give a manager two places to read the same number.
 */
function TopApplications({
  apps,
  total,
  appsHref,
}: {
  apps: ReturnType<typeof topApplications>;
  /** How many applications the day's response held, so the list can say it is a slice. */
  total: number;
  appsHref: string | null;
}) {
  return (
    <Panel className="p-0">
      <div className="p-5 pb-0">
        <SectionHeading
          title="Applications"
          // Says it is a slice when it is one. A list silently capped at five reads as
          // a complete answer, and then the Apps tab disagrees with it.
          hint={
            total > apps.length
              ? `Busiest first — showing ${apps.length} of ${total}.`
              : "Busiest first, over the tracked day."
          }
          action={
            appsHref ? (
              <Link
                href={appsHref}
                className="rounded text-xs font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                All applications
              </Link>
            ) : null
          }
        />
      </div>

      {apps.length === 0 ? (
        <EmptyState
          title="No application activity"
          body="The agent recorded no window focus for this day."
        />
      ) : (
        // The shared primitive rather than a hand-rolled table: it is where the row
        // hover, the 38px rhythm and the header treatment are decided, and this one
        // had drifted from all three. `mt-4` on the container because the heading above
        // it owns the panel's padding; `rounded-b-lg` because the rows now light up on
        // hover, and a square highlight would sit outside the panel's bottom corners.
        <Table containerClassName="mt-4 rounded-b-lg">
          <caption className="sr-only">Applications used, longest first</caption>
          <TableHeader>
            <TableRow className="border-t hover:bg-transparent">
              <TableHead className="px-5">Application</TableHead>
              <TableHead className="hidden px-5 sm:table-cell">Category</TableHead>
              <TableHead className="px-5 text-right">Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.map((app) => (
              <TableRow key={app.appName}>
                <TableCell className="px-5">
                  <span className="font-medium">{app.appName}</span>
                  {/* The share is a bar under the name rather than a number in its
                      own column: the ranking is the point, the percentage is not. */}
                  <span
                    aria-hidden
                    className="mt-1.5 block h-1 rounded-full bg-success/55"
                    style={{ width: `${Math.max(2, app.share * 100)}%` }}
                  />
                </TableCell>
                <TableCell className="hidden px-5 text-muted-foreground sm:table-cell">
                  {app.categoryLabel}
                </TableCell>
                <TableCell className="tabular whitespace-nowrap px-5 text-right font-medium">
                  {duration(app.seconds)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

/**
 * A day with nothing on it.
 *
 * Says which day, gives the three reasons that actually cause it, and offers the way
 * out — the previous day, which is the usual answer on a demo dataset. A blank panel
 * here would send someone looking for a fault in the agent.
 */
function NoActivity({ day }: { day: DayWindow }) {
  const pathname = usePathname();
  const search = useSearchParams();

  return (
    <Panel>
      <EmptyState
        title={`No activity recorded on ${day.label}`}
        body="Nothing was collected for this day. That happens when the person was not working, when their agent was not running, or when monitoring is paused for them."
        action={
          <Link
            href={dayHref(pathname, search.toString(), day.previous)}
            className="inline-flex h-9 items-center rounded-md border border-input bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Look at the previous day
          </Link>
        }
      />
    </Panel>
  );
}

/**
 * The tab before its day has arrived.
 *
 * Exported because the route's Suspense fallback needs the identical shape — it used
 * to hold a second copy that had to be kept in step by hand, and a fallback that is a
 * near-miss of the next thing on screen is a layout shift with a pulse on it.
 */
export function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading this day</span>

      {/* The verdict block, at its real height, so the sentence lands where the bars
          were rather than pushing the figures down when it arrives. */}
      <section className="rounded-lg border bg-card p-5 shadow-[var(--shadow-sm)] sm:p-6">
        <SkeletonBar className="h-8 w-48 max-w-full" />
        <SkeletonBar className="mt-3 h-4 w-4/5 max-w-lg" />
        <div className="mt-5 flex flex-wrap gap-x-8 gap-y-3 border-t pt-4">
          <SkeletonBar className="h-4 w-24" />
          <SkeletonBar className="h-4 w-24" />
          <SkeletonBar className="h-4 w-20" />
        </div>
      </section>

      <KpiRow
        loading
        items={[
          { label: "Work time", value: "" },
          { label: "Active", value: "" },
          { label: "Idle", value: "" },
          { label: "Focused time", value: "" },
        ]}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <SectionHeading title="Work pattern" />
          <SkeletonLines count={4} />
        </Panel>
        <Panel>
          <SectionHeading title="Applications" />
          <SkeletonLines count={4} />
        </Panel>
      </div>
    </div>
  );
}
