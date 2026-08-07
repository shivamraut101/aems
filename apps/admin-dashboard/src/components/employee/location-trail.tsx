"use client";

import { cn } from "@aems/ui";
import { ExternalLink } from "lucide-react";
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

/**
 * The day's path, drawn as inline SVG rather than on tiles.
 *
 * No map library and no tile requests, which is a deliberate trade with a real cost:
 * this shows the *shape* of a day's movement — where the stops were relative to each
 * other, in what order, how far apart — and no streets. Street context comes from the
 * per-stop OpenStreetMap link, which is reader-initiated.
 *
 * The reason is not bundle size. An embedded tile map fetches from a third party on
 * every render, with an employee's coordinates in the request, whether or not anybody
 * looked. That is a different privacy posture from a link somebody chooses to click,
 * and on the most sensitive screen in this product it is the client's call rather than
 * a default I should pick. Real tiles are a `docs/stack.md` addition — see the note in
 * `CLAUDE.md` open items.
 *
 * Latitude is inverted because SVG y grows downward and north does not. Longitude is
 * scaled by cos(latitude) so the shape is not stretched east-west — at 26°N a degree
 * of longitude is about 100km against latitude's 111km, and ignoring that tilts every
 * path.
 */
function TrailMap({ stops }: { stops: readonly LocationStop[] }) {
  const path = [...stops].reverse();

  if (path.length === 0) return null;

  const lats = path.map((s) => s.latitude);
  const lons = path.map((s) => s.longitude);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);

  const xs = lons.map((lon) => lon * kx);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...lats);
  const maxY = Math.max(...lats);

  // A single stop has no extent. Give it one so it lands in the middle rather than
  // dividing by zero and disappearing.
  const spanX = maxX - minX || 1e-6;
  const spanY = maxY - minY || 1e-6;
  const pad = 8;

  const project = (lat: number, lon: number) => ({
    x: pad + ((lon * kx - minX) / spanX) * (200 - pad * 2),
    y: pad + (1 - (lat - minY) / spanY) * (120 - pad * 2),
  });

  const projected = path.map((stop) => ({ stop, ...project(stop.latitude, stop.longitude) }));

  return (
    <div className="border-t px-4 py-4 sm:px-5">
      <svg
        viewBox="0 0 200 120"
        className="h-40 w-full rounded-md border bg-muted/30"
        role="img"
        aria-label={`Movement between ${String(path.length)} ${path.length === 1 ? "place" : "places"}`}
      >
        {projected.length > 1 ? (
          <polyline
            points={projected.map((p) => `${String(p.x)},${String(p.y)}`).join(" ")}
            fill="none"
            stroke="hsl(var(--muted-foreground))"
            strokeWidth="1"
            strokeDasharray="3 2"
          />
        ) : null}

        {projected.map((p, index) => (
          <circle
            key={p.stop.fromIso}
            cx={p.x}
            cy={p.y}
            // Longer stops read as bigger, so a desk is visibly not a traffic light.
            r={Math.min(6, 2 + Math.sqrt(p.stop.points))}
            className={
              index === projected.length - 1
                ? "fill-[hsl(var(--success))]"
                : "fill-[hsl(var(--primary))]"
            }
            opacity={0.85}
          >
            <title>
              {shortTime(p.stop.fromIso)} — {p.stop.latitude.toFixed(5)},{" "}
              {p.stop.longitude.toFixed(5)}
            </title>
          </circle>
        ))}
      </svg>

      <p className="mt-2 text-xs text-muted-foreground">
        Relative positions and the order they were visited. No street detail — open any
        stop in the list for that. The last position is green.
      </p>
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
