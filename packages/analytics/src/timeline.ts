/**
 * Server-side reduction for the employee day view.
 *
 * The browser must never be handed a raw event stream. An eight-hour day is a few
 * thousand focus intervals, and the agent force-closes any interval at five minutes —
 * so a two-hour VS Code session arrives as ~24 rows and renders as 24 seams inside one
 * continuous stretch. That is an artefact of an agent decision, not something that
 * happened to the employee, and repairing it in every consumer would mean repairing it
 * three times and getting three answers.
 *
 * Two outputs, deliberately separate:
 *
 * - **`slots` and `totals` are the arithmetic.** Built from the raw intervals with the
 *   same union-then-subtract algebra `summarisePeriod` uses, so the timeline and the
 *   KPI row can never disagree. No repair pass touches these numbers.
 * - **`spans` is the picture.** Flooded, merged and clustered so the ribbon reads as
 *   the shape of a day rather than as sampling noise.
 *
 * Keeping them apart is the point: healing a 3-second hairline is a rendering decision,
 * and letting a rendering decision add seconds to a number a manager reads as fact is
 * the kind of wrongness this product cannot afford.
 */

import type {
  ActivityEvent,
  AppUsage,
  BreakEvent,
  DayTimeline,
  IdleEvent,
  TimelineMarker,
  TimelineMarkerKind,
  TimelineScreenshot,
  TimelineSlot,
  TimelineSpan,
  WorkSession,
} from "@aems/types";

import type { Productivity } from "./categorize.js";

import { clamp, difference, merge, toInterval, totalSeconds, type Interval } from "./intervals.js";

/**
 * Holes smaller than this are sampling jitter, not idleness.
 *
 * Matches the agent's own tick: a hole narrower than one poll cannot represent a real
 * change of state, only the boundary between two polls.
 */
export const DEFAULT_PULSE_SECONDS = 5;

/** Below this a span is a switch, not a piece of work worth naming on its own. */
export const DEFAULT_CLUSTER_SECONDS = 60;

/** The grid the ribbon, the screenshot review and the app list all key on. */
export const DEFAULT_SLOT_SECONDS = 600;

/**
 * The only widths callers may pick.
 *
 * Three views line up because there is one grid, not three. A free-form width lets a
 * caller request a grid nothing else shares, and the views silently stop agreeing.
 */
export const SLOT_SECONDS_OPTIONS = [60, 300, 600, 1800, 3600] as const;

export type SlotSeconds = (typeof SLOT_SECONDS_OPTIONS)[number];

/** Overlaps this small are float noise from two clocks, not a real conflict. */
const OVERLAP_TOLERANCE_MS = 100;

/** Apps named on one span or in one slot. Beyond this the label stops being readable. */
const TOP_APPS_LIMIT = 3;

/** A focus interval carrying the identity it is grouped by. */
export interface KeyedSpan {
  start: number;
  end: number;
  /** Grouping identity. `mergeAdjacent` joins neighbours that share it. */
  key: string;
  appName: string;
  windowTitle: string | null;
  category: string | null;
}

/** A span after reduction — either one application, or a run of rapid switching. */
export interface ReducedSpan {
  start: number;
  end: number;
  kind: "app" | "switching";
  /** Null on a switching cluster: no single application owns it. */
  appName: string | null;
  windowTitle: string | null;
  category: string | null;
  /** Seconds covered. Less than `end - start` only for a switching cluster. */
  seconds: number;
  appCount: number;
  topApps: AppUsage[];
}

/** Per-application time, used to rank apps inside a slot. */
export interface AppInterval {
  start: number;
  end: number;
  appName: string;
  category: string | null;
}

export interface DayGridInput {
  windowStart: number;
  windowEnd: number;
  slotSeconds: number;
  /** Merged, disjoint, already free of idle and break time. */
  active: Interval[];
  /** Merged, disjoint. */
  idle: Interval[];
  /** Merged, disjoint, already free of idle time. */
  breaks: Interval[];
  /** Per-app intervals. Disjoint within an application; may overlap across them. */
  apps: AppInterval[];
  screenshots?: readonly TimelineScreenshot[];
}

/**
 * The columns of each row the reduction actually reads.
 *
 * Narrower than the table types so a route can `select` five columns instead of `*`.
 * A full row is still assignable, so callers holding one do not have to map first.
 */
export type ActivityRow = Pick<
  ActivityEvent,
  "app_name" | "window_title" | "category" | "started_at" | "ended_at"
>;
export type IdleRow = Pick<IdleEvent, "idle_start_at" | "idle_end_at">;
export type BreakRow = Pick<BreakEvent, "break_start_at" | "break_end_at">;
export type SessionRow = Pick<WorkSession, "clock_in_at" | "clock_out_at">;

export interface DayTimelineInput {
  profileId: string;
  periodStart: string;
  periodEnd: string;
  slotSeconds?: number;
  pulseSeconds?: number;
  clusterSeconds?: number;
  activity: readonly ActivityRow[];
  idle: readonly IdleRow[];
  breaks?: readonly BreakRow[];
  sessions?: readonly SessionRow[];
  /** Already resolved and signed by the route — analytics never touches Storage. */
  screenshots?: readonly TimelineScreenshot[];
  /**
   * Maps a stored category to its productivity, so active time can be split three ways.
   *
   * Injected rather than imported: the rule set is per company and lives in the
   * database, and analytics must stay a pure function of what it is handed. Omitted,
   * every worked second reports as neutral — which is the honest answer for a caller
   * that has not supplied any rules, not a silent zero.
   */
  productivityOf?: (category: string | null) => Productivity;
  /** True when a row cap was hit upstream, so every number here is a floor. */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Reduction
// ---------------------------------------------------------------------------

/** Chronological order, longest-first on a tie so containment is seen before its filler. */
export function sortSpans(spans: readonly KeyedSpan[]): KeyedSpan[] {
  return spans
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => ({ ...s }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Closes holes narrower than one poll, and flattens overlaps into a disjoint stream.
 *
 * Same-identity neighbours across a sub-pulse hole are one interval that the sampler
 * happened to observe twice. Different-identity neighbours each extend to the
 * **midpoint** of the hole: the hole is an interval of uncertainty, and splitting it
 * evenly is the only rule that does not systematically favour the longer neighbour.
 *
 * Overlaps cannot be left alone — two windows cannot both be focused, and a ribbon
 * built from overlapping rectangles paints one over the other. The newer report wins,
 * and an earlier span that outlives the newer one keeps its tail rather than being
 * truncated to nothing.
 */
export function floodGaps(
  spans: readonly KeyedSpan[],
  pulseSeconds: number = DEFAULT_PULSE_SECONDS,
): KeyedSpan[] {
  const pulseMs = Math.max(0, pulseSeconds) * 1000;
  const queue = sortSpans(spans);
  if (queue.length < 2) return queue;

  const out: KeyedSpan[] = [];
  let current = queue[0]!;

  for (let i = 1; i < queue.length; i += 1) {
    const next = queue[i]!;
    const gap = next.start - current.end;

    if (gap < 0) {
      if (-gap <= OVERLAP_TOLERANCE_MS) {
        next.start = current.end;
      } else if (next.key === current.key) {
        current.end = Math.max(current.end, next.end);
        current.windowTitle = agreedTitle(current, next);
        continue;
      } else {
        // The older span may outlive the newer one; that remainder is still evidence,
        // so it goes back into the queue rather than being thrown away.
        if (current.end > next.end) {
          insertSorted(queue, { ...current, start: next.end }, i + 1);
        }
        current.end = next.start;
      }
    } else if (gap > 0 && gap <= pulseMs) {
      if (next.key === current.key) {
        current.end = Math.max(current.end, next.end);
        current.windowTitle = agreedTitle(current, next);
        continue;
      }
      const midpoint = current.end + Math.floor(gap / 2);
      current.end = midpoint;
      next.start = midpoint;
    }

    if (current.end > current.start) out.push(current);
    current = next;
  }

  if (current.end > current.start) out.push(current);
  return out;
}

/**
 * Rejoins neighbours that share an identity.
 *
 * This is what undoes the agent's five-minute interval ceiling. Without it the ribbon
 * shows two dozen seams inside one uninterrupted session — a rendering artefact
 * created entirely by a collection decision.
 */
export function mergeAdjacent(spans: readonly KeyedSpan[]): KeyedSpan[] {
  const out: KeyedSpan[] = [];

  for (const span of sortSpans(spans)) {
    const last = out[out.length - 1];
    if (last && last.key === span.key && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      last.windowTitle = agreedTitle(last, span);
      continue;
    }
    out.push(span);
  }

  return out;
}

/** Removes `holes` from `spans`, splitting a span that straddles one. */
export function subtractSpans(spans: readonly KeyedSpan[], holes: readonly Interval[]): KeyedSpan[] {
  const merged = merge([...holes]);
  if (merged.length === 0) return sortSpans(spans);

  const out: KeyedSpan[] = [];

  for (const span of sortSpans(spans)) {
    let pieces: Interval[] = [{ start: span.start, end: span.end }];

    for (const hole of merged) {
      if (hole.end <= span.start) continue;
      if (hole.start >= span.end) break;
      pieces = difference(pieces, [hole]);
    }

    for (const piece of pieces) out.push({ ...span, start: piece.start, end: piece.end });
  }

  return out;
}

/** Widens each span into the reduced shape, one application per span. */
export function toReducedSpans(spans: readonly KeyedSpan[]): ReducedSpan[] {
  return spans.map((span) => {
    const seconds = Math.round((span.end - span.start) / 1000);
    return {
      start: span.start,
      end: span.end,
      kind: "app" as const,
      appName: span.appName,
      windowTitle: span.windowTitle,
      category: span.category,
      seconds,
      appCount: 1,
      topApps: [{ appName: span.appName, category: span.category, seconds }],
    };
  });
}

/**
 * Folds a run of sub-minute spans into one "rapid switching" span.
 *
 * ActivityWatch drops short events outright. We must not: those seconds are tracked
 * working time, and discarding them makes the ribbon disagree with the KPI row that
 * sits above it. The cluster keeps the full duration of everything inside it and says
 * how many applications it covers — absorb, never discard.
 *
 * A *lone* short span is left alone. Folding it into a neighbour would credit its
 * seconds to an application that was not focused, and one short mark is legible on its
 * own; it is a run of them that is not.
 */
export function clusterShort(
  spans: readonly ReducedSpan[],
  minSeconds: number = DEFAULT_CLUSTER_SECONDS,
): ReducedSpan[] {
  const out: ReducedSpan[] = [];
  let i = 0;

  while (i < spans.length) {
    const span = spans[i]!;

    if (!isClusterable(span, minSeconds)) {
      out.push(span);
      i += 1;
      continue;
    }

    let end = i;
    while (end < spans.length && isClusterable(spans[end]!, minSeconds)) end += 1;

    if (end - i < 2) {
      out.push(span);
      i += 1;
      continue;
    }

    out.push(makeCluster(spans.slice(i, end)));
    i = end;
  }

  return out;
}

function isClusterable(span: ReducedSpan, minSeconds: number): boolean {
  return span.kind === "app" && span.seconds < minSeconds;
}

function makeCluster(run: readonly ReducedSpan[]): ReducedSpan {
  const first = run[0]!;
  const last = run[run.length - 1]!;
  const byApp = new Map<string, { category: string | null; seconds: number }>();

  for (const span of run) {
    for (const usage of span.topApps) {
      const existing = byApp.get(usage.appName);
      if (existing) existing.seconds += usage.seconds;
      else byApp.set(usage.appName, { category: usage.category, seconds: usage.seconds });
    }
  }

  const topApps = [...byApp.entries()]
    .map(([appName, { category, seconds }]) => ({ appName, category, seconds }))
    .sort((a, b) => b.seconds - a.seconds || a.appName.localeCompare(b.appName));

  return {
    start: first.start,
    end: last.end,
    kind: "switching",
    appName: null,
    windowTitle: null,
    category: null,
    seconds: run.reduce((sum, span) => sum + span.seconds, 0),
    appCount: byApp.size,
    topApps: topApps.slice(0, TOP_APPS_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/**
 * Cuts the window into fixed slots.
 *
 * Slots are anchored to wall-clock multiples of `slotSeconds`, never to whatever `from`
 * the caller passed. A manager asking for 09:05–09:25 still gets the 09:10 and 09:20
 * boundaries the screenshot review uses, which is the entire reason the grid is shared.
 *
 * One pass per input list with a moving cursor rather than a rescan per slot: the
 * previous implementation re-clamped every event and re-ranked every application inside
 * the slot loop, so asking for one-minute slots cost sixty times an hourly grid for the
 * same day.
 */
export function dayGrid(input: DayGridInput): TimelineSlot[] {
  const { windowStart, windowEnd } = input;
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) return [];
  if (windowEnd <= windowStart) return [];

  const slotMs = Math.max(1000, Math.round(input.slotSeconds * 1000));
  const active = merge([...input.active]);
  const idle = merge([...input.idle]);
  const breaks = merge([...input.breaks]);
  const apps = [...input.apps].sort((a, b) => a.start - b.start || a.end - b.end);
  const shots = [...(input.screenshots ?? [])]
    .map((shot) => ({ at: Date.parse(shot.capturedAt), shot }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at);

  const cursor = { active: 0, idle: 0, breaks: 0, apps: 0, shots: 0 };
  const slots: TimelineSlot[] = [];

  for (
    let anchor = Math.floor(windowStart / slotMs) * slotMs;
    anchor < windowEnd;
    anchor += slotMs
  ) {
    const start = Math.max(anchor, windowStart);
    const end = Math.min(anchor + slotMs, windowEnd);
    if (end <= start) continue;

    cursor.active = advance(active, cursor.active, start);
    cursor.idle = advance(idle, cursor.idle, start);
    cursor.breaks = advance(breaks, cursor.breaks, start);
    cursor.apps = advance(apps, cursor.apps, start);
    while (cursor.shots < shots.length && shots[cursor.shots]!.at < start) cursor.shots += 1;

    const slotSecondsTotal = Math.round((end - start) / 1000);
    const activeSeconds = overlapSeconds(active, cursor.active, start, end);
    const idleSeconds = overlapSeconds(idle, cursor.idle, start, end);
    const breakSeconds = overlapSeconds(breaks, cursor.breaks, start, end);
    const tracked = activeSeconds + idleSeconds + breakSeconds;

    const byApp = new Map<string, { category: string | null; ms: number }>();
    for (let i = cursor.apps; i < apps.length && apps[i]!.start < end; i += 1) {
      const app = apps[i]!;
      const covered = Math.min(app.end, end) - Math.max(app.start, start);
      if (covered <= 0) continue;
      const existing = byApp.get(app.appName);
      if (existing) existing.ms += covered;
      else byApp.set(app.appName, { category: app.category, ms: covered });
    }

    const screenshots: TimelineScreenshot[] = [];
    for (let i = cursor.shots; i < shots.length && shots[i]!.at < end; i += 1) {
      screenshots.push(shots[i]!.shot);
    }

    slots.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      activeSeconds,
      idleSeconds,
      breakSeconds,
      // Offline is the residue, not an independent measurement. That is what makes the
      // four columns sum to the slot exactly, which the ribbon relies on.
      offlineSeconds: Math.max(0, slotSecondsTotal - tracked),
      activityRatio: tracked === 0 ? null : Number((activeSeconds / tracked).toFixed(4)),
      topApps: rankUsage(byApp, TOP_APPS_LIMIT),
      screenshots,
    });
  }

  return slots;
}

function advance(list: readonly { end: number }[], from: number, start: number): number {
  let index = from;
  while (index < list.length && list[index]!.end <= start) index += 1;
  return index;
}

function overlapSeconds(
  list: readonly Interval[],
  from: number,
  start: number,
  end: number,
): number {
  let ms = 0;
  for (let i = from; i < list.length && list[i]!.start < end; i += 1) {
    const interval = list[i]!;
    ms += Math.max(0, Math.min(interval.end, end) - Math.max(interval.start, start));
  }
  return Math.round(ms / 1000);
}

function rankUsage(
  byApp: Map<string, { category: string | null; ms: number }>,
  limit: number,
): AppUsage[] {
  return [...byApp.entries()]
    .map(([appName, { category, ms }]) => ({ appName, category, seconds: Math.round(ms / 1000) }))
    .filter((usage) => usage.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds || a.appName.localeCompare(b.appName))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// The whole day
// ---------------------------------------------------------------------------

export function buildDayTimeline(input: DayTimelineInput): DayTimeline {
  const windowStart = Date.parse(input.periodStart);
  const windowEnd = Date.parse(input.periodEnd);
  const slotSeconds = normaliseSlotSeconds(input.slotSeconds);

  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
    return emptyTimeline(input, slotSeconds);
  }

  const window: Interval = { start: windowStart, end: windowEnd };

  // A declared break outranks inferred idle. The employee said what they were doing;
  // the OS only guessed. They should never overlap, but if they do the statement wins.
  const breaks = clampAll(
    (input.breaks ?? []).map((e) => toInterval(e.break_start_at, e.break_end_at, windowEnd)),
    window,
  );
  const idle = difference(
    clampAll(
      input.idle.map((e) => toInterval(e.idle_start_at, e.idle_end_at, windowEnd)),
      window,
    ),
    breaks,
  );

  const rawActivity = clampAll(
    input.activity.map((e) => toInterval(e.started_at, e.ended_at, windowEnd)),
    window,
  );

  // The arithmetic. Same union-then-subtract algebra as summarisePeriod, and untouched
  // by any of the repair passes below, so the two endpoints cannot drift apart.
  const active = difference(rawActivity, [...idle, ...breaks]);

  // The picture.
  const keyed: KeyedSpan[] = [];
  for (const event of input.activity) {
    const trimmed = clamp(toInterval(event.started_at, event.ended_at, windowEnd), window);
    if (!trimmed) continue;
    keyed.push({
      start: trimmed.start,
      end: trimmed.end,
      key: event.app_name,
      appName: event.app_name,
      windowTitle: event.window_title,
      category: event.category,
    });
  }

  const reduced = clusterShort(
    toReducedSpans(
      subtractSpans(
        mergeAdjacent(floodGaps(keyed, input.pulseSeconds ?? DEFAULT_PULSE_SECONDS)),
        [...idle, ...breaks],
      ),
    ),
    input.clusterSeconds ?? DEFAULT_CLUSTER_SECONDS,
  );

  const apps = appIntervals(keyed, [...idle, ...breaks]);

  const slots = dayGrid({
    windowStart,
    windowEnd,
    slotSeconds,
    active,
    idle,
    breaks,
    apps,
    screenshots: input.screenshots,
  });

  const activeSeconds = totalSeconds(active);
  const idleSeconds = totalSeconds(idle);
  const breakSeconds = totalSeconds(breaks);
  const trackedSeconds = activeSeconds + idleSeconds + breakSeconds;
  const split = splitByProductivity(apps, input.productivityOf, activeSeconds);
  const windowSeconds = Math.round((windowEnd - windowStart) / 1000);

  return {
    profileId: input.profileId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    slotSeconds,
    slots,
    spans: buildSpanStream(reduced, idle, breaks, window),
    markers: buildMarkers(input, window),
    totals: {
      activeSeconds,
      ...split,
      idleSeconds,
      breakSeconds,
      offlineSeconds: Math.max(0, windowSeconds - trackedSeconds),
      trackedSeconds,
      activityRatio:
        trackedSeconds === 0 ? null : Number((activeSeconds / trackedSeconds).toFixed(4)),
    },
    topApps: rankWindowApps(apps),
    truncated: input.truncated ?? false,
  };
}

/**
 * Per-application time over the window, disjoint within each application.
 *
 * The merge is not cosmetic. A person with a laptop and a phone reporting the same
 * application at the same moment produces overlapping rows, and adding them credits
 * more seconds than the clock contains — the same double-count `merge()` exists to
 * prevent in the headline numbers.
 */
function appIntervals(spans: readonly KeyedSpan[], holes: readonly Interval[]): AppInterval[] {
  const byApp = new Map<string, { category: string | null; intervals: Interval[] }>();

  for (const span of spans) {
    const existing = byApp.get(span.appName);
    if (existing) existing.intervals.push({ start: span.start, end: span.end });
    else
      byApp.set(span.appName, {
        category: span.category,
        intervals: [{ start: span.start, end: span.end }],
      });
  }

  const out: AppInterval[] = [];
  for (const [appName, { category, intervals }] of byApp) {
    for (const piece of difference(intervals, [...holes])) {
      out.push({ start: piece.start, end: piece.end, appName, category });
    }
  }

  return out;
}

/**
 * Lays the reduced pieces into one contiguous, non-overlapping tiling of the window.
 *
 * A gap is data, not noise. An empty stretch becomes an explicit `offline` span rather
 * than being filtered out — the old behaviour rendered a ninety-minute hole as two
 * adjacent rows of work with no visual break at all.
 */
function buildSpanStream(
  reduced: readonly ReducedSpan[],
  idle: readonly Interval[],
  breaks: readonly Interval[],
  window: Interval,
): TimelineSpan[] {
  const pieces: TimelineSpan[] = [];

  for (const span of reduced) {
    pieces.push({
      start: new Date(span.start).toISOString(),
      end: new Date(span.end).toISOString(),
      kind: span.kind,
      appName: span.appName,
      windowTitle: span.windowTitle,
      category: span.category,
      seconds: span.seconds,
      appCount: span.appCount,
      topApps: span.topApps.slice(0, TOP_APPS_LIMIT),
    });
  }

  for (const interval of idle) pieces.push(stateSpan("idle", interval));
  for (const interval of breaks) pieces.push(stateSpan("break", interval));

  pieces.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  const filled: TimelineSpan[] = [];
  let cursor = window.start;

  for (const piece of pieces) {
    const start = Date.parse(piece.start);
    if (start > cursor) filled.push(stateSpan("offline", { start: cursor, end: start }));
    filled.push(piece);
    cursor = Math.max(cursor, Date.parse(piece.end));
  }

  if (cursor < window.end) filled.push(stateSpan("offline", { start: cursor, end: window.end }));

  return filled;
}

function stateSpan(kind: "idle" | "break" | "offline", interval: Interval): TimelineSpan {
  return {
    start: new Date(interval.start).toISOString(),
    end: new Date(interval.end).toISOString(),
    kind,
    appName: null,
    windowTitle: null,
    category: null,
    seconds: Math.round((interval.end - interval.start) / 1000),
    appCount: 0,
    topApps: [],
  };
}

/**
 * The moments scope §2.7 asks for.
 *
 * Copy is positioning-checked: a marker describes what the employee did, never what
 * the system caught them doing.
 */
function buildMarkers(input: DayTimelineInput, window: Interval): TimelineMarker[] {
  const markers: TimelineMarker[] = [];

  const add = (
    at: string | null,
    kind: TimelineMarkerKind,
    label: string,
    detail: string | null = null,
    screenshotId: number | null = null,
  ) => {
    if (!at) return;
    const ms = Date.parse(at);
    if (!Number.isFinite(ms) || ms < window.start || ms > window.end) return;
    markers.push({ at: new Date(ms).toISOString(), kind, label, detail, screenshotId });
  };

  for (const session of input.sessions ?? []) {
    add(session.clock_in_at, "clock-in", "Started work");
    add(session.clock_out_at, "clock-out", "Stopped work", elapsedLabel(session.clock_in_at, session.clock_out_at));
  }

  for (const event of input.breaks ?? []) {
    add(event.break_start_at, "break-start", "Break started");
    add(event.break_end_at, "break-end", "Back from break", elapsedLabel(event.break_start_at, event.break_end_at));
  }

  for (const event of input.idle) {
    add(event.idle_start_at, "idle-start", "Went idle");
    add(event.idle_end_at, "active-again", "Active again", elapsedLabel(event.idle_start_at, event.idle_end_at));
  }

  for (const shot of input.screenshots ?? []) {
    add(shot.capturedAt, "screenshot", "Screenshot", null, shot.id);
  }

  const order: Record<TimelineMarkerKind, number> = {
    "clock-in": 0,
    "active-again": 1,
    "break-end": 2,
    screenshot: 3,
    "idle-start": 4,
    "break-start": 5,
    "clock-out": 6,
  };

  // Ties are ordered so a stretch closes before the next one opens, and so the day
  // reads "started work" first and "stopped work" last at a shared instant.
  return markers.sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || order[a.kind] - order[b.kind],
  );
}

function elapsedLabel(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const seconds = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `after ${hours}h ${minutes}m`;
  if (minutes > 0) return `after ${minutes}m`;
  return `after ${seconds}s`;
}

/**
 * Window-wide application totals.
 *
 * Summed from the intervals, never from the slots' `topApps`. A slot list is capped
 * for legibility, so summing those would erase an application that ran all day without
 * ever placing in a single slot — and the app list would silently disagree with the
 * ribbon beside it.
 */
function rankWindowApps(apps: readonly AppInterval[]): AppUsage[] {
  const byApp = new Map<string, { category: string | null; ms: number }>();

  for (const app of apps) {
    const existing = byApp.get(app.appName);
    if (existing) existing.ms += app.end - app.start;
    else byApp.set(app.appName, { category: app.category, ms: app.end - app.start });
  }

  return rankUsage(byApp, 10);
}

function normaliseSlotSeconds(requested: number | undefined): SlotSeconds {
  const match = SLOT_SECONDS_OPTIONS.find((option) => option === requested);
  return match ?? DEFAULT_SLOT_SECONDS;
}

function emptyTimeline(input: DayTimelineInput, slotSeconds: SlotSeconds): DayTimeline {
  return {
    profileId: input.profileId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    slotSeconds,
    slots: [],
    spans: [],
    markers: [],
    totals: {
      activeSeconds: 0,
      idleSeconds: 0,
      breakSeconds: 0,
      offlineSeconds: 0,
      trackedSeconds: 0,
      activityRatio: null,
    },
    topApps: [],
    truncated: input.truncated ?? false,
  };
}

function clampAll(intervals: Interval[], window: Interval): Interval[] {
  const trimmed: Interval[] = [];
  for (const interval of intervals) {
    const result = clamp(interval, window);
    if (result) trimmed.push(result);
  }
  return merge(trimmed);
}

/** A merged title is meaningless residue, so it survives only if every part agreed. */
function agreedTitle(a: KeyedSpan, b: KeyedSpan): string | null {
  return a.windowTitle === b.windowTitle ? a.windowTitle : null;
}

function insertSorted(queue: KeyedSpan[], span: KeyedSpan, from: number): void {
  let index = from;
  while (index < queue.length && queue[index]!.start <= span.start) index += 1;
  queue.splice(index, 0, span);
}

/**
 * Splits active time three ways by what the work was.
 *
 * Apportioned from `apps`, which is already disjoint per application, rather than
 * re-walking the raw events — so the three parts cannot drift from `activeSeconds`.
 * Whatever active time no application accounts for (a gap between a rule firing and
 * an app name being read) lands in `neutral`, which keeps the identity
 * `productive + neutral + unproductive === activeSeconds` exact.
 *
 * Uncategorised goes to neutral rather than unproductive, matching
 * `UNCATEGORIZED_RESULT`. An application nobody wrote a rule for is evidence of
 * nothing, and counting "we don't know" against someone is the framing this product
 * refuses.
 */
function splitByProductivity(
  apps: readonly AppInterval[],
  productivityOf: ((category: string | null) => Productivity) | undefined,
  activeSeconds: number,
): { productiveSeconds: number; neutralSeconds: number; unproductiveSeconds: number } {
  if (productivityOf === undefined) {
    // No rule set supplied: every worked second is "we cannot say", which is neutral.
    return { productiveSeconds: 0, neutralSeconds: activeSeconds, unproductiveSeconds: 0 };
  }

  let productive = 0;
  let unproductive = 0;

  for (const app of apps) {
    // `appIntervals` has already subtracted idle and breaks, so these are disjoint
    // slices of active time and can simply be summed.
    const seconds = Math.round((app.end - app.start) / 1000);
    const verdict = productivityOf(app.category);
    if (verdict === "productive") productive += seconds;
    else if (verdict === "unproductive") unproductive += seconds;
  }

  // Clamped so a rounding disagreement between the per-app sums and the merged active
  // ranges can never make a part exceed the whole or go negative.
  productive = Math.min(productive, activeSeconds);
  unproductive = Math.min(unproductive, Math.max(0, activeSeconds - productive));

  return {
    productiveSeconds: productive,
    unproductiveSeconds: unproductive,
    neutralSeconds: activeSeconds - productive - unproductive,
  };
}
