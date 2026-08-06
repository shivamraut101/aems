"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { timeOfDay } from "@/lib/format";

/**
 * Screenshot review data: the wire shapes, the hooks, and the view models.
 *
 * The organising idea comes from docs/design.md — "not a plain gallery. Pair each
 * screenshot with the activity it belongs to". That pairing is only possible because
 * `GET /api/screenshots/blocks` and `GET /api/analytics/timeline` slice the same
 * window with the same rule, so a capture block and a timeline slot describe the same
 * ten minutes. Everything below joins those two on that shared unit.
 *
 * Types are mirrored locally rather than imported from the API package: the wire
 * contract is what this screen depends on, and a mirror makes a server-side shape
 * change show up as a compile error here instead of as an empty column.
 */

/**
 * The block width every view agrees on.
 *
 * 600s is the unit the ribbon, the app list and this screen share. Picking a
 * different one here is how three views stop lining up.
 */
export const REVIEW_BLOCK_SECONDS = 600;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One capture, already signed. Either URL may be null if signing failed for it. */
export interface ScreenshotCapture {
  id: number;
  capturedAt: string;
  /** Full-resolution image, behind the click. */
  url: string | null;
  /** 280px thumbnail when the agent uploaded one, otherwise the full image. */
  thumbnailUrl: string | null;
  blurred: boolean;
  workSessionId: number | null;
}

export interface ScreenshotBlock {
  periodStart: string;
  periodEnd: string;
  screenshots: ScreenshotCapture[];
  screenshotCount: number;
  /** Frames at the busiest instant in the block — the multi-display badge. */
  monitorCount: number;
}

export interface ScreenshotBlocksResponse {
  profileId: string;
  from: string;
  to: string;
  blockSeconds: number;
  screenshotCount: number;
  /** The row cap was hit: this page is the START of the window, not all of it. */
  truncated: boolean;
  /** Lifetime of the signed URLs above, in seconds. */
  expiresInSeconds: number;
  blocks: ScreenshotBlock[];
}

export interface AppUsageView {
  appName: string;
  category: string | null;
  seconds: number;
}

/**
 * One slot of the day grid, as `GET /api/analytics/timeline` returns it.
 *
 * `active + idle + break + offline` is exactly the slot length, which is what makes
 * the bar fractions below tile without arithmetic of our own.
 */
export interface TimelineSlotView {
  start: string;
  end: string;
  activeSeconds: number;
  idleSeconds: number;
  breakSeconds: number;
  offlineSeconds: number;
  activityRatio: number | null;
  topApps: AppUsageView[];
  screenshots: ScreenshotCapture[];
}

export interface DayTimelineView {
  profileId: string;
  periodStart: string;
  periodEnd: string;
  slotSeconds: number;
  slots: TimelineSlotView[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/** The day the review screen is showing, as an ISO window the API accepts. */
export function dayWindow(
  date: string,
  now = new Date(),
  blockSeconds = REVIEW_BLOCK_SECONDS,
): { from: string; to: string } {
  const start = startOfLocalDay(date, now);
  const blockMs = Math.max(1, blockSeconds) * 1000;

  const dayEnd = new Date(start);
  dayEnd.setDate(dayEnd.getDate() + 1);

  // A day in progress stops at the current block. Rendering the remaining fourteen
  // hours as "No capture" would read as a fault rather than as a day that has not
  // happened yet.
  const currentBlockEnd = Math.ceil(now.getTime() / blockMs) * blockMs;
  let to = Math.min(dayEnd.getTime(), currentBlockEnd);

  // `to <= from` is a 400 on the API. A future date still has to ask a well-formed
  // question and get an empty answer back.
  if (to <= start.getTime()) to = start.getTime() + blockMs;

  return { from: new Date(start).toISOString(), to: new Date(to).toISOString() };
}

function startOfLocalDay(date: string, fallback: Date): Date {
  const parts = date.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    const today = new Date(fallback);
    today.setHours(0, 0, 0, 0);
    return today;
  }

  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

/** Today, in the viewer's own calendar, as the `YYYY-MM-DD` the date input wants. */
export function localDateString(date = new Date()): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The day before / after `date`, for the day stepper. */
export function shiftDate(date: string, days: number, now = new Date()): string {
  const start = startOfLocalDay(date, now);
  start.setDate(start.getDate() + days);
  return localDateString(start);
}

/**
 * A duration at the ten-minute scale, in words.
 *
 * `lib/format.duration` rounds to whole minutes, which is right for an eight-hour
 * day and wrong here: inside a ten-minute block the seconds are most of the signal,
 * and "Active 7m" for 7m 30s quietly loses half the difference between blocks.
 */
export function durationWords(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";

  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;

  // Seconds stop mattering once the number is hours long.
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${rest}s`;
}

export interface BlockActivity {
  /** What the block was spent on: an application, "Idle", "On a break", "Offline". */
  headline: string;
  /**
   * The split, in words — "Active 7m 30s · Idle 2m 30s".
   *
   * Never a percentage. docs/design.md: a bare number reads as a score, and a score
   * beside a person's name is the framing this product refuses.
   */
  split: string;
  /** Fractions of the block, for the thin bar. Sum to 1 when time was recorded. */
  bar: { active: number; idle: number; break: number; offline: number };
  /** Applications in the block, longest first. */
  apps: string[];
}

const NO_BAR = { active: 0, idle: 0, break: 0, offline: 0 } as const;

export function describeBlockActivity(slot: TimelineSlotView | null): BlockActivity {
  if (!slot) {
    return {
      headline: "Activity not recorded",
      split: "No agent data for this block",
      bar: { ...NO_BAR },
      apps: [],
    };
  }

  const active = atLeastZero(slot.activeSeconds);
  const idle = atLeastZero(slot.idleSeconds);
  const broken = atLeastZero(slot.breakSeconds);
  const offline = atLeastZero(slot.offlineSeconds);
  const total = active + idle + broken + offline;

  const terms: string[] = [];
  if (active > 0) terms.push(`Active ${durationWords(active)}`);
  if (idle > 0) terms.push(`Idle ${durationWords(idle)}`);
  if (broken > 0) terms.push(`Break ${durationWords(broken)}`);
  if (offline > 0) terms.push(`Offline ${durationWords(offline)}`);

  const apps = slot.topApps.map((app) => app.appName);

  return {
    headline: headlineFor({ active, idle, broken, offline, apps }),
    split: terms.length > 0 ? terms.join(" · ") : "No time recorded",
    bar:
      total === 0
        ? { ...NO_BAR }
        : {
            active: active / total,
            idle: idle / total,
            break: broken / total,
            offline: offline / total,
          },
    apps,
  };
}

function headlineFor(input: {
  active: number;
  idle: number;
  broken: number;
  offline: number;
  apps: string[];
}): string {
  // A declared break wins outright: break time is never photographed, so saying
  // anything else about the block would misdescribe why it is empty.
  if (input.broken > 0 && input.broken >= input.active && input.broken >= input.idle) {
    return "On a break";
  }
  // Idle beats the application underneath it — the window was focused, the person
  // was not there, and naming the app would claim work that did not happen.
  if (input.active > 0 && input.active >= input.idle) return input.apps[0] ?? "Active";
  if (input.idle > 0) return "Idle";
  if (input.offline > 0) return "Offline";
  return "No time recorded";
}

function atLeastZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export interface ReviewCapture {
  id: number;
  capturedAt: string;
  /** Clock label for the tile caption and the lightbox title. */
  timeLabel: string;
  thumbnailUrl: string | null;
  fullUrl: string | null;
  blurred: boolean;
  workSessionId: number | null;
  /** "unavailable" when signing failed: show a cell saying so, never a broken image. */
  status: "ready" | "unavailable";
}

export interface ReviewRow {
  /** Stable across refetches, so React keeps tile state when URLs are re-signed. */
  key: string;
  start: string;
  end: string;
  /** "09:00 – 09:10". */
  timeLabel: string;
  captures: ReviewCapture[];
  hasCapture: boolean;
  monitorCount: number;
  activity: BlockActivity;
}

export interface ReviewRowsInput {
  blocks: readonly ScreenshotBlock[];
  slots: readonly TimelineSlotView[];
}

export interface ReviewRowsOptions {
  /** Injected so tests do not assert the runner's locale. */
  formatTime?: (iso: string) => string;
}

/**
 * One row per block — including the blocks with nothing in them.
 *
 * An empty block is a fact about the day ("nothing was captured between 11:20 and
 * 11:30"), so it renders as an explicit cell rather than being filtered out. A
 * review screen that collapses gaps cannot show a gap.
 */
export function buildReviewRows(
  input: ReviewRowsInput,
  options: ReviewRowsOptions = {},
): ReviewRow[] {
  const formatTime = options.formatTime ?? timeOfDay;
  const findSlot = slotFinder(input.slots);

  return input.blocks.map((block) => {
    const start = Date.parse(block.periodStart);
    const end = Date.parse(block.periodEnd);
    const captures = block.screenshots.map((shot) => toReviewCapture(shot, formatTime));

    return {
      key: block.periodStart,
      start: block.periodStart,
      end: block.periodEnd,
      timeLabel: `${formatTime(block.periodStart)} – ${formatTime(block.periodEnd)}`,
      captures,
      hasCapture: captures.length > 0,
      monitorCount: block.monitorCount,
      activity: describeBlockActivity(findSlot((start + end) / 2)),
    };
  });
}

function toReviewCapture(
  shot: ScreenshotCapture,
  formatTime: (iso: string) => string,
): ReviewCapture {
  // The thumbnail is an optimisation; the full image is the record of fact. Falling
  // back keeps a tile renderable until the agent starts uploading thumbnails.
  const thumbnailUrl = shot.thumbnailUrl ?? shot.url;

  return {
    id: shot.id,
    capturedAt: shot.capturedAt,
    timeLabel: formatTime(shot.capturedAt),
    thumbnailUrl,
    fullUrl: shot.url ?? shot.thumbnailUrl,
    blurred: shot.blurred,
    workSessionId: shot.workSessionId,
    status: thumbnailUrl ? "ready" : "unavailable",
  };
}

/**
 * Matches a block to the slot covering its midpoint rather than to an identical
 * timestamp.
 *
 * The screenshot window is sliced from `from`; timeline slots are anchored to
 * wall-clock multiples of the unit. In a zone whose offset is not a whole number of
 * ten-minute steps the two grids sit half a block apart, and an exact-timestamp join
 * would silently blank the activity column for the whole day.
 */
function slotFinder(slots: readonly TimelineSlotView[]): (atMs: number) => TimelineSlotView | null {
  const ordered = [...slots]
    .map((slot) => ({ slot, start: Date.parse(slot.start), end: Date.parse(slot.end) }))
    .filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end))
    .sort((a, b) => a.start - b.start);

  // Both sequences ascend, so a cursor that only moves forward makes this linear
  // rather than a scan per block.
  let cursor = 0;

  return (atMs) => {
    if (!Number.isFinite(atMs)) return null;
    while (cursor > 0 && (ordered[cursor - 1]?.end ?? 0) > atMs) cursor -= 1;
    while (cursor < ordered.length && (ordered[cursor]?.end ?? 0) <= atMs) cursor += 1;

    const entry = ordered[cursor];
    return entry && entry.start <= atMs ? entry.slot : null;
  };
}

export interface FlatCapture extends ReviewCapture {
  /** Position in the day, which is what the lightbox arrows step through. */
  index: number;
  blockStart: string;
  blockLabel: string;
  activity: BlockActivity;
}

/** Every capture of the day in order, so the lightbox crosses block boundaries. */
export function flattenCaptures(rows: readonly ReviewRow[]): FlatCapture[] {
  const flat: FlatCapture[] = [];

  for (const row of rows) {
    for (const capture of row.captures) {
      flat.push({
        ...capture,
        index: flat.length,
        blockStart: row.start,
        blockLabel: row.timeLabel,
        activity: row.activity,
      });
    }
  }

  return flat;
}

/**
 * Moves the lightbox selection.
 *
 * Clamps rather than wraps: pressing → on the last capture of the day should stop,
 * not silently jump back to breakfast.
 */
export function stepCapture(index: number, delta: number, total: number): number {
  if (total <= 0) return -1;
  return Math.min(total - 1, Math.max(0, index + delta));
}

/**
 * When to re-sign the page's URLs, in ms — or `false` when the API said nothing.
 *
 * Signed URLs are short-lived bearer capabilities. Refetching *at* expiry means every
 * tile breaks first and recovers second, so this fires at 80% of the lifetime.
 */
export function resignAfterMs(expiresInSeconds: number): number | false {
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return false;
  return Math.max(30_000, Math.floor(expiresInSeconds * 0.8) * 1000);
}

/** Per-capture count of failed image loads. */
export type ImageFailures = Readonly<Record<number, number>>;

/**
 * What to do when an `<img>` fails.
 *
 * The overwhelmingly likely cause is a URL that outlived its ten minutes — a page
 * left open over lunch — so the first failure asks for fresh signatures. A second
 * failure on a freshly signed URL is a real problem with the object, and retrying it
 * forever would be an infinite refetch loop.
 */
export function noteImageFailure(
  state: ImageFailures,
  id: number,
): { state: ImageFailures; action: "refetch" | "unavailable" } {
  const attempts = (state[id] ?? 0) + 1;
  return { state: { ...state, [id]: attempts }, action: attempts <= 1 ? "refetch" : "unavailable" };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function query(path: string, params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.set(key, String(value));
  return `${path}?${search.toString()}`;
}

/**
 * The captures of a window, grouped into the shared block.
 *
 * `retry: false` because every way this fails is settled: an employee asking for
 * someone else's day (403), a range wider than the API renders (400), or a window
 * the caller built wrong. Retrying three times only delays the message.
 */
export function useScreenshotBlocks(
  profileId: string,
  from: string,
  to: string,
  blockSeconds: number = REVIEW_BLOCK_SECONDS,
) {
  return useQuery({
    queryKey: ["screenshots", profileId, from, to, blockSeconds],
    queryFn: () =>
      apiFetch<ScreenshotBlocksResponse>(
        query("/api/screenshots/blocks", { profileId, from, to, blockSeconds }),
      ),
    enabled: Boolean(profileId && from && to),
    retry: false,
    // Below the signed-URL lifetime, so a revisit re-signs rather than reusing keys
    // that are about to die.
    staleTime: 5 * 60_000,
    refetchInterval: (q) => resignAfterMs(q.state.data?.expiresInSeconds ?? 0),
  });
}

/**
 * The same window as slots, which is where the activity beside each block comes from.
 *
 * Kept as a separate query on purpose: if the timeline is unavailable the captures
 * still render, with the activity column saying so, rather than the screen failing
 * whole. Key and endpoint match the timeline view exactly, so the two share a cache
 * entry instead of fetching the day twice.
 */
export function useTimelineSlots(
  profileId: string,
  from: string,
  to: string,
  bucketSeconds: number = REVIEW_BLOCK_SECONDS,
) {
  return useQuery({
    queryKey: ["timeline", profileId, from, to, bucketSeconds],
    queryFn: () =>
      apiFetch<DayTimelineView>(
        query("/api/analytics/timeline", { profileId, from, to, bucketSeconds }),
      ),
    enabled: Boolean(profileId && from && to),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/* -------------------------------------------------------------------------- */
/* Filtering the review by what the block was spent on                         */
/* -------------------------------------------------------------------------- */

/** The four things a ten-minute block can mostly have been. */
export type BlockState = "active" | "idle" | "break" | "offline";

export const BLOCK_STATE_LABELS: Record<BlockState, string> = {
  active: "Active",
  idle: "Idle",
  break: "On a break",
  offline: "Offline",
};

/**
 * The state that took the largest share of the block, or null if nothing was recorded.
 *
 * Dominant share rather than "contains any", and the reason is that the counts have to
 * add up. A block that is 60% active and 40% idle is one block; if it appeared under
 * both filters then "Active 5 · Idle 3" would exceed the 6 blocks actually on screen,
 * and a reviewer checking whether a day is evidenced cannot trust a total that
 * double-counts. Each block belongs to exactly one bucket.
 *
 * Ties go to the earlier key in `ORDER`, which puts active first — a block split evenly
 * between working and idling is more usefully found under "Active", because that is the
 * one a reviewer is looking for when they are checking what was done.
 */
const ORDER: readonly BlockState[] = ["active", "idle", "break", "offline"];

export function dominantState(activity: BlockActivity): BlockState | null {
  let best: BlockState | null = null;
  let share = 0;

  for (const state of ORDER) {
    const value = activity.bar[state];
    // Strictly greater, so the ORDER above breaks ties rather than the last key winning.
    if (value > share) {
      share = value;
      best = state;
    }
  }

  return share > 0 ? best : null;
}

/**
 * How many blocks fall in each bucket, for the filter's own labels.
 *
 * Shown on the control because a filter that leads to an empty list is a dead end — a
 * reviewer should be able to see there are no break blocks without selecting "On a
 * break" and finding out the hard way.
 */
export function blockStateCounts(rows: readonly ReviewRow[]): Record<BlockState, number> {
  const counts: Record<BlockState, number> = { active: 0, idle: 0, break: 0, offline: 0 };
  for (const row of rows) {
    const state = dominantState(row.activity);
    if (state !== null) counts[state] += 1;
  }
  return counts;
}

/** Narrows the review to one state. `"all"` is the identity, so callers need no branch. */
export function filterRowsByState(
  rows: readonly ReviewRow[],
  state: BlockState | "all",
): ReviewRow[] {
  if (state === "all") return [...rows];
  return rows.filter((row) => dominantState(row.activity) === state);
}
