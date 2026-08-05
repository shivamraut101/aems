"use client";

import { cn } from "@aems/ui";
import {
  Activity,
  Camera,
  CircleSlash,
  Coffee,
  CupSoda,
  Monitor,
  Pause,
  Play,
  Square,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { timeOfDay } from "@/lib/format";

import type { RailEvent, RailEventKind } from "./model";

const ICON: Record<RailEventKind, LucideIcon> = {
  "clock-in": Play,
  "clock-out": Square,
  "break-start": Coffee,
  "break-end": CupSoda,
  "idle-start": Pause,
  "active-again": Activity,
  screenshot: Camera,
  "no-data": CircleSlash,
  app: Monitor,
};

/**
 * Bubble tone per moment.
 *
 * Navy on emerald and navy on amber, not white: at 14px an icon needs the contrast.
 * The screenshot bubble is `secondary` — it used to be `bg-accent`, which is the
 * indigo `docs/design.md` reserves for AI output, and a camera icon is a recorded
 * fact rather than a model's opinion.
 */
const TONE: Record<RailEventKind, string> = {
  "clock-in": "bg-[hsl(var(--success))] text-slate-900",
  "clock-out": "bg-secondary text-foreground",
  "break-start": "bg-secondary text-muted-foreground",
  "break-end": "bg-secondary text-muted-foreground",
  "idle-start": "bg-[hsl(var(--warning))] text-slate-900",
  "active-again": "bg-[hsl(var(--success))] text-slate-900",
  screenshot: "bg-secondary text-foreground",
  "no-data": "border border-dashed bg-background text-muted-foreground",
  app: "bg-secondary text-muted-foreground",
};

/**
 * The event rail — the day as a list of moments, which is how scope §2.7 writes it.
 *
 * One continuous line rather than a stack of cards, because what a manager is reading
 * is the shape of the day: where the gaps are, what sat next to what. Screenshots hang
 * off the moment they belong to instead of a separate gallery, so evidence always
 * arrives with its context.
 */
export function EventRail({ events }: { events: RailEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        No individual moments recorded — no sign-in, break or capture reached the server
        for this window.
      </p>
    );
  }

  return (
    <ol className="relative">
      {events.map((event, index) => {
        const Icon = ICON[event.kind];
        const isLast = index === events.length - 1;

        return (
          <li key={event.key} className="relative flex gap-4 pb-5 last:pb-0">
            {/* Hidden on the final row so the line stops at the last moment rather
                than trailing into empty space. */}
            {!isLast ? (
              <span className="absolute left-[13px] top-7 bottom-0 w-px bg-border" aria-hidden />
            ) : null}

            <span
              className={cn(
                "relative z-10 mt-0.5 grid h-[27px] w-[27px] shrink-0 place-items-center rounded-full border-2 border-background",
                TONE[event.kind],
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
            </span>

            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <time
                  dateTime={event.at}
                  className="tabular text-xs font-medium text-muted-foreground"
                >
                  {timeOfDay(event.at)}
                </time>
                <span className="text-sm font-medium">{event.label}</span>
                {event.detail ? (
                  <span className="truncate text-sm text-muted-foreground">{event.detail}</span>
                ) : null}
              </div>

              {event.imageUrl ? (
                <a
                  href={event.fullUrl ?? event.imageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <img
                    src={event.imageUrl}
                    alt={`Screen capture at ${timeOfDay(event.at)}. Opens full size in a new tab.`}
                    loading="lazy"
                    className="max-w-[18rem] rounded-md border"
                  />
                </a>
              ) : event.captureUnavailable ? (
                // The record says a capture exists but no URL could be signed for it.
                // Saying so beats a broken image icon, which reads as our bug.
                <p className="mt-1.5 inline-block rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground">
                  Capture unavailable
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
