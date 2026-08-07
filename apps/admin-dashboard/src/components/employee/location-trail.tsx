"use client";

import { cn } from "@aems/ui";
import { ExternalLink } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";

import type { LocationPoint } from "@/app/(app)/people/[profileId]/devices/device-queries";
import { duration } from "@/lib/format";

import {
  distanceCoveredMetres,
  formatDistance,
  groupIntoStops,
  mapHref,
  type LocationStop,
} from "./location-stops";

/**
 * The day's movement, as places rather than pings.
 *
 * Nine rows of the same coordinate is the same fact nine times. Grouping consecutive
 * nearby fixes into stops is what turns a sample log into something a manager can read
 * in one pass — and at 480 samples for an eight-hour shift it is the difference
 * between a usable screen and an unusable one.
 *
 * The slider narrows to a window inside the day. A trail is nearly always read to
 * answer "where were they at about four", and scrolling a list to find a timestamp is
 * a worse way to ask that than dragging to it.
 */
/**
 * Loaded only when somebody switches to the map, and never on the server.
 *
 * Leaflet reaches for `window` at import time, so it cannot be server-rendered —
 * `ssr: false` is a requirement, not a preference. `dynamic` also keeps the mapping
 * library and its stylesheet out of the bundle for every reader who never presses the
 * switch, which is most of them: this is the only screen in the product that loads a
 * map, and the only one that talks to a tile server.
 */
const TrailMap = dynamic(() => import("./trail-map"), {
  ssr: false,
  loading: () => (
    <div className="border-t px-4 py-4 sm:px-5">
      <div className="h-[420px] w-full animate-pulse rounded-md border bg-muted" aria-hidden />
    </div>
  ),
});

export function LocationTrail({ points }: { points: readonly LocationPoint[] }) {
  const stops = useMemo(() => groupIntoStops(points), [points]);

  // Oldest first for the slider's own axis, so dragging right moves forward in time —
  // the opposite of the list below, which is newest-first like everything else here.
  const times = useMemo(
    () => [...points].map((p) => Date.parse(p.recordedAt)).sort((a, b) => a - b),
    [points],
  );
  const first = times[0] ?? 0;
  const last = times[times.length - 1] ?? 0;

  const [fromMs, setFromMs] = useState<number | null>(null);
  const [view, setView] = useState<"list" | "map">("list");
  const cutoff = fromMs ?? first;

  const visible = stops.filter((stop) => Date.parse(stop.toIso) >= cutoff);
  const span = last - first;
  const covered = distanceCoveredMetres(visible);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5 sm:px-5">
        {/* "At least", never a bare number. This is straight lines between the places
            the phone was seen, so a curving road is under-counted and a trip out and
            back between two samples is invisible. Presenting an estimate as an
            odometer reading is the kind of wrongness this product cannot afford. */}
        <span className="text-xs text-muted-foreground">
          {visible.length} {visible.length === 1 ? "place" : "places"} ·{" "}
          {covered === 0 ? (
            "stayed in one place"
          ) : (
            <>
              at least <span className="tabular font-medium">{formatDistance(covered)}</span>{" "}
              covered
            </>
          )}
        </span>

        <div className="flex shrink-0 items-center gap-1 rounded-md border p-0.5" role="group">
          {(["list", "map"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setView(option)}
              aria-pressed={view === option}
              className={cn(
                "rounded px-2 py-1 text-xs capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                view === option
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      {/* Hidden when the day is one moment wide: a slider whose ends are the same
          instant is a control that cannot do anything. */}
      {span > 0 ? (
        <div className="flex items-center gap-3 border-t px-4 py-3 sm:px-5">
          <label htmlFor="trail-from" className="shrink-0 text-xs text-muted-foreground">
            From
          </label>
          <input
            id="trail-from"
            type="range"
            min={first}
            max={last}
            step={60_000}
            value={cutoff}
            onChange={(event) => setFromMs(Number(event.target.value))}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-[hsl(var(--primary))]"
          />
          <span className="tabular w-16 shrink-0 text-right text-xs text-muted-foreground">
            {shortTime(new Date(cutoff).toISOString())}
          </span>
          {fromMs !== null ? (
            <button
              type="button"
              onClick={() => setFromMs(null)}
              className="shrink-0 rounded text-xs underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Whole day
            </button>
          ) : null}
        </div>
      ) : null}

      {view === "map" ? <TrailMap stops={visible} /> : null}

      <ul className={cn("divide-y border-t", view === "map" && "sr-only")}>
        {visible.map((stop) => {
          const fromMsStop = Date.parse(stop.fromIso);
          const toMsStop = Date.parse(stop.toIso);
          const held = Math.max(0, Math.round((toMsStop - fromMsStop) / 1000));

          return (
            <li
              key={stop.fromIso}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-xs sm:px-5"
            >
              <span className="tabular w-28 shrink-0 text-muted-foreground">
                {shortTime(stop.fromIso)}
                {stop.points > 1 ? ` – ${shortTime(stop.toIso)}` : ""}
              </span>

              {/* The coordinate stays, and the link is what turns it into a place. A
                  stored place name would mean sending an employee's position to a
                  geocoder on our side; a link sends nothing until a manager clicks it,
                  and then it is their browser asking, not ours. */}
              <a
                href={mapHref(stop.latitude, stop.longitude)}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-w-0 items-center gap-1 rounded font-mono underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="truncate">
                  {stop.latitude.toFixed(5)}, {stop.longitude.toFixed(5)}
                </span>
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
              </a>

              {held > 0 ? (
                <span className="text-muted-foreground">stayed {duration(held)}</span>
              ) : null}

              {/* A fix good to 2km and one good to 5m are not the same claim, and a
                  reader deciding where somebody was needs to know which. */}
              {stop.accuracyM === null ? null : (
                <span className="tabular ml-auto shrink-0 text-muted-foreground">
                  ±{Math.round(stop.accuracyM)}m
                  {stop.points > 1 ? ` · ${String(stop.points)} fixes` : ""}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {visible.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
          Nothing recorded after {shortTime(new Date(cutoff).toISOString())}.
        </p>
      ) : null}
    </div>
  );
}

/** "14:05" in the reader's zone. Seconds are noise on a movement trail. */
function shortTime(iso: string | undefined): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
}
