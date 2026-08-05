/**
 * The Work Pattern block — docs/design.md's replacement for a productivity score.
 *
 * `docs/design.md` is explicit that a bare percentage beside somebody's name reads as
 * invasive, and that "Focused time 7h 20m" reads as insight. That is not a copy
 * change: it needs a real split of the day by what the work *was*, which only became
 * computable once the categorisation rules landed.
 *
 * Two sources, deliberately used for different things:
 *
 * - **`totals` is the arithmetic.** Union-then-subtract over the raw intervals. Every
 *   number a manager reads as fact comes from here, so this block and the KPI row
 *   above it can never disagree.
 * - **`spans` is the evidence for the split.** It is the repaired picture — flooded,
 *   merged, clustered — so its own total can sit a few seconds away from the
 *   arithmetic. The proportions are taken from it and then laid onto the arithmetic
 *   total, which is why the rows always add up to exactly `trackedSeconds`.
 */

import type { DayTimeline, TimelineSpan } from "@aems/types";

/** Buckets that partition *active* time. Idle and break come from the totals. */
export type ActiveBucket = "focus" | "collaboration" | "other" | "uncategorized";

export type WorkPatternKey = ActiveBucket | "break" | "idle";

export interface WorkPatternRow {
  key: WorkPatternKey;
  label: string;
  seconds: number;
  /** Share of tracked time, 0..1. Drives the bar width; never rendered as a score. */
  share: number;
  /** The categories behind the bucket, busiest first. Null for idle and break. */
  detail: string | null;
}

export interface WorkPattern {
  rows: WorkPatternRow[];
  trackedSeconds: number;
  activeSeconds: number;
  /**
   * Active time was recorded but no rule claimed any of it.
   *
   * Surfaced so the block can explain itself. On day one of a deployment every event
   * is Uncategorized, and "Focused time 0m" with no explanation reads as a broken
   * screen rather than as a missing rule set.
   */
  unclassified: boolean;
}

const LABEL: Record<WorkPatternKey, string> = {
  focus: "Focused time",
  collaboration: "Collaboration",
  other: "Other activity",
  uncategorized: "Uncategorised",
  break: "Break",
  idle: "Idle",
};

/**
 * Category leaves that mean "working with other people".
 *
 * Matched on the leaf rather than the whole path so a company that reorganises its
 * tree — `Work > Internal > Communication` — keeps the same Collaboration line.
 */
const COLLABORATION_LEAVES = new Set([
  "communication",
  "collaboration",
  "meeting",
  "meetings",
  "email",
]);

/** The root the seeded taxonomy puts deep work under. */
const WORK_ROOT = "work";

/** What the rule engine writes when nothing claimed an event. */
const UNCATEGORIZED = "uncategorized";

const EMPTY_SPLIT: Record<ActiveBucket, number> = {
  focus: 0,
  collaboration: 0,
  other: 0,
  uncategorized: 0,
};

/** Splits a stored `"Work > Development"` into its segments. */
function segments(category: string | null | undefined): string[] {
  if (!category) return [];
  return category
    .split(">")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Which line of the block a category belongs on.
 *
 * Unmatched activity is `uncategorized`, never `focus`: crediting work we cannot
 * name as focused work would inflate the one number a manager is most likely to
 * quote back to an employee.
 */
export function bucketForCategory(category: string | null | undefined): ActiveBucket {
  const path = segments(category);
  if (path.length === 0) return "uncategorized";

  const root = path[0]!.toLowerCase();
  const leaf = path[path.length - 1]!.toLowerCase();

  if (root === UNCATEGORIZED) return "uncategorized";
  if (COLLABORATION_LEAVES.has(leaf)) return "collaboration";
  if (root === WORK_ROOT) return "focus";
  return "other";
}

/** The name to show for a category — the leaf, which is what distinguishes it. */
export function categoryLabel(category: string | null | undefined): string {
  const path = segments(category);
  return path[path.length - 1] ?? "Uncategorized";
}

/**
 * Splits `total` across `weights`, keeping the sum exact.
 *
 * Largest-remainder rather than round-per-part: rounding each share independently
 * leaves the rows adding up to one or two seconds more or less than the KPI row
 * beside them, and "the numbers do not add up" is the single fastest way to lose a
 * demo audience.
 */
export function allocate(weights: readonly number[], total: number): number[] {
  const safe = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const sum = safe.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return safe.map(() => 0);

  const exact = safe.map((weight) => (weight * total) / sum);
  const parts = exact.map((value) => Math.floor(value));
  let remainder = total - parts.reduce((a, b) => a + b, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const { index } of order) {
    if (remainder <= 0) break;
    parts[index] = (parts[index] ?? 0) + 1;
    remainder -= 1;
  }

  return parts;
}

interface CategorySplit {
  buckets: Record<ActiveBucket, number>;
  /** Seconds per category leaf, so a bucket can name what is inside it. */
  byCategory: Map<ActiveBucket, Map<string, number>>;
}

function emptySplit(): CategorySplit {
  return { buckets: { ...EMPTY_SPLIT }, byCategory: new Map() };
}

function add(split: CategorySplit, category: string | null, seconds: number): void {
  if (seconds <= 0) return;

  const bucket = bucketForCategory(category);
  split.buckets[bucket] += seconds;

  const leaves = split.byCategory.get(bucket) ?? new Map<string, number>();
  const label = categoryLabel(category);
  leaves.set(label, (leaves.get(label) ?? 0) + seconds);
  split.byCategory.set(bucket, leaves);
}

/**
 * Active seconds per bucket, taken from the reduced span stream.
 *
 * A switching cluster carries no single category — it is a run of sub-minute focus
 * changes folded into one mark. Its full duration is spread over the categories of
 * the applications named inside it, in proportion: `topApps` is capped for
 * legibility, so using its raw seconds would quietly drop the tail of a busy minute.
 */
export function splitActiveByCategory(
  spans: readonly TimelineSpan[],
): Record<ActiveBucket, number> {
  return splitDetailed(spans).buckets;
}

function splitDetailed(spans: readonly TimelineSpan[]): CategorySplit {
  const split = emptySplit();

  for (const span of spans) {
    if (span.seconds <= 0) continue;

    if (span.kind === "app") {
      add(split, span.category, span.seconds);
      continue;
    }

    if (span.kind !== "switching") continue;

    const shares = allocate(
      span.topApps.map((usage) => usage.seconds),
      span.seconds,
    );

    if (shares.length === 0 || shares.every((value) => value === 0)) {
      add(split, null, span.seconds);
      continue;
    }

    span.topApps.forEach((usage, index) => add(split, usage.category, shares[index] ?? 0));
  }

  return split;
}

/** Busiest categories inside a bucket, as one readable line. */
function detailFor(split: CategorySplit, bucket: ActiveBucket, limit = 3): string | null {
  const leaves = split.byCategory.get(bucket);
  if (!leaves || leaves.size === 0) return null;

  const names = [...leaves.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label]) => label);

  return names.length > 0 ? names.join(", ") : null;
}

const ACTIVE_ORDER: ActiveBucket[] = ["focus", "collaboration", "other", "uncategorized"];

/** Lines docs/design.md names explicitly. They stay on screen at zero. */
const ALWAYS_SHOWN = new Set<WorkPatternKey>(["focus", "collaboration", "idle"]);

export function buildWorkPattern(timeline: DayTimeline): WorkPattern {
  const { activeSeconds, idleSeconds, breakSeconds, trackedSeconds } = timeline.totals;

  const split = splitDetailed(timeline.spans);
  const weights = ACTIVE_ORDER.map((bucket) => split.buckets[bucket]);
  const allocated = allocate(weights, activeSeconds);

  const seconds: Record<ActiveBucket, number> = { ...EMPTY_SPLIT };
  ACTIVE_ORDER.forEach((bucket, index) => {
    seconds[bucket] = allocated[index] ?? 0;
  });

  // Totals without spans to weigh by — a truncated response, or an agent whose focus
  // events did not survive. The seconds are still real, so they are held as
  // uncategorised rather than dropped, which would put this block out of step with
  // the KPI row above it.
  const attributed = ACTIVE_ORDER.reduce((sum, bucket) => sum + seconds[bucket], 0);
  if (attributed < activeSeconds) seconds.uncategorized += activeSeconds - attributed;

  const rows: WorkPatternRow[] = [
    ...ACTIVE_ORDER.map((bucket) => ({
      key: bucket as WorkPatternKey,
      label: LABEL[bucket],
      seconds: seconds[bucket],
      share: trackedSeconds > 0 ? seconds[bucket] / trackedSeconds : 0,
      detail: detailFor(split, bucket),
    })),
    {
      key: "break" as const,
      label: LABEL.break,
      seconds: breakSeconds,
      share: trackedSeconds > 0 ? breakSeconds / trackedSeconds : 0,
      detail: null,
    },
    {
      key: "idle" as const,
      label: LABEL.idle,
      seconds: idleSeconds,
      share: trackedSeconds > 0 ? idleSeconds / trackedSeconds : 0,
      detail: null,
    },
  ];

  return {
    rows: rows.filter((row) => ALWAYS_SHOWN.has(row.key) || row.seconds > 0),
    trackedSeconds,
    activeSeconds,
    unclassified: activeSeconds > 0 && seconds.focus === 0 && seconds.collaboration === 0,
  };
}
