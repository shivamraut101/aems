import type {
  ActivityEvent,
  AppUsage,
  IdleEvent,
  ProductivitySummary,
  Screenshot,
  TimelineEntry,
} from "@aems/types";

import { clamp, difference, merge, toInterval, totalSeconds, type Interval } from "./intervals.js";

export interface PeriodInput {
  profileId: string;
  periodStart: string;
  periodEnd: string;
  activity: ActivityEvent[];
  idle: IdleEvent[];
}

/**
 * Reduces a person's raw events into headline numbers for one period.
 *
 * Idle time is subtracted from active time rather than counted alongside it — an
 * idle stretch happens *while* a window is focused, so adding the two would
 * double-count those seconds and push the ratio above 1.
 */
export function summarisePeriod(input: PeriodInput): ProductivitySummary {
  const window: Interval = {
    start: Date.parse(input.periodStart),
    end: Date.parse(input.periodEnd),
  };

  const activityIntervals = clampAll(
    input.activity.map((e) => toInterval(e.started_at, e.ended_at, window.end)),
    window,
  );

  const idleIntervals = clampAll(
    input.idle.map((e) => toInterval(e.idle_start_at, e.idle_end_at, window.end)),
    window,
  );

  const idleSeconds = totalSeconds(idleIntervals);
  const activeSeconds = totalSeconds(difference(activityIntervals, idleIntervals));
  const tracked = activeSeconds + idleSeconds;

  return {
    profileId: input.profileId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    activeSeconds,
    idleSeconds,
    productivityRatio: tracked === 0 ? 0 : Number((activeSeconds / tracked).toFixed(4)),
    topApps: rankApps(input.activity, window),
  };
}

/** Per-application totals, busiest first. */
export function rankApps(activity: ActivityEvent[], window: Interval, limit = 10): AppUsage[] {
  const byApp = new Map<string, { category: string | null; intervals: Interval[] }>();

  for (const event of activity) {
    const trimmed = clamp(toInterval(event.started_at, event.ended_at, window.end), window);
    if (!trimmed) continue;

    const existing = byApp.get(event.app_name);
    if (existing) {
      existing.intervals.push(trimmed);
    } else {
      byApp.set(event.app_name, { category: event.category, intervals: [trimmed] });
    }
  }

  return [...byApp.entries()]
    .map(([appName, { category, intervals }]) => ({
      appName,
      category,
      seconds: totalSeconds(intervals),
    }))
    .filter((usage) => usage.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, limit);
}

export interface TimelineInput extends PeriodInput {
  deviceId: string;
  screenshots?: Screenshot[];
  /** Slot width. Defaults to one hour. */
  bucketSeconds?: number;
}

/** Splits a period into fixed slots for the dashboard timeline strip. */
export function buildTimeline(input: TimelineInput): TimelineEntry[] {
  const bucketMs = (input.bucketSeconds ?? 3600) * 1000;
  const windowStart = Date.parse(input.periodStart);
  const windowEnd = Date.parse(input.periodEnd);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || bucketMs <= 0) return [];

  const entries: TimelineEntry[] = [];

  for (let slotStart = windowStart; slotStart < windowEnd; slotStart += bucketMs) {
    const slot: Interval = { start: slotStart, end: Math.min(slotStart + bucketMs, windowEnd) };

    const activityIntervals = clampAll(
      input.activity.map((e) => toInterval(e.started_at, e.ended_at, slot.end)),
      slot,
    );
    const idleIntervals = clampAll(
      input.idle.map((e) => toInterval(e.idle_start_at, e.idle_end_at, slot.end)),
      slot,
    );

    const topApp = rankApps(input.activity, slot, 1)[0]?.appName ?? null;

    const shot = input.screenshots?.find((s) => {
      const at = Date.parse(s.captured_at);
      return at >= slot.start && at < slot.end;
    });

    entries.push({
      profileId: input.profileId,
      deviceId: input.deviceId,
      periodStart: new Date(slot.start).toISOString(),
      periodEnd: new Date(slot.end).toISOString(),
      activeSeconds: totalSeconds(difference(activityIntervals, idleIntervals)),
      idleSeconds: totalSeconds(idleIntervals),
      topApp,
      screenshotId: shot?.id ?? null,
    });
  }

  return entries;
}

function clampAll(intervals: Interval[], window: Interval): Interval[] {
  const trimmed: Interval[] = [];
  for (const interval of intervals) {
    const result = clamp(interval, window);
    if (result) trimmed.push(result);
  }
  return merge(trimmed);
}
