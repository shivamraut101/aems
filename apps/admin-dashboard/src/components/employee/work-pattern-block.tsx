"use client";

import { cn } from "@aems/ui";

import { duration } from "@/lib/format";

import { EmptyState, Panel, SectionHeading } from "./states";
import type { WorkPattern, WorkPatternKey } from "./work-pattern";

/**
 * Tone per line.
 *
 * Emerald for work — solid for focused time, lighter for collaboration, so the two
 * read as the same family. Amber for idle, matching the status dot and the timeline
 * ribbon. Muted for everything we cannot name.
 *
 * Never indigo: `--accent` is reserved for AI surfaces across the whole product so a
 * reader can tell model output from recorded fact. Never Apploye's red band either —
 * a red block beside somebody's name is the framing the positioning rule forbids.
 */
const TONE: Record<WorkPatternKey, string> = {
  focus: "bg-success",
  collaboration: "bg-success/45",
  other: "bg-muted-foreground/45",
  uncategorized: "bg-muted-foreground/20",
  break: "bg-muted-foreground/30",
  idle: "bg-warning",
};

/**
 * docs/design.md's Work Pattern block, in place of a productivity score.
 *
 * The bar is decoration and is hidden from assistive technology; the list underneath
 * carries every figure. Colour is never the only signal — each line has a swatch, a
 * name and a duration.
 */
export function WorkPatternBlock({ pattern }: { pattern: WorkPattern }) {
  const { rows, trackedSeconds } = pattern;

  return (
    <Panel>
      <SectionHeading
        title="Work pattern"
        hint="How the tracked time divides, by what the work was."
      />

      {trackedSeconds === 0 ? (
        <EmptyState
          title="Nothing tracked on this day"
          body="No work session was recorded, so there is no pattern to describe yet."
        />
      ) : (
        <>
          <div
            aria-hidden
            title={
              pattern.activeSeconds > 0
                ? `Active for ${Math.round((pattern.activeSeconds / trackedSeconds) * 100)}% of tracked time`
                : undefined
            }
            className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
          >
            {rows.map((row) =>
              row.seconds > 0 ? (
                <span
                  key={row.key}
                  className={cn("h-full", TONE[row.key])}
                  style={{ width: `${row.share * 100}%` }}
                />
              ) : null,
            )}
          </div>

          <dl className="mt-4 space-y-2.5">
            {rows.map((row) => (
              <div
                key={row.key}
                className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3"
              >
                <span
                  aria-hidden
                  className={cn("h-2 w-2 translate-y-px rounded-full", TONE[row.key])}
                />
                <dt className="min-w-0 text-sm">
                  {row.label}
                  {row.detail ? (
                    <span className="ml-2 truncate text-xs text-muted-foreground">
                      {row.detail}
                    </span>
                  ) : null}
                </dt>
                <dd className="tabular text-sm font-semibold">{duration(row.seconds)}</dd>
              </div>
            ))}
          </dl>

          {pattern.unclassified ? (
            <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
              None of this activity matched a category rule yet, so it cannot be
              described as focused work or collaboration. Adding rules in Settings
              relabels the history already recorded — nothing needs recollecting.
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}
