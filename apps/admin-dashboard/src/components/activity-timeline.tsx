"use client";

import type { DayTimeline } from "@aems/types";
import { AlertTriangle } from "lucide-react";

import { DayRibbon, RibbonLegend } from "@/components/timeline/day-ribbon";
import { EventRail } from "@/components/timeline/event-rail";
import {
  fromLegacyEvents,
  isEmptyTimeline,
  railEvents,
  type TimelineEvent,
} from "@/components/timeline/model";
import { describeError } from "@/lib/api";
import { duration } from "@/lib/format";

export type { TimelineEvent, TimelineEventKind } from "@/components/timeline/model";

export interface ActivityTimelineProps {
  /** A `DayTimeline` from `GET /api/analytics/timeline`. */
  timeline?: DayTimeline | null;
  /**
   * @deprecated Pass `timeline` instead.
   *
   * Renders the rail alone from a pre-reduced event list. Kept for the screen that
   * was built against the previous prop while this one was being rewritten — it
   * cannot draw the ribbon, so a caller using it loses gaps, breaks and proportion.
   */
  events?: TimelineEvent[];
  isLoading?: boolean;
  isError?: boolean;
  /** The thrown value. Rendered through `describeError`, never `error.message`. */
  error?: unknown;
  onRetry?: () => void;
  /** Second line of the empty state — usually which day is being looked at. */
  emptyHint?: string;
}

/**
 * The activity timeline: the product's differentiator per `docs/design.md`.
 *
 * Two layers over one window. The **ribbon** is proportional state — where the day
 * went — and the **rail** is the moments inside it: sign-in, break, capture, the
 * stretches where nothing reported at all. They are separate because they answer
 * separate questions, and because scope §2.7 is written as a list of instants while
 * §2.2 is written as a set of durations.
 *
 * Owns its own loading, error and empty states so every caller renders the same
 * three, rather than each screen inventing its own version of "no data yet".
 */
export function ActivityTimeline({
  timeline,
  events,
  isLoading = false,
  isError = false,
  error,
  onRetry,
  emptyHint,
}: ActivityTimelineProps) {
  if (isLoading) return <TimelineSkeleton />;

  if (isError) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-8 text-center">
        <p className="text-sm font-medium">This day could not be loaded</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {describeError(error)}
        </p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  // Deprecated path: rail only, because a pre-reduced event list has no spans to
  // draw a ribbon from.
  if (!timeline && events) {
    return events.length === 0 ? (
      <EmptyDay hint={emptyHint} />
    ) : (
      <EventRail events={fromLegacyEvents(events)} />
    );
  }

  if (isEmptyTimeline(timeline)) return <EmptyDay hint={emptyHint} />;

  // `isEmptyTimeline` has already excluded null and undefined.
  const day = timeline as DayTimeline;
  const railRows = railEvents(day);

  return (
    <div className="space-y-5">
      <TotalsStrip timeline={day} />

      {/* Alpha is written into the arbitrary value rather than as a `/40` modifier:
          Tailwind cannot reliably inject an alpha channel into `hsl(var(--x))`. */}
      {day.truncated ? (
        <p className="flex items-start gap-2 rounded-md border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.1)] px-3 py-2 text-sm">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--warning))]"
            aria-hidden
          />
          <span>
            This day hit the row limit, so only the earliest part of it is shown. Every
            figure above is a floor, not a total.
          </span>
        </p>
      ) : null}

      {/* Wide content scrolls in its own container; the page body never moves sideways. */}
      <div className="overflow-x-auto">
        <div className="min-w-[36rem] space-y-2">
          <DayRibbon timeline={day} />
          <RibbonLegend />
        </div>
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold">Moments</h3>
        <EventRail events={railRows} />
      </div>
    </div>
  );
}

/** A real empty state: day one of a demo has no data, and that must not read as a fault. */
function EmptyDay({ hint }: { hint?: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-12 text-center">
      <p className="text-sm font-medium">Nothing recorded for this day</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        {hint ?? "Activity appears here once the agent reports its first session for this window."}
      </p>
    </div>
  );
}

/**
 * Scope §2.2's four numbers, plus the absence.
 *
 * A row of definitions rather than four cards: `docs/design.md` is explicit that cards
 * are for KPIs and that not everything is one. `activityRatio` stays in the tooltip —
 * "Active 7h 30m" is a work pattern, "86%" is a score.
 */
function TotalsStrip({ timeline }: { timeline: DayTimeline }) {
  const { totals } = timeline;
  const ratio =
    totals.activityRatio === null
      ? undefined
      : `${Math.round(totals.activityRatio * 100)}% of tracked time was active`;

  const items = [
    { label: "Tracked", value: totals.trackedSeconds, hint: undefined },
    { label: "Active", value: totals.activeSeconds, hint: ratio },
    { label: "Idle", value: totals.idleSeconds, hint: undefined },
    { label: "Break", value: totals.breakSeconds, hint: undefined },
    { label: "No data", value: totals.offlineSeconds, hint: "No device reported in this time" },
  ];

  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-3 rounded-lg border bg-card px-4 py-3">
      {items.map((item) => (
        <div key={item.label} {...(item.hint ? { title: item.hint } : {})}>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {item.label}
          </dt>
          <dd className="tabular mt-0.5 text-lg font-semibold leading-none">
            {duration(item.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Shown while the day is in flight, and as the page's Suspense fallback. */
export function TimelineSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the day…</span>
      <div className="flex flex-wrap gap-x-8 gap-y-3 rounded-lg border bg-card px-4 py-3">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="space-y-1.5">
            <span className="block h-3 w-14 animate-pulse rounded bg-muted" />
            <span className="block h-5 w-16 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
      <span className="block h-11 w-full animate-pulse rounded-md border bg-muted" />
      <div className="space-y-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex gap-4">
            <span className="h-[27px] w-[27px] shrink-0 animate-pulse rounded-full bg-muted" />
            <span className="mt-1.5 h-4 w-1/3 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
