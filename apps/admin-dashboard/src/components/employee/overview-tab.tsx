"use client";

import { Camera, LogIn, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { KpiRow } from "@/components/kpi-row";
import { describeError } from "@/lib/api";
import { duration, timeOfDay } from "@/lib/format";
import { useEmployeeDay } from "@/lib/queries/employee";

import type { DayWindow } from "./day-window";
import { buildOverviewKpis, summariseDay, topApplications } from "./overview-model";
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

      <KpiRow items={buildOverviewKpis(data, pattern)} />

      <DayMoments summary={summary} />

      <div className="grid gap-6 lg:grid-cols-2">
        <WorkPatternBlock pattern={pattern} />
        <TopApplications
          apps={apps}
          appsHref={
            appsHref === undefined ? `/people/${encodeURIComponent(profileId)}/apps` : appsHref
          }
        />
      </div>
    </div>
  );
}

/**
 * Clock-in, clock-out and captures as one line.
 *
 * Scope §2.2 asks for "Work Started: 09:05 AM" literally, and until this the numbers
 * had no anchor in the day — eight hours tracked says nothing about whether they were
 * this morning or overnight.
 */
function DayMoments({ summary }: { summary: ReturnType<typeof summariseDay> }) {
  if (!summary.clockInAt && summary.screenshotCount === 0) return null;

  return (
    <dl className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-lg border bg-card px-4 py-3 text-sm">
      {summary.clockInAt ? (
        <div className="flex items-center gap-2">
          <dt className="flex items-center gap-1.5 text-muted-foreground">
            <LogIn className="h-3.5 w-3.5" aria-hidden />
            Started
          </dt>
          <dd className="tabular font-medium">{timeOfDay(summary.clockInAt)}</dd>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <dt className="flex items-center gap-1.5 text-muted-foreground">
          <LogOut className="h-3.5 w-3.5" aria-hidden />
          Finished
        </dt>
        <dd className="tabular font-medium">
          {summary.openSession
            ? "Still working"
            : summary.clockOutAt
              ? timeOfDay(summary.clockOutAt)
              : "—"}
        </dd>
      </div>

      <div className="flex items-center gap-2">
        <dt className="flex items-center gap-1.5 text-muted-foreground">
          <Camera className="h-3.5 w-3.5" aria-hidden />
          Captures
        </dt>
        <dd className="tabular font-medium">{summary.screenshotCount}</dd>
      </div>
    </dl>
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
  appsHref,
}: {
  apps: ReturnType<typeof topApplications>;
  appsHref: string | null;
}) {
  return (
    <Panel className="p-0">
      <div className="p-5 pb-0">
        <SectionHeading
          title="Applications"
          hint="Busiest first, over the tracked day."
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Applications used, longest first</caption>
            <thead>
              <tr className="border-y text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-5 py-2 font-medium">
                  Application
                </th>
                <th scope="col" className="hidden px-5 py-2 font-medium sm:table-cell">
                  Category
                </th>
                <th scope="col" className="px-5 py-2 text-right font-medium">
                  Time
                </th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr key={app.appName} className="border-b last:border-0">
                  <td className="px-5 py-2.5">
                    <span className="font-medium">{app.appName}</span>
                    {/* The share is a bar under the name rather than a number in its
                        own column: the ranking is the point, the percentage is not. */}
                    <span
                      aria-hidden
                      className="mt-1.5 block h-1 rounded-full bg-success/55"
                      style={{ width: `${Math.max(2, app.share * 100)}%` }}
                    />
                  </td>
                  <td className="hidden px-5 py-2.5 text-muted-foreground sm:table-cell">
                    {app.categoryLabel}
                  </td>
                  <td className="tabular px-5 py-2.5 text-right font-medium">
                    {duration(app.seconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading this day</span>
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
