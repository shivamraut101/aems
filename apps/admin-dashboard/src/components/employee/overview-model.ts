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

import { categoryLabel, type WorkPattern, type WorkPatternRow } from "./work-pattern";

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

/**
 * What this day amounts to, said before any figure is read.
 *
 * The tab used to open with four equal tiles and leave the reader to work out from
 * them whether the day was an ordinary one. That is arithmetic the screen can do
 * itself — the Overview page already reached the same conclusion for the company, in
 * `lib/verdict.ts`, and this is the same move for one person. Pure for the same
 * reason it is there: a wrong sentence about somebody's day is worse than no
 * sentence, and that deserves tests rather than a screenshot.
 *
 * It states what the time *was*, never how good it was. `docs/design.md` rules out a
 * bare productivity score, and a sentence is a much easier place to smuggle one back
 * in than a tile is.
 */
export interface DayVerdict {
  /** The one figure the day is measured in. */
  headline: string;
  /**
   * Whether the person is still on the clock. Null when no session was recorded at
   * all — an absent day is not a state worth drawing a pill for.
   */
  state: "working" | "finished" | null;
  /** Written for a reader: what the tracked time actually consisted of. */
  sentence: string;
}

export function describeDay(timeline: DayTimeline, pattern: WorkPattern): DayVerdict {
  const { trackedSeconds, activeSeconds, idleSeconds } = timeline.totals;
  const day = summariseDay(timeline);

  return {
    headline: `${duration(trackedSeconds)} tracked`,
    state: day.openSession ? "working" : day.clockOutAt ? "finished" : null,
    sentence: [activeClause(pattern, activeSeconds, trackedSeconds), idleClause(idleSeconds, activeSeconds)]
      .filter((clause): clause is string => clause !== null)
      .join(" "),
  };
}

/** Where the active time went, named by the work behind it rather than scored. */
function activeClause(pattern: WorkPattern, activeSeconds: number, trackedSeconds: number): string {
  if (activeSeconds <= 0) {
    return trackedSeconds > 0
      ? "Time was tracked but none of it was recorded as active."
      : "No work session was recorded for this day.";
  }

  // Idle and break are the only rows that are not active time; every other row is a
  // bucket of it, so the busiest of them is what the day was actually spent on.
  const lead = pattern.rows
    .filter((row) => row.key !== "idle" && row.key !== "break")
    .reduce<WorkPatternRow | null>(
      (best, row) => (best !== null && best.seconds >= row.seconds ? best : row),
      null,
    );

  if (lead === null || lead.seconds <= 0) {
    return `${duration(activeSeconds)} was active, but none of it could be attributed to a category.`;
  }

  // Named separately from the others: "went to Uncategorized" reads as a place the
  // time went, when it is really an admission that we cannot say where it went.
  if (lead.key === "uncategorized") {
    return `${duration(lead.seconds)} of the active time has not matched a category rule yet, so it cannot be described as focused work.`;
  }

  return `${duration(lead.seconds)} of the active time went to ${lead.detail ?? lead.label.toLowerCase()}.`;
}

/**
 * Idle, mentioned only when it outweighed the work.
 *
 * The figure is on a tile directly below either way. Repeating it up here for every
 * twenty-minute lunch is how the sentence at the top of a page teaches its reader to
 * skip the sentence at the top of a page.
 */
function idleClause(idleSeconds: number, activeSeconds: number): string | null {
  if (idleSeconds <= 0 || idleSeconds <= activeSeconds) return null;
  return `More of the day was idle (${duration(idleSeconds)}) than active (${duration(activeSeconds)}).`;
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
