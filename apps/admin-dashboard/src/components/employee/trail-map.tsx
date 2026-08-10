"use client";

import "leaflet/dist/leaflet.css";

import L from "leaflet";
import { useMemo } from "react";
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, useMap } from "react-leaflet";

import { duration } from "@/lib/format";

import type { LocationStop } from "./location-stops";

/**
 * The day's trail, on real tiles.
 *
 * Replaces an inline-SVG plot that drew relative positions and no streets. The
 * reasoning behind that — an embedded map fetches tiles from a third party with the
 * viewport in the request — still holds and is why this is the *only* place in the
 * product that loads them, behind a switch a manager has to press. But a shapes-only
 * plot answered nothing: a stationary phone rendered as a single dot in an empty box,
 * which is the commonest case and the least useful drawing of it.
 *
 * OpenStreetMap tiles: no API key, no account, and no tracking cookie set on the
 * reader. Leaflet rather than an OSM `embed.html` iframe because an iframe supports
 * exactly one marker and cannot draw a path, and the path is the thing being asked for.
 */

/**
 * Leaflet's default marker icon is a PNG it resolves by URL, which a bundler rewrites
 * and then 404s at runtime — the classic "markers are invisible" bug. `CircleMarker` is
 * drawn by Leaflet itself, needs no asset, and scales with how long a stop lasted,
 * which the pin never could.
 */
function radiusFor(stop: LocationStop): number {
  return Math.min(14, 6 + Math.sqrt(stop.points));
}

/** Frames the whole day. Without it the map opens at world zoom over the Atlantic. */
function FitToTrail({ stops }: { stops: readonly LocationStop[] }) {
  const map = useMap();

  const bounds = useMemo(() => {
    if (stops.length === 0) return null;
    return L.latLngBounds(stops.map((s) => [s.latitude, s.longitude] as [number, number]));
  }, [stops]);

  if (bounds) {
    // A single stop has zero extent, and `fitBounds` on a point zooms to maximum —
    // a street-level view of one building tells a reader nothing about where it is.
    if (stops.length === 1) map.setView(bounds.getCenter(), 15);
    else map.fitBounds(bounds, { padding: [28, 28] });
  }

  return null;
}

export default function TrailMap({ stops }: { stops: readonly LocationStop[] }) {
  // Oldest first so the polyline is drawn in the order the day happened.
  const path = useMemo(() => [...stops].reverse(), [stops]);

  if (path.length === 0) return null;

  const centre: [number, number] = [path[0]!.latitude, path[0]!.longitude];

  return (
    <div className="border-t px-4 py-4 sm:px-5">
      <MapContainer
        center={centre}
        zoom={15}
        scrollWheelZoom={false}
        // Tall enough to be a map rather than a strip. The previous 160px could not
        // show a street name and a route at the same time.
        className="h-[420px] w-full rounded-md border"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <FitToTrail stops={path} />

        {path.length > 1 ? (
          <Polyline
            positions={path.map((s) => [s.latitude, s.longitude] as [number, number])}
            pathOptions={{ color: "#6366F1", weight: 3, opacity: 0.7, dashArray: "6 6" }}
          />
        ) : null}

        {path.map((stop, index) => {
          const held = Math.max(
            0,
            Math.round((Date.parse(stop.toIso) - Date.parse(stop.fromIso)) / 1000),
          );
          const last = index === path.length - 1;

          return (
            <CircleMarker
              key={stop.fromIso}
              center={[stop.latitude, stop.longitude]}
              radius={radiusFor(stop)}
              pathOptions={{
                color: last ? "#10B981" : "#0F172A",
                fillColor: last ? "#10B981" : "#0F172A",
                fillOpacity: 0.65,
                weight: 2,
              }}
            >
              <Popup>
                <span className="text-xs">
                  <strong>{shortTime(stop.fromIso)}</strong>
                  {stop.points > 1 ? ` – ${shortTime(stop.toIso)}` : ""}
                  {held > 0 ? <> · stayed {duration(held)}</> : null}
                  <br />
                  {stop.latitude.toFixed(5)}, {stop.longitude.toFixed(5)}
                  {/* The accuracy travels with the point here too. A fix good to 2km
                      and one good to 5m place a person very differently, and a map
                      makes every point look equally certain unless it is said. */}
                  {stop.accuracyM === null ? null : <> · ±{Math.round(stop.accuracyM)}m</>}
                </span>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      <p className="mt-2 text-xs text-muted-foreground">
        Each circle is a place the phone was seen; bigger means it stayed longer, and the
        last position is green. Click one for the time and how accurate the fix was.
      </p>
    </div>
  );
}

function shortTime(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
}
