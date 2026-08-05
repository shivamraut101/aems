/**
 * Interval algebra, ported line-for-line from `packages/analytics/src/intervals.ts`.
 *
 * Why a copy rather than an import: Edge Functions run under Deno and are deployed
 * from `supabase/functions` alone — the CLI does not upload files outside that
 * directory, and Deno cannot resolve the bare specifier `@aems/analytics` or the
 * Node-style `./intervals.js` suffix the package uses. The alternative to a copy is
 * the report worker's approach, which reimplemented `merge` by hand and quietly
 * dropped `difference` and `clamp` — that is how the AI summary came to disagree
 * with every other surface in the first place.
 *
 * The copy is pinned by test: `worker.test.ts` re-runs the canonical cases from
 * `packages/analytics/src/productivity.test.ts` against this file, so a drift in
 * either direction fails a build rather than producing a plausible wrong number.
 */

/** Half-open time interval [start, end) in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

export function toInterval(
  startedAt: string,
  endedAt: string | null,
  fallbackEnd: number,
): Interval {
  const start = Date.parse(startedAt);
  const end = endedAt === null ? fallbackEnd : Date.parse(endedAt);
  return { start, end };
}

/** Trims an interval to a window. Returns null when they do not overlap. */
export function clamp(interval: Interval, window: Interval): Interval | null {
  const start = Math.max(interval.start, window.start);
  const end = Math.min(interval.end, window.end);
  return end > start ? { start, end } : null;
}

/**
 * Collapses overlapping intervals into disjoint ones.
 *
 * Necessary before summing durations: a person with a laptop and a phone reporting
 * at the same time produces overlapping activity, and naive addition would credit
 * them with more seconds than the clock contains.
 */
export function merge(intervals: Interval[]): Interval[] {
  const valid = intervals.filter(
    (i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start,
  );
  if (valid.length === 0) return [];

  const sorted = [...valid].sort((a, b) => a.start - b.start);
  const first = sorted[0];
  if (!first) return [];

  const merged: Interval[] = [{ ...first }];

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (!current || !last) continue;

    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

export function totalSeconds(intervals: Interval[]): number {
  return Math.round(merge(intervals).reduce((sum, i) => sum + (i.end - i.start), 0) / 1000);
}

/**
 * Removes `subtract` from `base`.
 *
 * Used to keep idle time from being counted as active: an idle stretch sits inside
 * whatever window was focused at the time, so the two would otherwise overlap.
 */
export function difference(base: Interval[], subtract: Interval[]): Interval[] {
  const holes = merge(subtract);
  let result = merge(base);

  for (const hole of holes) {
    const next: Interval[] = [];
    for (const piece of result) {
      if (hole.end <= piece.start || hole.start >= piece.end) {
        next.push(piece);
        continue;
      }
      if (hole.start > piece.start) next.push({ start: piece.start, end: hole.start });
      if (hole.end < piece.end) next.push({ start: hole.end, end: piece.end });
    }
    result = next;
  }

  return result;
}
