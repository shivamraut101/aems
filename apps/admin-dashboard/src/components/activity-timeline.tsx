"use client";

import type { DayTimeline } from "@aems/types";
import { AlertTriangle } from "lucide-react";

import { EmptyState, ErrorState } from "@/components/states";
import { DayRibbon, RibbonLegend } from "@/components/timeline/day-ribbon";
import { EventRail } from "@/components/timeline/event-rail";
import {
  fromLegacyEvents,
  isEmptyTimeline,
  railEvents,
  type RailEvent,
  type TimelineEvent,
} from "@/components/timeline/model";
import { describeError } from "@/lib/api";
import { duration, timeOfDay } from "@/lib/format";

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
 * The two are drawn as one instrument rather than as two stacked panels: the day card
 * leads with the sentence a manager actually came for, puts the ribbon directly under
 * it, and demotes the five figures to supporting evidence beneath a rule — the same
 * shape the Overview's verdict block uses. Every moment in the rail below also gets a
 * notch on the ribbon's lower edge, so the list and the picture describe the same
 * instants instead of sitting next to each other unrelated.
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
      <ErrorState
        title="This day could not be loaded"
        message={describeError(error)}
        {...(onRetry ? { onRetry } : {})}
      />
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
    <div className="space-y-6">
      <DayCard timeline={day} moments={railRows} />

      <section>
        <h3 className="mb-3 flex flex-wrap items-baseline gap-x-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          Moments
          <span className="tabular font-normal normal-case tracking-normal">
            {railRows.length === 0
              ? "none recorded"
              : `${railRows.length} in this window`}
          </span>
        </h3>
        <EventRail events={railRows} />
      </section>
    </div>
  );
}

/**
 * The day, answered before it is measured.
 *
 * `docs/design.md` calls this screen the product's differentiator, and what a manager
 * opens it to find out is "how did this day go?" — not "what are five durations?".
 * So the headline is the conclusion, the ribbon is the evidence, and scope §2.2's four
 * numbers plus the absence sit under a rule as support. The figures are still all here:
 * leading with a conclusion is not the same as hiding what it was drawn from.
 */
function DayCard({ timeline, moments }: { timeline: DayTimeline; moments: RailEvent[] }) {
  const { totals } = timeline;
  const ratio =
    totals.activityRatio === null
      ? undefined
      : `${Math.round(totals.activityRatio * 100)}% of tracked time was active`;

  /*
   * Active is split three ways, not shown as one number.
   *
   * `docs/inspiration.md` argues that forcing every worked second into productive-or-
   * idle is unfair to the person being measured, and that the honest third bucket is
   * *neutral* — in use, and we cannot fairly call it either way. Uncategorised activity
   * lands there too, deliberately: an application nobody wrote a rule for is evidence
   * of nothing.
   *
   * The three sum to `activeSeconds` exactly, so "Active" stays as the total above them
   * and the breakdown can be trusted to add up.
   */
  const figures = [
    { label: "Tracked", value: totals.trackedSeconds, hint: undefined },
    { label: "Active", value: totals.activeSeconds, hint: ratio },
    {
      label: "Productive",
      value: totals.productiveSeconds,
      hint: "Active time in applications your rules call productive",
    },
    {
      label: "Neutral",
      value: totals.neutralSeconds,
      hint: "In use, but not scored either way — including anything no rule covers",
    },
    { label: "Idle", value: totals.idleSeconds, hint: undefined },
    { label: "Break", value: totals.breakSeconds, hint: undefined },
    {
      label: "No data",
      value: totals.offlineSeconds,
      hint: "No device reported in this time",
    },
  ];

  return (
    <section
      aria-label="This day at a glance"
      className="rounded-lg border bg-card p-4 shadow-[var(--shadow-sm)] sm:p-5"
    >
      <h2 className="tabular text-xl font-semibold tracking-[-0.02em] sm:text-[26px]">
        {duration(totals.activeSeconds)} active of {duration(totals.trackedSeconds)} tracked
      </h2>
      <p className="mt-2 max-w-[64ch] text-sm text-muted-foreground">
        {daySentence(timeline)}
      </p>

      {/* Placed above the ribbon rather than below it: it qualifies every number and
          every band in this card, and a caveat read after the evidence is a caveat
          read too late. Alpha is written into the token's own utility rather than as
          an arbitrary `hsl(var(--x))/40`, which Tailwind cannot reliably give an
          alpha channel to. */}
      {timeline.truncated ? (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <span>
            This day hit the row limit, so only the earliest part of it is shown. Every
            figure here is a floor, not a total.
          </span>
        </p>
      ) : null}

      {/* Wide content scrolls in its own container; the page body never moves sideways.
          The legend stays outside the scroller so it wraps to the phone's width instead
          of hiding the key to the picture behind a sideways drag. */}
      <div className="mt-5 overflow-x-auto">
        <div className="min-w-[36rem]">
          <DayRibbon timeline={timeline} moments={moments} />
        </div>
      </div>
      <RibbonLegend className="mt-2.5" showMoments={moments.length > 0} />

      <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-3 border-t pt-4">
        {figures.map((figure) => (
          <div key={figure.label} {...(figure.hint ? { title: figure.hint } : {})}>
            <dd className="tabular text-base font-semibold tracking-[-0.02em] sm:text-[17px]">
              {duration(figure.value)}
            </dd>
            <dt className="text-[11px] text-muted-foreground">{figure.label}</dt>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** "a, b and c", in the reader's own locale. Hoisted because the formatter is reusable. */
const LIST = new Intl.ListFormat(undefined, { style: "long", type: "conjunction" });

/**
 * The sentence under the headline.
 *
 * Says what the measured window was and what else was inside it. "Measured from" rather
 * than "recorded between", because the window is the span this screen *asked* about —
 * local midnight to now on a live day — and most of it may hold nothing at all.
 *
 * Deliberately no percentage and no verdict about the person: `docs/design.md` asks for
 * descriptive work patterns, and the one screen where a manager reads a named
 * individual's whole day is the last place a score belongs.
 */
function daySentence(timeline: DayTimeline): string {
  const { totals } = timeline;
  const window = `${timeOfDay(timeline.periodStart)} to ${timeOfDay(timeline.periodEnd)}`;

  const rest: string[] = [];
  if (totals.idleSeconds > 0) rest.push(`${duration(totals.idleSeconds)} idle`);
  if (totals.breakSeconds > 0) rest.push(`${duration(totals.breakSeconds)} on a declared break`);
  if (totals.offlineSeconds > 0) {
    rest.push(`${duration(totals.offlineSeconds)} with no device reporting`);
  }

  if (rest.length === 0) return `Measured from ${window}.`;
  return `Measured from ${window}, with ${LIST.format(rest)}.`;
}

/** A real empty state: day one of a demo has no data, and that must not read as a fault. */
function EmptyDay({ hint }: { hint?: string }) {
  return (
    <EmptyState
      title="Nothing recorded for this day"
      body={
        hint ??
        "Activity appears here once the agent reports its first session for this window."
      }
    />
  );
}

/** Shown while the day is in flight, and as the page's Suspense fallback. */
export function TimelineSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the day…</span>

      {/* Same card, same order, same heights, so the real reading lands where the
          placeholder stood rather than shunting the ribbon down the page. */}
      <div className="rounded-lg border bg-card p-4 shadow-[var(--shadow-sm)] sm:p-5">
        <span className="block h-7 w-64 max-w-full animate-pulse rounded bg-muted" />
        <span className="mt-3 block h-4 w-4/5 max-w-md animate-pulse rounded bg-muted" />
        <span className="mt-5 block h-11 w-full animate-pulse rounded-md bg-muted" />
        <div className="mt-5 flex flex-wrap gap-x-8 gap-y-3 border-t pt-4">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="space-y-1.5">
              <span className="block h-5 w-16 animate-pulse rounded bg-muted" />
              <span className="block h-3 w-12 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>

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
