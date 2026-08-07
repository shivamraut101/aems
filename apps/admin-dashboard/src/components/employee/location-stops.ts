import type { LocationPoint } from "@/app/(app)/people/[profileId]/devices/device-queries";

/**
 * Consecutive points within this of each other are the same place.
 *
 * Chosen against the accuracy the phones actually report, not picked round: the fixes
 * arriving are ±19m on a GPS lock and ±100m once Android falls back to network
 * positioning. Two readings 60m apart from a stationary phone is ordinary jitter at
 * that accuracy, so a threshold below it would split one desk into four "stops". Above
 * ~150m it would start merging genuinely different places — a customer site and the
 * car park outside it.
 */
export const SAME_PLACE_METRES = 120;

export interface LocationStop {
  /** The first point's position. Not an average — see the note in `groupIntoStops`. */
  latitude: number;
  longitude: number;
  /** Oldest and newest reading in the stop. */
  fromIso: string;
  toIso: string;
  points: number;
  /** Worst accuracy in the group, because a stop is only as certain as its vaguest fix. */
  accuracyM: number | null;
}

/**
 * Metres between two coordinates. Haversine on a spherical earth.
 *
 * Good to about 0.5% at these distances, which is far better than the ±100m the fixes
 * themselves carry — the error that matters here is the phone's, not the formula's.
 */
export function metresBetween(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Collapses a ping log into places the person actually was.
 *
 * The agent samples once a minute whether or not anybody moved, so a phone on a desk
 * for eight hours produces 480 identical rows. Rendering them is not a location
 * history — it is the same fact 480 times, and it buries the two or three moments that
 * are actually a movement.
 *
 * Grouped by proximity to the stop's **first** point rather than to the previous one.
 * Chaining against the previous point lets a slow walk drift indefinitely, one 100m
 * step at a time, and report a mile of walking as a single stop.
 *
 * The position reported is that first point, not the mean of the group. Averaging
 * invents a coordinate the device never reported, and on a screen where someone may
 * have to answer for where they were, every point shown should be one the phone
 * actually sent.
 *
 * Input is expected newest-first, which is how the API returns it.
 */
export function groupIntoStops(
  points: readonly LocationPoint[],
  thresholdMetres: number = SAME_PLACE_METRES,
): LocationStop[] {
  const ordered = [...points].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  const stops: LocationStop[] = [];

  for (const point of ordered) {
    const open = stops[stops.length - 1];
    const samePlace =
      open !== undefined &&
      metresBetween(open.latitude, open.longitude, point.latitude, point.longitude) <=
        thresholdMetres;

    if (open && samePlace) {
      open.toIso = point.recordedAt;
      open.points += 1;
      // The vaguest fix in the group governs: a stop containing one +-500m reading is
      // not known to +-19m just because another reading was.
      if (point.accuracyM !== null) {
        open.accuracyM = open.accuracyM === null ? point.accuracyM : Math.max(open.accuracyM, point.accuracyM);
      }
      continue;
    }

    stops.push({
      latitude: point.latitude,
      longitude: point.longitude,
      fromIso: point.recordedAt,
      toIso: point.recordedAt,
      points: 1,
      accuracyM: point.accuracyM,
    });
  }

  // Newest first, matching every other list on this page.
  return stops.reverse();
}

/**
 * Distance covered across the day, in metres.
 *
 * Measured **between stops**, not between raw fixes, and that is the whole point. A
 * stationary phone reports ±100m network jitter once a minute; summing raw fixes turns
 * eight hours at a desk into several kilometres of "travel". Grouping first means only
 * a move large enough to open a new stop counts as distance.
 *
 * Still a floor, not a survey: it is straight lines between the places the phone was
 * seen, so a road that curves between two stops is under-counted, and a trip out and
 * back between samples is invisible. Reported as "at least" for that reason — a
 * monitoring product must not present an estimate as an odometer reading.
 */
export function distanceCoveredMetres(stops: readonly LocationStop[]): number {
  // `groupIntoStops` returns newest-first; walking the day forwards reads more
  // naturally and gives the same total either way.
  const chronological = [...stops].reverse();
  let total = 0;

  for (let i = 1; i < chronological.length; i += 1) {
    const previous = chronological[i - 1];
    const current = chronological[i];
    if (!previous || !current) continue;
    total += metresBetween(
      previous.latitude,
      previous.longitude,
      current.latitude,
      current.longitude,
    );
  }

  return total;
}

/** "1.4 km" / "320 m". Below a kilometre, metres are the honest unit. */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${String(Math.round(metres))} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/**
 * A link to the coordinate on OpenStreetMap.
 *
 * A link rather than a reverse-geocoded label, and rather than an embedded map.
 * Turning a coordinate into "12 Mill Road" means sending an employee's position to a
 * third party on every render — a decision about somebody's privacy that belongs to
 * the client, not to a convenience feature. A link sends nothing until a manager
 * chooses to click it, and then it is their browser making the request, not ours.
 *
 * OSM rather than Google Maps: no API key, no account, and no tracking cookie set on
 * the reader by opening it.
 */
export function mapHref(latitude: number, longitude: number): string {
  const lat = latitude.toFixed(6);
  const lon = longitude.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
}
