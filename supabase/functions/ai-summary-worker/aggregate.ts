/**
 * Turns raw event rows into the numbers the summary is allowed to quote.
 *
 * The rule this module exists to enforce: the AI summary must not compute time its
 * own way. `activeSeconds` and `idleSeconds` here are the same quantities
 * `summarisePeriod()` produces for the dashboard — merged, window-clamped, and with
 * idle subtracted from active rather than added alongside it. The number the model
 * quotes is the number the timeline draws.
 */

import { clamp, difference, merge, toInterval, totalSeconds, type Interval } from "./intervals.ts";

/**
 * Exactly the columns the worker may read.
 *
 * Window titles, URLs and domains identify *what was on screen*; the aggregates
 * below identify only how long. Nothing outside this list reaches a third-party
 * model, and `worker.test.ts` asserts on these two strings so widening them is a
 * deliberate, reviewed act rather than an autocomplete.
 */
export const ACTIVITY_COLUMNS = "app_name, category, started_at, ended_at";
export const IDLE_COLUMNS = "idle_start_at, idle_end_at";

export interface ActivityRow {
  app_name: string;
  category: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface IdleRow {
  idle_start_at: string;
  idle_end_at: string | null;
}

export interface UsageSlice {
  label: string;
  seconds: number;
}

export interface BreakdownSlice {
  label: string;
  percentage: number;
}

export interface PeriodFacts {
  periodStart: string;
  periodEnd: string;
  activeSeconds: number;
  idleSeconds: number;
  /** Active + idle. The same identity `summarisePeriod` uses for its ratio. */
  trackedSeconds: number;
  topApps: UsageSlice[];
  breakdown: BreakdownSlice[];
  /**
   * The complete ranked lists the two views above were cut down from.
   *
   * `combineFacts` needs them: adding up per-person top-8 lists would repeat, at
   * company scale, the very truncation defect this module was written to remove.
   * They stay out of `InsightDocument` — working state, not stored output.
   */
  apps: UsageSlice[];
  distribution: UsageSlice[];
}

export interface FactsInput {
  periodStart: string;
  periodEnd: string;
  activity: ActivityRow[];
  idle: IdleRow[];
  topAppLimit?: number;
  breakdownLimit?: number;
}

export function summariseFacts(input: FactsInput): PeriodFacts {
  const window: Interval = {
    start: Date.parse(input.periodStart),
    end: Date.parse(input.periodEnd),
  };

  const activityIntervals = clampAll(
    input.activity.map((e) => toInterval(e.started_at, e.ended_at, window.end)),
    window,
  );

  // An open idle span has a null `duration_seconds`, which is why the previous
  // implementation's `sum(duration_seconds)` silently dropped it. Treating it as
  // running to the end of the window matches how activity events are handled.
  const idleIntervals = clampAll(
    input.idle.map((e) => toInterval(e.idle_start_at, e.idle_end_at, window.end)),
    window,
  );

  const idleSeconds = totalSeconds(idleIntervals);
  const activeSeconds = totalSeconds(difference(activityIntervals, idleIntervals));

  const hasCategories = input.activity.some((e) => e.category !== null && e.category !== "");

  const apps = rankUsage(input.activity, window, "app");
  // Categorisation is item 12 and not yet wired, so every category is null today
  // and the breakdown falls back to applications. When categories arrive the
  // breakdown upgrades itself with no change here.
  const distribution = hasCategories ? rankUsage(input.activity, window, "category") : apps;

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    activeSeconds,
    idleSeconds,
    trackedSeconds: activeSeconds + idleSeconds,
    topApps: apps.slice(0, input.topAppLimit ?? 8),
    breakdown: toBreakdown(distribution, input.breakdownLimit ?? 5),
    apps,
    distribution,
  };
}

export interface CombineOptions {
  periodStart?: string;
  periodEnd?: string;
  topAppLimit?: number;
  breakdownLimit?: number;
}

/**
 * Rolls per-person facts up to a company insight.
 *
 * Addition, not interval merge. Two employees both working 09:00-11:00 is four
 * person-hours; merging their spans would report two. It is the double-counting
 * rule inverted, and getting it backwards here would make the company insight
 * disagree with the sum of the employee summaries printed beside it.
 */
export function combineFacts(parts: PeriodFacts[], options: CombineOptions = {}): PeriodFacts {
  const first = parts[0];
  const periodStart = options.periodStart ?? first?.periodStart ?? "";
  const periodEnd = options.periodEnd ?? first?.periodEnd ?? "";

  let activeSeconds = 0;
  let idleSeconds = 0;
  const apps = new Map<string, number>();
  const distribution = new Map<string, number>();

  for (const part of parts) {
    activeSeconds += part.activeSeconds;
    idleSeconds += part.idleSeconds;
    for (const slice of part.apps) apps.set(slice.label, (apps.get(slice.label) ?? 0) + slice.seconds);
    for (const slice of part.distribution) {
      distribution.set(slice.label, (distribution.get(slice.label) ?? 0) + slice.seconds);
    }
  }

  const rankedApps = rankTotals(apps);
  const rankedDistribution = rankTotals(distribution);

  return {
    periodStart,
    periodEnd,
    activeSeconds,
    idleSeconds,
    trackedSeconds: activeSeconds + idleSeconds,
    topApps: rankedApps.slice(0, options.topAppLimit ?? 8),
    breakdown: toBreakdown(rankedDistribution, options.breakdownLimit ?? 5),
    apps: rankedApps,
    distribution: rankedDistribution,
  };
}

function rankTotals(totals: Map<string, number>): UsageSlice[] {
  return [...totals.entries()]
    .map(([label, seconds]) => ({ label, seconds }))
    .filter((slice) => slice.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds || a.label.localeCompare(b.label));
}

/** Per-label totals, busiest first. Overlaps within a label are merged away. */
export function rankUsage(
  activity: ActivityRow[],
  window: Interval,
  by: "app" | "category",
): UsageSlice[] {
  const byLabel = new Map<string, Interval[]>();

  for (const event of activity) {
    const trimmed = clamp(toInterval(event.started_at, event.ended_at, window.end), window);
    if (!trimmed) continue;

    // Categorisation is not wired yet, so a null category is the common case
    // today rather than an anomaly — it gets its own honest bucket instead of
    // being folded into whichever app happened to be first.
    const label =
      by === "app" ? event.app_name : titleCase(event.category ?? "") || "Uncategorised";

    const spans = byLabel.get(label);
    if (spans) spans.push(trimmed);
    else byLabel.set(label, [trimmed]);
  }

  return [...byLabel.entries()]
    .map(([label, spans]) => ({ label, seconds: totalSeconds(spans) }))
    .filter((slice) => slice.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds || a.label.localeCompare(b.label));
}

/**
 * Converts ranked seconds into whole percentages that total 100.
 *
 * The tail is folded into "Other" rather than dropped, because a breakdown whose
 * visible slices sum to 71% invites the reader to guess what the missing 29% was.
 */
export function toBreakdown(slices: UsageSlice[], limit: number): BreakdownSlice[] {
  if (slices.length === 0 || limit < 1) return [];

  const kept: UsageSlice[] =
    slices.length <= limit
      ? slices
      : [
          ...slices.slice(0, limit - 1),
          {
            label: "Other",
            seconds: slices.slice(limit - 1).reduce((sum, slice) => sum + slice.seconds, 0),
          },
        ];

  const percentages = apportion(kept.map((slice) => slice.seconds));

  return kept
    .map((slice, index) => ({ label: slice.label, percentage: percentages[index] ?? 0 }))
    .filter((slice) => slice.percentage > 0);
}

/**
 * Largest-remainder apportionment.
 *
 * Rounding each share independently gives a column of percentages that reads as
 * 99% or 101%, which makes a correct breakdown look broken. This hands the leftover
 * points to the largest fractional remainders so the parts always total 100.
 */
export function apportion(weights: number[], total = 100): number[] {
  const sum = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0);
  if (sum <= 0) return [];

  const exact = weights.map((weight) => (Math.max(0, weight) / sum) * total);
  const floors = exact.map((value) => Math.floor(value));
  let remaining = total - floors.reduce((acc, value) => acc + value, 0);

  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const result = [...floors];
  for (const { index } of order) {
    if (remaining <= 0) break;
    result[index] = (result[index] ?? 0) + 1;
    remaining -= 1;
  }

  return result;
}

function clampAll(intervals: Interval[], window: Interval): Interval[] {
  const trimmed: Interval[] = [];
  for (const interval of intervals) {
    const result = clamp(interval, window);
    if (result) trimmed.push(result);
  }
  return merge(trimmed);
}

function titleCase(value: string): string {
  if (value.length === 0) return "";
  return value
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
