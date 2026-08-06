import type {
  ActivityEvent,
  AppUsage,
  IdleEvent,
  ProductivitySummary,
  Screenshot,
  TimelineEntry,
} from "@aems/types";

import { clamp, difference, merge, toInterval, totalSeconds, type Interval } from "./intervals.js";

/**
 * The columns this arithmetic actually reads.
 *
 * Narrower than the table types so a route can `select` four columns instead of `*`,
 * for the same reason `ScreenshotRow` below and `ActivityRow` in `timeline.ts` exist.
 * `activity_events` also carries `window_title`, `url` and four uuids that nothing
 * here looks at, and those are what make the row wide. A full row stays assignable,
 * so callers holding one do not have to map first.
 */
export type PeriodActivityRow = Pick<
  ActivityEvent,
  "app_name" | "category" | "started_at" | "ended_at"
>;
export type PeriodIdleRow = Pick<IdleEvent, "idle_start_at" | "idle_end_at">;

export interface PeriodInput {
  profileId: string;
  periodStart: string;
  periodEnd: string;
  activity: PeriodActivityRow[];
  idle: PeriodIdleRow[];
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
export function rankApps(activity: PeriodActivityRow[], window: Interval, limit = 10): AppUsage[] {
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

/**
 * The columns of a screenshot row the read path actually needs.
 *
 * Narrower than `Screenshot` so a route can `select` these six columns instead of
 * `*` — a screenshot list is the widest table in the product and the rest of the row
 * is never rendered.
 */
export type ScreenshotRow = Pick<
  Screenshot,
  "id" | "captured_at" | "storage_path" | "thumbnail_path" | "blurred" | "work_session_id"
>;

export interface TimelineInput extends PeriodInput {
  deviceId: string;
  screenshots?: readonly ScreenshotRow[];
  /** Slot width. Defaults to one hour. */
  bucketSeconds?: number;
}

/**
 * One capture, as the dashboard needs it.
 *
 * `url` and `thumbnailUrl` are null here on purpose. The bucket is private, so a
 * usable link has to be signed — and signing is an I/O call that belongs to the API,
 * not to a pure aggregation. The route fills them via `withSignedUrls`.
 */
export interface ScreenshotRef {
  id: number;
  capturedAt: string;
  storagePath: string;
  thumbnailPath: string | null;
  blurred: boolean;
  workSessionId: number | null;
  url: string | null;
  thumbnailUrl: string | null;
}

/**
 * A timeline entry, with every capture that belongs to its block.
 *
 * Widens `TimelineEntry` rather than replacing it: the shared contract in
 * `@aems/types` is owned elsewhere, and a wider object is still assignable to the
 * narrower one, so nothing downstream breaks while the two converge.
 */
export interface TimelineEntryWithScreenshots extends TimelineEntry {
  screenshots: ScreenshotRef[];
  screenshotCount: number;
  /**
   * Frames captured at the busiest single instant in the block.
   *
   * A multi-monitor tick stamps every frame with one `capturedAt`, so the size of
   * the largest same-instant group is how many displays were photographed. It is an
   * inference, not a recorded fact — the schema has no display column yet.
   */
  monitorCount: number;
}

/** Splits a period into fixed slots for the dashboard timeline strip. */
export function buildTimeline(input: TimelineInput): TimelineEntryWithScreenshots[] {
  const bucketMs = (input.bucketSeconds ?? 3600) * 1000;
  const windowStart = Date.parse(input.periodStart);
  const windowEnd = Date.parse(input.periodEnd);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || bucketMs <= 0) return [];

  const entries: TimelineEntryWithScreenshots[] = [];
  const nextScreenshots = screenshotCursor(input.screenshots ?? []);

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

    const shots = nextScreenshots(slot);

    entries.push({
      profileId: input.profileId,
      deviceId: input.deviceId,
      periodStart: new Date(slot.start).toISOString(),
      periodEnd: new Date(slot.end).toISOString(),
      activeSeconds: totalSeconds(difference(activityIntervals, idleIntervals)),
      idleSeconds: totalSeconds(idleIntervals),
      topApp,
      // Deprecated in favour of `screenshots`. Kept so callers still reading the
      // single-id field keep working; it is the block's first capture, where it
      // used to be whichever row the query happened to return first.
      screenshotId: shots[0]?.id ?? null,
      screenshots: shots,
      screenshotCount: shots.length,
      monitorCount: monitorCountOf(shots),
    });
  }

  return entries;
}

/**
 * The unit the screenshot review and the timeline share.
 *
 * Ten minutes is the block every comparable product reviews a day in, and the point
 * of naming it once is that the ribbon, the screenshot strip and the app list cannot
 * drift into three different grids.
 */
export const DEFAULT_SCREENSHOT_BLOCK_SECONDS = 600;

/**
 * Every capture inside one block, oldest first.
 *
 * This used to be a `.find()`, which kept one screenshot per block and dropped the
 * rest — at scope §2.3's one-minute interval that is 59 of every 60 captures gone,
 * silently. The block is half-open, `[start, end)`, so a capture on a boundary
 * belongs to exactly one block and totals across blocks add up.
 */
export function screenshotsInSlot(
  screenshots: readonly ScreenshotRow[],
  slot: Interval,
): ScreenshotRef[] {
  return screenshotCursor(screenshots)(slot);
}

/**
 * A reusable reader over one window's captures, for callers filling slot after slot.
 *
 * Timestamps are parsed and sorted once and the walk keeps a pointer, so filling a
 * day costs one sort rather than one rescan per slot. That matters at the fine end
 * of the grid: a day of 5,000 captures at 60-second slots measured 1.2 seconds of
 * straight-line CPU under the rescan — on a single-threaded API process, that is
 * every other request in the queue waiting on one timeline.
 *
 * **Slots must be requested in ascending order** — the pointer never goes back.
 * Both callers here walk a contiguous window forwards.
 */
export function screenshotCursor(
  screenshots: readonly ScreenshotRow[],
): (slot: Interval) => ScreenshotRef[] {
  const sorted: { at: number; row: ScreenshotRow }[] = [];

  for (const row of screenshots) {
    const at = Date.parse(row.captured_at);
    // An unparseable timestamp cannot be placed on a timeline. Dropping it is
    // honest; putting it in an arbitrary block would be a lie about when it happened.
    if (!Number.isFinite(at)) continue;
    sorted.push({ at, row });
  }

  // Ties are the multi-monitor case — one instant, several frames. Ordering them by
  // id keeps a block's strip stable between requests.
  sorted.sort((a, b) => a.at - b.at || a.row.id - b.row.id);

  let cursor = 0;

  return (slot: Interval): ScreenshotRef[] => {
    while (cursor < sorted.length) {
      const entry = sorted[cursor];
      if (!entry || entry.at >= slot.start) break;
      cursor += 1;
    }

    const refs: ScreenshotRef[] = [];
    for (let i = cursor; i < sorted.length; i += 1) {
      const entry = sorted[i];
      // Half-open: a capture exactly on the boundary belongs to the next slot, so
      // totals across slots add up to the total in the window.
      if (!entry || entry.at >= slot.end) break;
      refs.push(toRef(entry.row));
    }

    return refs;
  };
}

function toRef(row: ScreenshotRow): ScreenshotRef {
  return {
    id: row.id,
    capturedAt: row.captured_at,
    storagePath: row.storage_path,
    thumbnailPath: row.thumbnail_path,
    blurred: row.blurred,
    workSessionId: row.work_session_id,
    url: null,
    thumbnailUrl: null,
  };
}

/** How many displays the busiest capture instant in this block photographed. */
export function monitorCountOf(screenshots: readonly ScreenshotRef[]): number {
  const perInstant = new Map<string, number>();
  for (const shot of screenshots) {
    perInstant.set(shot.capturedAt, (perInstant.get(shot.capturedAt) ?? 0) + 1);
  }
  return perInstant.size === 0 ? 0 : Math.max(...perInstant.values());
}

export interface ScreenshotBlockInput {
  periodStart: string;
  periodEnd: string;
  /** Defaults to the shared ten-minute unit. */
  blockSeconds?: number;
  screenshots: readonly ScreenshotRow[];
}

export interface ScreenshotBlock {
  periodStart: string;
  periodEnd: string;
  screenshots: ScreenshotRef[];
  screenshotCount: number;
  monitorCount: number;
}

/**
 * Groups a window of captures into fixed blocks for the review screen.
 *
 * Slices the window exactly the way `buildTimeline` slices its slots, so the same
 * `from`/`to`/`seconds` produce identical boundaries in both — the screenshot strip
 * and the timeline ribbon line up by construction rather than by coincidence.
 *
 * Empty blocks are emitted rather than skipped: a gap in the day is information, and
 * a review UI that collapses it cannot show that nothing was captured.
 */
export function groupScreenshotsIntoBlocks(input: ScreenshotBlockInput): ScreenshotBlock[] {
  const blockMs = (input.blockSeconds ?? DEFAULT_SCREENSHOT_BLOCK_SECONDS) * 1000;
  const windowStart = Date.parse(input.periodStart);
  const windowEnd = Date.parse(input.periodEnd);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || blockMs <= 0) return [];

  const blocks: ScreenshotBlock[] = [];

  for (let start = windowStart; start < windowEnd; start += blockMs) {
    const slot: Interval = { start, end: Math.min(start + blockMs, windowEnd) };
    const shots = screenshotsInSlot(input.screenshots, slot);

    blocks.push({
      periodStart: new Date(slot.start).toISOString(),
      periodEnd: new Date(slot.end).toISOString(),
      screenshots: shots,
      screenshotCount: shots.length,
      monitorCount: monitorCountOf(shots),
    });
  }

  return blocks;
}

/**
 * One capture as the dashboard receives it.
 *
 * Deliberately the same shape as `TimelineScreenshot` in `@aems/types`, so a route
 * can hand these straight to the day-grid builder with no conversion step.
 *
 * The storage keys are gone: a signed URL is everything a browser needs, and the
 * object layout is `<company>/<employee>/screenshots/…`, which describes the tenant.
 * Screenshots are the most sensitive artefact in the product; the response carries
 * the minimum that renders them.
 */
export interface ResolvedScreenshot {
  id: number;
  capturedAt: string;
  url: string | null;
  thumbnailUrl: string | null;
  blurred: boolean;
  workSessionId: number | null;
}

/** Anything carrying captures that need signing — a timeline entry or a review block. */
export interface HasScreenshots {
  screenshots: ScreenshotRef[];
}

/** A group with its captures resolved for display. */
export type Resolved<T extends HasScreenshots> = Omit<T, "screenshots"> & {
  screenshots: ResolvedScreenshot[];
};

/**
 * Every distinct object key a flat run of captures needs.
 *
 * Deduplicated because a signature is work per key: one call for the page, never one
 * per tile.
 */
export function screenshotPaths(screenshots: readonly ScreenshotRef[]): string[] {
  const paths = new Set<string>();
  for (const shot of screenshots) {
    paths.add(shot.storagePath);
    if (shot.thumbnailPath) paths.add(shot.thumbnailPath);
  }
  return [...paths];
}

/** The same, across a page of blocks or timeline entries — still one batch. */
export function signablePaths(groups: readonly HasScreenshots[]): string[] {
  const paths = new Set<string>();
  for (const group of groups) {
    for (const path of screenshotPaths(group.screenshots)) paths.add(path);
  }
  return [...paths];
}

/**
 * Shape of one entry from Supabase Storage's `createSignedUrls`.
 *
 * Both fields are nullable there: the call succeeds as a whole and reports failure
 * per path, so a batch can come back part-signed.
 */
export interface SignedUrlEntry {
  path: string | null;
  signedUrl: string | null;
  error?: string | null;
}

/** Indexes a batch signing result by path, skipping anything the signer refused. */
export function signedUrlIndex(entries: readonly SignedUrlEntry[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.path || !entry.signedUrl) continue;
    index.set(entry.path, entry.signedUrl);
  }
  return index;
}

/**
 * Trades storage keys for signed URLs.
 *
 * A key with no signature resolves to null. The bucket is private, so there is no
 * public URL to guess at — a null tells the UI to render a "capture unavailable"
 * cell instead of a broken image, which is the only truthful option.
 */
export function resolveScreenshots(
  screenshots: readonly ScreenshotRef[],
  urlByPath: ReadonlyMap<string, string>,
): ResolvedScreenshot[] {
  return screenshots.map((shot) => {
    const url = urlByPath.get(shot.storagePath) ?? null;
    const thumbnailUrl = shot.thumbnailPath ? (urlByPath.get(shot.thumbnailPath) ?? null) : null;

    return {
      id: shot.id,
      capturedAt: shot.capturedAt,
      url,
      // Nothing writes `thumbnail_path` yet, so falling back to the full image is
      // what keeps a tile renderable today. Drop the fallback once the agent
      // actually uploads thumbnails, or a review page keeps paying full resolution.
      thumbnailUrl: thumbnailUrl ?? url,
      blurred: shot.blurred,
      workSessionId: shot.workSessionId,
    };
  });
}

/** The same, across a page of blocks or timeline entries. Does not mutate its input. */
export function withSignedUrls<T extends HasScreenshots>(
  groups: readonly T[],
  urlByPath: ReadonlyMap<string, string>,
): Resolved<T>[] {
  return groups.map((group) => ({
    ...group,
    screenshots: resolveScreenshots(group.screenshots, urlByPath),
  }));
}

function clampAll(intervals: Interval[], window: Interval): Interval[] {
  const trimmed: Interval[] = [];
  for (const interval of intervals) {
    const result = clamp(interval, window);
    if (result) trimmed.push(result);
  }
  return merge(trimmed);
}
