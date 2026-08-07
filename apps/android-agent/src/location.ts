import * as Location from "expo-location";

import type { LocationPointInput } from "@aems/types";

import { uuidFrom } from "./uuid";

/**
 * Position fixes — `docs/scope.md` §3.5, added on the client's explicit instruction
 * (2026-08-07) after being left out of the schema deliberately.
 *
 * Sampling rides the sync cycle rather than running its own continuous location task.
 * That is a real trade and worth stating plainly: a point arrives roughly once a minute
 * while the app is open and roughly every fifteen minutes when it is not, because that
 * is Android's floor for background fetch. It is not a second-by-second trail, and the
 * status screen says so rather than implying otherwise.
 *
 * The alternative — `startLocationUpdatesAsync` with its own background task — buys
 * finer granularity at the cost of a second foreground service and a second permanent
 * notification competing with the one that already exists to say monitoring is on. That
 * is a change to the visible-indicator guarantee, so it is the client's call and not a
 * detail to slip in under a feature request.
 */

/** Beyond this a fix is too vague to place anyone, and is discarded rather than stored. */
const MAX_ACCEPTABLE_ACCURACY_M = 1000;

export type LocationAccess = "granted-always" | "granted-foreground" | "denied";

/**
 * What the OS will actually give us, which is not the same as what was declared.
 *
 * Android 11+ refuses to grant background location in the same prompt as foreground —
 * it must be asked for separately, and the user has to choose "Allow all the time" on a
 * settings screen. Reporting the two states apart is what lets the UI say which one is
 * missing instead of showing a single "location off" that hides why.
 */
export async function checkLocationAccess(): Promise<LocationAccess> {
  const foreground = await Location.getForegroundPermissionsAsync();
  if (!foreground.granted) return "denied";

  const background = await Location.getBackgroundPermissionsAsync();
  return background.granted ? "granted-always" : "granted-foreground";
}

/**
 * Asks for foreground first, then background, because Android rejects the second
 * request outright unless the first has already been granted.
 */
export async function requestLocationAccess(): Promise<LocationAccess> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) return "denied";

  const background = await Location.requestBackgroundPermissionsAsync();
  return background.granted ? "granted-always" : "granted-foreground";
}

/** What the employee is shown about where their own device thinks it is. */
export interface CurrentPosition {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  /** A readable place, when Android's geocoder can name one. Coordinates otherwise. */
  label: string;
  recordedAt: string;
}

/**
 * The device's position for display, named rather than left as two decimals.
 *
 * Reverse geocoding is best-effort and deliberately non-fatal: it is a courtesy to the
 * reader, not part of the record. Nothing derived here is ever sent — `samplePoint` is
 * the only thing that reports, and it reports coordinates. A place name inferred on the
 * phone must not become evidence, because the geocoder is occasionally confidently wrong
 * and nobody would be able to tell from the stored row.
 */
export async function describeCurrentPosition(): Promise<CurrentPosition | null> {
  const access = await checkLocationAccess();
  if (access === "denied") return null;
  if (!(await Location.hasServicesEnabledAsync())) return null;

  let position: Location.LocationObject;
  try {
    // The last known fix first: it is instant, and a screen that blocks for a GPS lock
    // every time it is opened reads as broken. A fresh fix is taken only when there is
    // nothing cached to show.
    position =
      (await Location.getLastKnownPositionAsync()) ??
      (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
  } catch {
    return null;
  }

  const { latitude, longitude, accuracy } = position.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    latitude,
    longitude,
    accuracyM: accuracy ?? null,
    label: await placeName(latitude, longitude),
    recordedAt: new Date(position.timestamp).toISOString(),
  };
}

async function placeName(latitude: number, longitude: number): Promise<string> {
  const coordinates = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

  try {
    const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
    if (!place) return coordinates;

    // Street and city, whichever of them the geocoder actually produced — many of these
    // fields come back null depending on where the device is.
    const parts = [place.name ?? place.street, place.city ?? place.subregion, place.region].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );

    return parts.length > 0 ? [...new Set(parts)].join(", ") : coordinates;
  } catch {
    return coordinates;
  }
}

/**
 * One fix, or `null` when there is nothing trustworthy to report.
 *
 * Every failure path returns `null` rather than throwing or substituting a guess: a
 * missing point understates where someone was, while a bad one puts them somewhere they
 * were not. Only one of those two errors can get a person disciplined.
 */
export async function samplePoint(deviceId: string): Promise<LocationPointInput | null> {
  const access = await checkLocationAccess();
  if (access === "denied") return null;

  // Location can be granted while the radio is switched off at the OS level.
  if (!(await Location.hasServicesEnabledAsync())) return null;

  let position: Location.LocationObject;
  try {
    position = await Location.getCurrentPositionAsync({
      // Balanced rather than Highest: a workforce trail needs to know which site someone
      // is at, not which side of the road, and Highest keeps the GPS radio awake long
      // enough to matter on a phone that has to last a shift.
      accuracy: Location.Accuracy.Balanced,
    });
  } catch {
    return null;
  }

  const { latitude, longitude, accuracy } = position.coords;

  // A fix from a cell tower can be kilometres wide. Storing it next to a GPS lock would
  // make the two indistinguishable on a map drawn from the same column.
  if (accuracy !== null && accuracy > MAX_ACCEPTABLE_ACCURACY_M) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const recordedAtMs = Math.round(position.timestamp);

  return {
    // Derived from the fix's own timestamp so a replayed cycle collides with the row
    // already stored, the same idempotency rule the activity path follows.
    clientEventId: uuidFrom(`${deviceId}:location:${recordedAtMs}`),
    recordedAt: new Date(recordedAtMs).toISOString(),
    latitude,
    longitude,
    accuracyM: accuracy ?? null,
  };
}
