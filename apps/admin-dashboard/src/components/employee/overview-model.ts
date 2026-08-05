/**
 * View models for the Overview tab — scope §4.4's "Today" block.
 *
 * Every figure here is a duration. `docs/design.md` calls a bare productivity
 * percentage invasive and asks for descriptive work patterns instead, so the fourth
 * tile is "Focused time 1h 30m" rather than "86%". `activityRatio` still exists on the
 * payload; it belongs in a tooltip, not in a tile.
 */

import type { DayTimeline } from "@aems/types";

import { duration, timeOfDay } from "@/lib/format";

import { categoryLabel, type WorkPattern } from "./work-pattern";

/** Structurally the `Kpi` that `components/kpi-row.tsx` renders, without importing React. */
export interface OverviewKpi {
  label: string;
  value: string;
  hint?: string;
}

export interface DaySummary {
  /** First clock-in of the day. */
  clockInAt: string | null;
  /** Last clock-out. Null while a session is still open. */
  clockOutAt: string | null;
  /** A session opened and has not closed — the person is still on the clock. */
  openSession: boolean;
  screenshotCount: number;
}

export function summariseDay(timeline: DayTimeline): DaySummary {
  let clockInAt: string | null = null;
  let clockOutAt: string | null = null;
  let screenshotCount = 0;

  // Markers arrive sorted by instant, so first-seen is earliest and last-seen latest.
  for (const marker of timeline.markers) {
    if (marker.kind === "clock-in" && clockInAt === null) clockInAt = marker.at;
    else if (marker.kind === "clock-out") clockOutAt = marker.at;
    else if (marker.kind === "screenshot") screenshotCount += 1;
  }

  return {
    clockInAt,
    clockOutAt,
    // An open session is a fact worth stating. Reporting the last clock-out of a day
    // that has not ended would read as "went home", which may be untrue.
    openSession: clockInAt !== null && (clockOutAt === null || clockOutAt < clockInAt),
    screenshotCount,
  };
}

export function buildOverviewKpis(timeline: DayTimeline, pattern: WorkPattern): OverviewKpi[] {
  const { trackedSeconds, activeSeconds, idleSeconds, breakSeconds } = timeline.totals;
  const day = summariseDay(timeline);
  const focus = pattern.rows.find((row) => row.key === "focus");

  return [
    {
      label: "Work time",
      value: duration(trackedSeconds),
      hint: day.clockInAt ? `Started ${timeOfDay(day.clockInAt)}` : "No session recorded",
    },
    {
      label: "Active",
      value: duration(activeSeconds),
      ...(trackedSeconds > 0 ? { hint: `of ${duration(trackedSeconds)} tracked` } : {}),
    },
    {
      label: "Idle",
      value: duration(idleSeconds),
      ...(breakSeconds > 0 ? { hint: `${duration(breakSeconds)} break` } : {}),
    },
    {
      label: "Focused time",
      value: duration(focus?.seconds ?? 0),
      // Names the work rather than scoring it — the whole point of the block below.
      ...(focus?.detail ? { hint: focus.detail } : {}),
    },
  ];
}

export interface AppUsageView {
  appName: string;
  categoryLabel: string;
  seconds: number;
  /** Share of active time, 0..1. Zero when nothing was active — never NaN. */
  share: number;
}

/**
 * The busiest applications, ready to render.
 *
 * Order comes from the API, which sums whole intervals rather than the slot lists —
 * so an application that ran all day without topping a single slot still appears.
 */
export function topApplications(timeline: DayTimeline, limit = 5): AppUsageView[] {
  const active = timeline.totals.activeSeconds;

  return timeline.topApps.slice(0, limit).map((usage) => ({
    appName: usage.appName,
    categoryLabel: categoryLabel(usage.category),
    seconds: usage.seconds,
    share: active > 0 ? Math.min(1, usage.seconds / active) : 0,
  }));
}
