import type {
  DayTimeline,
  TimelineMarkerKind,
  TimelineScreenshot,
  TimelineSlot,
  TimelineSpan,
  TimelineSpanKind,
} from "@aems/types";

import { duration, timeOfDay } from "@/lib/format";

/**
 * The pure half of the activity timeline.
 *
 * Everything here is a view model: given a `DayTimeline` from the API, produce the
 * numbers and strings the SVG and the rail render verbatim. It lives apart from the
 * components because this is where the product decisions are — the minimum rendered
 * width, the label threshold, which colours are allowed — and a decision that can be
 * asserted in a test is a decision that survives the next refactor.
 */

/** viewBox width: one unit per minute of a full day, so the maths reads in minutes. */
export const RIBBON_WIDTH = 1440;

/**
 * A span shorter than this still gets this much width on screen.
 *
 * Cattr's `max(duration, 60)` floor, without their `+120` pad: a fifteen-second
 * switch has to stay hoverable, but the pixels must never leak into arithmetic —
 * only `width` is clamped, `seconds` is left exactly as the server reported it.
 */
export const MIN_RENDERED_SECONDS = 60;

/** ActivityWatch's rule: a label is drawn only if its span is 5% of the visible day. */
export const LABEL_MIN_FRACTION = 0.05;

/** An offline stretch shorter than this is sampling noise, not an absence worth a row. */
export const MIN_GAP_SECONDS = 300;

export interface TimelineWindow {
  from: string;
  to: string;
}

export interface RibbonSegment {
  key: string;
  kind: TimelineSpanKind;
  start: string;
  end: string;
  /** Honest duration. Never derived from `width`. */
  seconds: number;
  x: number;
  width: number;
  /** What `width` would be with no minimum applied — used to rank the paint order. */
  naturalWidth: number;
  widthClamped: boolean;
  label: string;
  showLabel: boolean;
  /** Hover text; carries everything the rect is too narrow to say. */
  title: string;
  appName: string | null;
  /** Deterministic identity hue for the label chip. Null for non-app kinds. */
  appHue: number | null;
  /** Ascending draw order. Narrow segments come last so a widened sliver stays visible. */
  paintOrder: number;
}

/**
 * State is the ribbon's primary encoding, so these are the four status tokens and
 * nothing else. Indigo is absent by design — `docs/design.md` reserves it for AI
 * output so a reader can tell a model's opinion from a recorded fact — and red is
 * absent because a red block beside a person's name is the surveillance framing the
 * positioning rule forbids.
 */
export const SPAN_FILL: Record<TimelineSpanKind, string> = {
  app: "hsl(var(--success))",
  switching: "url(#aems-timeline-switching)",
  idle: "hsl(var(--warning))",
  break: "hsl(var(--muted-foreground) / 0.25)",
  offline: "url(#aems-timeline-nodata)",
};

/**
 * Label colour per fill.
 *
 * Emerald and amber hold the same value in both themes, so a fixed navy reads on
 * them either way. Break and offline sit on theme-dependent fills, so their labels
 * have to flip with the theme instead.
 */
export const SPAN_LABEL_FILL: Record<TimelineSpanKind, string> = {
  app: "hsl(222 47% 11%)",
  switching: "hsl(222 47% 11%)",
  idle: "hsl(222 47% 11%)",
  break: "hsl(var(--foreground))",
  offline: "hsl(var(--muted-foreground))",
};

/**
 * Eight fixed hues for application identity — the secondary channel, used on label
 * chips only so it can never be confused with the state fill.
 *
 * The 215–265 band is skipped on purpose: that is where indigo lives.
 */
export const APP_HUES: readonly number[] = [8, 32, 52, 96, 152, 188, 288, 322];

/** Stable per-application hue. Same idea as ActivityWatch's hash, written fresh. */
export function appHue(appName: string): number {
  let hash = 0;
  for (let i = 0; i < appName.length; i += 1) {
    hash = (Math.imul(hash, 31) + appName.charCodeAt(i)) | 0;
  }
  return APP_HUES[Math.abs(hash) % APP_HUES.length] ?? 0;
}

export function spanLabel(span: TimelineSpan): string {
  switch (span.kind) {
    case "app":
      return span.appName ?? "Unknown application";
    case "switching":
      return `Rapid switching · ${span.appCount} apps`;
    case "idle":
      return "Idle";
    case "break":
      return "Break";
    case "offline":
      return "No data";
  }
}

function segmentTitle(span: TimelineSpan, start: string, end: string, seconds: number): string {
  const parts = [`${timeOfDay(start)} – ${timeOfDay(end)}`, spanLabel(span), duration(seconds)];

  if (span.kind === "switching" && span.topApps.length > 0) {
    parts.push(span.topApps.map((app) => app.appName).join(", "));
  } else if (span.kind === "app" && span.windowTitle) {
    parts.push(span.windowTitle);
  }

  return parts.join(" · ");
}

/**
 * Lays the reduced spans out across the window.
 *
 * The server guarantees the spans tile `[periodStart, periodEnd)` with no gaps and no
 * overlaps, so there is no gap arithmetic here — every hole in the day arrives as an
 * explicit `offline` span and is rendered as one. Absence of data and zero activity
 * are different facts and the ribbon has to show both.
 */
export function buildRibbon(spans: TimelineSpan[], window: TimelineWindow): RibbonSegment[] {
  const windowStart = Date.parse(window.from);
  const windowEnd = Date.parse(window.to);
  const totalMs = windowEnd - windowStart;
  if (!Number.isFinite(totalMs) || totalMs <= 0) return [];

  const minWidth = ((MIN_RENDERED_SECONDS * 1000) / totalMs) * RIBBON_WIDTH;

  const segments: RibbonSegment[] = [];

  for (const [index, span] of spans.entries()) {
    const rawStart = Date.parse(span.start);
    const rawEnd = Date.parse(span.end);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;

    const startMs = Math.max(rawStart, windowStart);
    const endMs = Math.min(rawEnd, windowEnd);
    if (endMs <= startMs) continue;

    // A clipped span reports only the part inside the window. Scaling rather than
    // keeping the full figure is what stops a day's totals borrowing from its neighbour.
    const clipped = startMs !== rawStart || endMs !== rawEnd;
    const rawMs = rawEnd - rawStart;
    const seconds =
      clipped && rawMs > 0 ? Math.round(span.seconds * ((endMs - startMs) / rawMs)) : span.seconds;

    const start = clipped ? new Date(startMs).toISOString() : span.start;
    const end = clipped ? new Date(endMs).toISOString() : span.end;

    const naturalX = ((startMs - windowStart) / totalMs) * RIBBON_WIDTH;
    const naturalWidth = ((endMs - startMs) / totalMs) * RIBBON_WIDTH;
    const width = Math.min(Math.max(naturalWidth, minWidth), RIBBON_WIDTH);
    // Grow about the centre: a sliver widened only to the right would drift away from
    // the moment it actually happened.
    const x = Math.min(Math.max(naturalX - (width - naturalWidth) / 2, 0), RIBBON_WIDTH - width);

    segments.push({
      key: `${span.start}-${span.kind}-${index}`,
      kind: span.kind,
      start,
      end,
      seconds,
      x,
      width,
      naturalWidth,
      widthClamped: width > naturalWidth + 1e-9,
      label: spanLabel(span),
      showLabel: width >= LABEL_MIN_FRACTION * RIBBON_WIDTH,
      title: segmentTitle(span, start, end, seconds),
      appName: span.appName,
      appHue: span.appName ? appHue(span.appName) : null,
      paintOrder: 0,
    });
  }

  // Widest first, so anything the minimum-width rule inflated is drawn on top of the
  // neighbour it now overlaps instead of underneath it.
  const order = segments
    .map((segment, index) => ({ index, width: segment.naturalWidth }))
    .sort((a, b) => b.width - a.width);
  order.forEach((entry, rank) => {
    const segment = segments[entry.index];
    if (segment) segment.paintOrder = rank;
  });

  return segments;
}

export interface HourTick {
  at: string;
  x: number;
  /** Null when the tick is a gridline only — labels thin out before they overlap. */
  label: string | null;
}

export function hourTicks(window: TimelineWindow, options?: { maxLabels?: number }): HourTick[] {
  const windowStart = Date.parse(window.from);
  const windowEnd = Date.parse(window.to);
  const totalMs = windowEnd - windowStart;
  if (!Number.isFinite(totalMs) || totalMs <= 0) return [];

  const cursor = new Date(windowStart);
  cursor.setMinutes(0, 0, 0);
  if (cursor.getTime() < windowStart) cursor.setHours(cursor.getHours() + 1);

  const ticks: HourTick[] = [];
  while (cursor.getTime() <= windowEnd) {
    ticks.push({
      at: cursor.toISOString(),
      x: ((cursor.getTime() - windowStart) / totalMs) * RIBBON_WIDTH,
      label: cursor.toLocaleTimeString([], { hour: "numeric" }),
    });
    cursor.setHours(cursor.getHours() + 1);
  }

  const maxLabels = options?.maxLabels ?? 12;
  const step = Math.max(1, Math.ceil(ticks.length / maxLabels));
  return ticks.map((tick, index) => (index % step === 0 ? tick : { ...tick, label: null }));
}

/**
 * `app` never comes out of `railEvents` — the ribbon is where application stretches
 * belong. It exists for {@link fromLegacyEvents}, whose callers surface long app
 * spans as rail rows.
 */
export type RailEventKind = TimelineMarkerKind | "no-data" | "app";

export interface RailEvent {
  key: string;
  at: string;
  kind: RailEventKind;
  label: string;
  detail: string | null;
  /** Thumbnail for a screenshot row. Null when there is nothing renderable. */
  imageUrl: string | null;
  /** Full-resolution image behind the click. */
  fullUrl: string | null;
  /** A capture exists in the record but no URL could be produced for it. */
  captureUnavailable: boolean;
}

function screenshotIndex(slots: TimelineSlot[]): Map<number, TimelineScreenshot> {
  const index = new Map<number, TimelineScreenshot>();
  for (const slot of slots) {
    for (const shot of slot.screenshots) index.set(shot.id, shot);
  }
  return index;
}

/**
 * The rail: the day as a list of moments, which is exactly how scope §2.7 specifies it.
 *
 * Markers arrive render-ready from the server. The one thing added here is the
 * absence: a long offline stretch becomes a single "No data" row, because a
 * ninety-minute hole rendered as two adjacent rows of work is a lie of omission.
 */
export function railEvents(
  timeline: Pick<DayTimeline, "markers" | "spans" | "slots">,
  options?: { minGapSeconds?: number },
): RailEvent[] {
  const minGapSeconds = options?.minGapSeconds ?? MIN_GAP_SECONDS;
  const captures = screenshotIndex(timeline.slots);

  const fromMarkers: RailEvent[] = timeline.markers.map((marker, index) => {
    const capture = marker.screenshotId === null ? null : (captures.get(marker.screenshotId) ?? null);
    const imageUrl = capture ? (capture.thumbnailUrl ?? capture.url) : null;

    return {
      key: `m-${index}-${marker.at}`,
      at: marker.at,
      kind: marker.kind,
      label: marker.label,
      detail: marker.detail,
      imageUrl,
      fullUrl: capture ? (capture.url ?? capture.thumbnailUrl) : null,
      captureUnavailable: marker.kind === "screenshot" && imageUrl === null,
    };
  });

  const fromGaps: RailEvent[] = timeline.spans
    .filter((span) => span.kind === "offline" && span.seconds >= minGapSeconds)
    .map((span, index) => ({
      key: `g-${index}-${span.start}`,
      at: span.start,
      kind: "no-data" as const,
      label: "No data",
      detail: `${timeOfDay(span.start)} – ${timeOfDay(span.end)} · ${duration(span.seconds)}`,
      imageUrl: null,
      fullUrl: null,
      captureUnavailable: false,
    }));

  // Stable sort, markers listed before gaps at an identical instant: a clock-out reads
  // better above the silence it caused than below it.
  return [...fromMarkers, ...fromGaps].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * The rail shape this component exposed before the server-side reduction landed.
 *
 * @deprecated Pass a `DayTimeline` to `ActivityTimeline` instead. This survives only
 * because a caller reduces a `DayTimeline` into it themselves; it cannot express a
 * gap, a break or a duration, so a screen using it shows a strictly poorer day.
 */
export type TimelineEventKind = "session-start" | "app" | "screenshot" | "idle";

/** @deprecated See {@link TimelineEventKind}. */
export interface TimelineEvent {
  at: string;
  kind: TimelineEventKind;
  title: string;
  detail?: string | null;
  screenshotUrl?: string | null;
}

const LEGACY_KIND: Record<TimelineEventKind, RailEventKind> = {
  "session-start": "clock-in",
  app: "app",
  screenshot: "screenshot",
  idle: "idle-start",
};

/**
 * Adapts the deprecated event list onto the rail.
 *
 * `captureUnavailable` stays false throughout: the legacy shape has no concept of a
 * capture that exists but could not be signed, so flagging one would invent a fault
 * rather than report it.
 */
export function fromLegacyEvents(events: TimelineEvent[]): RailEvent[] {
  return events
    .map((event, index) => ({
      key: `l-${index}-${event.at}`,
      at: event.at,
      kind: LEGACY_KIND[event.kind],
      label: event.title,
      detail: event.detail ?? null,
      imageUrl: event.screenshotUrl ?? null,
      fullUrl: event.screenshotUrl ?? null,
      captureUnavailable: false,
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * The text alternative for the ribbon.
 *
 * An SVG of three hundred rectangles is unreadable to a screen reader however well
 * labelled each rect is, so the whole shape of the day is also stated in a sentence.
 * Deliberately no percentage: `docs/design.md` asks for descriptive work patterns.
 */
export function timelineSummary(timeline: DayTimeline): string {
  const { totals } = timeline;
  if (totals.trackedSeconds <= 0) return "No activity recorded for this day.";

  const parts: string[] = [];
  if (totals.activeSeconds > 0) parts.push(`${duration(totals.activeSeconds)} active`);
  if (totals.idleSeconds > 0) parts.push(`${duration(totals.idleSeconds)} idle`);
  if (totals.breakSeconds > 0) parts.push(`${duration(totals.breakSeconds)} on break`);

  const window = `${timeOfDay(timeline.periodStart)} to ${timeOfDay(timeline.periodEnd)}`;
  const head = `${window}: ${duration(totals.trackedSeconds)} tracked`;
  let text = parts.length > 0 ? `${head} — ${parts.join(", ")}.` : `${head}.`;
  if (totals.offlineSeconds > 0) text += ` ${duration(totals.offlineSeconds)} with no data.`;

  return text;
}

/** Day one of a demo has almost no data, and "nothing yet" must not look like a fault. */
export function isEmptyTimeline(timeline: DayTimeline | null | undefined): boolean {
  if (!timeline) return true;
  return timeline.totals.trackedSeconds <= 0 && timeline.markers.length === 0;
}

/**
 * Trims a day window at the present moment.
 *
 * Day *selection* belongs to the shared control in the employee page chrome, which
 * every tab reads, so there is deliberately no second day-arithmetic implementation
 * here. This is the one thing the ribbon needs that a plain calendar day does not
 * give it: the rest of today has not happened, and the timeline's whole premise is
 * that an absence of data is itself data — so an unclamped window would paint eight
 * unlived hours as a gap in someone's day.
 *
 * A window it cannot parse is returned untouched: guessing would be worse than
 * deferring to whatever produced it.
 */
export function clampWindowToNow(window: TimelineWindow, now: Date): TimelineWindow {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return window;

  const nowMs = now.getTime();
  if (nowMs >= to) return window;

  return { from: window.from, to: new Date(Math.max(from, nowMs)).toISOString() };
}
