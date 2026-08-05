"use client";

import type { DayTimeline } from "@aems/types";

import { duration, timeOfDay } from "@/lib/format";

import {
  RIBBON_WIDTH,
  SPAN_FILL,
  SPAN_LABEL_FILL,
  buildRibbon,
  hourTicks,
  timelineSummary,
} from "./model";

/** viewBox-free rendering: `x` and `width` become percentages of the container. */
function percent(value: number): string {
  return `${(value / RIBBON_WIDTH) * 100}%`;
}

/**
 * The day ribbon — one proportional rectangle per reduced span.
 *
 * Deliberately no `viewBox` with `preserveAspectRatio="none"`, which is how
 * ActivityWatch scales theirs: a non-uniform scale shears every pattern and stretches
 * every glyph inside the SVG. Percentage geometry gets the same proportional layout
 * with undistorted hatching, 1px strokes and crisp HTML labels on top.
 *
 * The ribbon is `role="img"` rather than a grid of focusable rects. Three hundred tab
 * stops is not accessibility; the summary sentence, the visually-hidden table below
 * and the event rail beside it are what actually make the day readable without sight.
 */
export function DayRibbon({ timeline }: { timeline: DayTimeline }) {
  const window = { from: timeline.periodStart, to: timeline.periodEnd };
  const segments = buildRibbon(timeline.spans, window);
  const ticks = hourTicks(window);
  const summary = timelineSummary(timeline);

  // Narrow segments last: the minimum-width rule makes a sliver overlap its
  // neighbour, and it has to win that overlap or the clamp achieves nothing.
  const painted = [...segments].sort((a, b) => a.paintOrder - b.paintOrder);

  return (
    <figure className="m-0">
      <div className="relative select-none">
        <div className="relative h-4" aria-hidden>
          {ticks.map((tick) =>
            tick.label === null ? null : (
              <span
                key={tick.at}
                className="tabular absolute top-0 -translate-x-1/2 text-[11px] leading-4 text-muted-foreground"
                style={{ left: percent(tick.x) }}
              >
                {tick.label}
              </span>
            ),
          )}
        </div>

        <div className="relative overflow-hidden rounded-md border bg-card">
          <svg
            className="block h-11 w-full"
            role="img"
            aria-label={summary}
            shapeRendering="crispEdges"
          >
            <defs>
              {/*
                Two ribbons on one page share these ids. The definitions are identical,
                so the first-match resolution browsers use renders both correctly.
              */}
              <pattern
                id="aems-timeline-nodata"
                width="8"
                height="8"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="8" height="8" fill="transparent" />
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="8"
                  stroke="hsl(var(--muted-foreground))"
                  strokeWidth="1.5"
                  opacity="0.35"
                />
              </pattern>

              <pattern
                id="aems-timeline-switching"
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="6" height="6" fill="hsl(var(--success))" />
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="6"
                  stroke="hsl(222 47% 11%)"
                  strokeWidth="1.5"
                  opacity="0.28"
                />
              </pattern>
            </defs>

            {painted.map((segment) => (
              <rect
                key={segment.key}
                x={percent(segment.x)}
                width={percent(segment.width)}
                y="0"
                height="100%"
                fill={SPAN_FILL[segment.kind]}
                className="transition-opacity hover:opacity-80"
              >
                <title>{segment.title}</title>
              </rect>
            ))}

            {ticks.map((tick) => (
              <line
                key={`tick-${tick.at}`}
                x1={percent(tick.x)}
                x2={percent(tick.x)}
                y1="0"
                y2="100%"
                stroke="hsl(var(--border))"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                opacity="0.7"
              />
            ))}
          </svg>

          {/*
            Labels as HTML rather than <text>: CSS truncation inside a span's own width
            is one line here and a per-segment <clipPath> in SVG.
          */}
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            {segments
              .filter((segment) => segment.showLabel)
              .map((segment) => (
                <span
                  key={`label-${segment.key}`}
                  className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 overflow-hidden px-1.5 text-[11px] font-medium leading-none"
                  style={{
                    left: percent(segment.x),
                    width: percent(segment.width),
                    color: SPAN_LABEL_FILL[segment.kind],
                  }}
                >
                  {segment.appHue === null ? null : (
                    // Identity, the secondary channel: state is already carried by the
                    // fill, so the app only needs to be distinguishable, not encoded.
                    <span
                      className="h-2 w-2 shrink-0 rounded-[2px] ring-1 ring-inset ring-black/20"
                      style={{ background: `hsl(${segment.appHue} 62% 46%)` }}
                    />
                  )}
                  <span className="truncate">{segment.label}</span>
                </span>
              ))}
          </div>
        </div>
      </div>

      <figcaption className="sr-only">{summary}</figcaption>

      {/*
        The text alternative. An SVG cannot be read span by span however well each rect
        is titled, so the same data is also a table — real markup, not a paragraph, so
        a screen reader can move through it row by row.
      */}
      <table className="sr-only">
        <caption>Activity spans for this day</caption>
        <thead>
          <tr>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">Activity</th>
            <th scope="col">Duration</th>
          </tr>
        </thead>
        <tbody>
          {segments.map((segment) => (
            <tr key={`row-${segment.key}`}>
              <td>{timeOfDay(segment.start)}</td>
              <td>{timeOfDay(segment.end)}</td>
              <td>{segment.label}</td>
              <td>{duration(segment.seconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

const LEGEND = [
  { label: "Active", swatch: "hsl(var(--success))" },
  {
    label: "Rapid switching",
    swatch:
      "repeating-linear-gradient(45deg, hsl(var(--success)) 0 4px, hsl(222 47% 11% / 0.28) 4px 6px)",
  },
  { label: "Idle", swatch: "hsl(var(--warning))" },
  { label: "Break", swatch: "hsl(var(--muted-foreground) / 0.25)" },
  {
    label: "No data",
    swatch:
      "repeating-linear-gradient(45deg, transparent 0 5px, hsl(var(--muted-foreground) / 0.35) 5px 7px)",
  },
] as const;

/** Names the fills. Without it the ribbon is a colour code nobody was given a key to. */
export function RibbonLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {LEGEND.map((entry) => (
        <li key={entry.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className="h-2.5 w-2.5 rounded-[2px] border"
            style={{ background: entry.swatch }}
            aria-hidden
          />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}
