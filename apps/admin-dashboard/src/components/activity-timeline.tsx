"use client";

import type { TimelineEntry } from "@aems/types";
import { cn } from "@aems/ui";
import { Camera, Coffee, Monitor, Play } from "lucide-react";

import { duration, timeOfDay } from "@/lib/format";

export type TimelineEventKind = "session-start" | "app" | "screenshot" | "idle";

export interface TimelineEvent {
  at: string;
  kind: TimelineEventKind;
  title: string;
  detail?: string | null;
  screenshotUrl?: string | null;
}

const ICON = {
  "session-start": Play,
  app: Monitor,
  screenshot: Camera,
  idle: Coffee,
} as const;

const RAIL_TONE = {
  "session-start": "bg-[hsl(var(--success))]",
  app: "bg-border",
  screenshot: "bg-accent",
  idle: "bg-[hsl(var(--warning))]",
} as const;

/**
 * The activity timeline — the centrepiece of the employee page.
 *
 * Built as one continuous rail rather than a stack of cards, because the thing a
 * manager is reading is the *shape* of the day: where the gaps are, how long each
 * stretch ran, what sat next to what. Cards would slice that continuity into
 * unrelated boxes.
 *
 * Screenshots are attached to the event they belong to instead of living in a
 * separate gallery, so evidence always arrives with its context.
 */
export function ActivityTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-lg border bg-card px-4 py-10 text-center">
        <p className="text-sm font-medium">Nothing recorded for this day</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Activity appears here once the agent reports its first session.
        </p>
      </div>
    );
  }

  return (
    <ol className="relative">
      {events.map((event, index) => {
        const Icon = ICON[event.kind];
        const isLast = index === events.length - 1;

        return (
          <li key={`${event.at}-${index}`} className="relative flex gap-4 pb-5 last:pb-0">
            {/* Continuous rail. Hidden on the final row so the line stops at the
                last event rather than trailing into empty space. */}
            {!isLast ? (
              <span
                className="absolute left-[13px] top-7 bottom-0 w-px bg-border"
                aria-hidden
              />
            ) : null}

            <span
              className={cn(
                "relative z-10 mt-0.5 grid h-[27px] w-[27px] shrink-0 place-items-center rounded-full border-2 border-background",
                RAIL_TONE[event.kind],
                event.kind === "app" && "bg-secondary",
              )}
            >
              <Icon
                className={cn(
                  "h-3.5 w-3.5",
                  event.kind === "screenshot" && "text-accent-foreground",
                  event.kind === "session-start" && "text-white",
                  event.kind === "idle" && "text-white",
                  event.kind === "app" && "text-muted-foreground",
                )}
                aria-hidden
              />
            </span>

            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <time
                  dateTime={event.at}
                  className="tabular text-xs font-medium text-muted-foreground"
                >
                  {timeOfDay(event.at)}
                </time>
                <span className="text-sm font-medium">{event.title}</span>
                {event.detail ? (
                  <span className="truncate text-sm text-muted-foreground">{event.detail}</span>
                ) : null}
              </div>

              {event.screenshotUrl ? (
                <img
                  src={event.screenshotUrl}
                  alt={`Screen capture at ${timeOfDay(event.at)}`}
                  loading="lazy"
                  className="mt-2 max-w-sm rounded-md border"
                />
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Turns API timeline buckets into rail events. */
export function bucketsToEvents(buckets: TimelineEntry[]): TimelineEvent[] {
  return buckets
    .filter((bucket) => bucket.activeSeconds > 0 || bucket.idleSeconds > 0)
    .map((bucket) => ({
      at: bucket.periodStart,
      kind: bucket.idleSeconds > bucket.activeSeconds ? ("idle" as const) : ("app" as const),
      title: bucket.topApp ?? "Idle",
      detail:
        bucket.idleSeconds > bucket.activeSeconds
          ? `Idle ${duration(bucket.idleSeconds)}`
          : `Active ${duration(bucket.activeSeconds)}`,
    }));
}
