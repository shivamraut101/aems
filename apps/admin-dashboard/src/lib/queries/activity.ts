"use client";

import type { DayTimeline } from "@aems/types";
import { useQuery } from "@tanstack/react-query";

import { apiFetch, type EmployeeRow, type LiveWorkforceRow } from "@/lib/api";
import type { PresenceStatus } from "@/components/status-dot";

/**
 * Data and view models for the master–detail activity screen.
 *
 * Everything below the hook is pure so it can be tested without a DOM: the join
 * between the roster and live presence, and the day window arithmetic.
 * The screen itself only wires them to components.
 */

/* -------------------------------------------------------------------------- */
/* Day keys                                                                    */
/* -------------------------------------------------------------------------- */

/** A calendar day as `YYYY-MM-DD`, in the reader's own timezone. */
export type DateKey = string;

export function dateKeyOf(date: Date): DateKey {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function partsOf(key: DateKey): { year: number; month: number; day: number } {
  const [year, month, day] = key.split("-").map((part) => Number(part));
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

/**
 * Moves a day key by whole days.
 *
 * The arithmetic runs through a local `Date` with an out-of-range day-of-month,
 * which the constructor normalises — so month, year and leap-day boundaries are the
 * platform's problem rather than ours.
 */
export function shiftDateKey(key: DateKey, days: number): DateKey {
  const { year, month, day } = partsOf(key);
  return dateKeyOf(new Date(year, month - 1, day + days));
}

export function isFutureDateKey(key: DateKey, now = new Date()): boolean {
  return key > dateKeyOf(now);
}

/** Never ask the API for a zero-length window; it refuses one, and rightly. */
const MIN_WINDOW_MS = 60_000;

/**
 * The ISO window for one local day, clipped at "now".
 *
 * Clipping matters: the timeline fills unreported time with offline spans, so an
 * unclipped window would paint the rest of today as a hole in someone's day.
 */
export function dayWindow(key: DateKey, now = new Date()): { from: string; to: string } {
  const { year, month, day } = partsOf(key);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);

  const clipped = now.getTime() < end.getTime() ? now.getTime() : end.getTime();
  const to = Math.max(clipped, start.getTime() + MIN_WINDOW_MS);

  return { from: start.toISOString(), to: new Date(to).toISOString() };
}

/* -------------------------------------------------------------------------- */
/* Roster                                                                      */
/* -------------------------------------------------------------------------- */

export type RosterSort = "name" | "activity";

export interface RosterRow {
  profileId: string;
  name: string;
  email: string;
  department: string | null;
  status: PresenceStatus;
  lastSeenAt: string | null;
  deviceLabel: string | null;
  monitoringEnabled: boolean;
}

/** Present beats idle beats absent — the order a manager scans in. */
const STATUS_RANK: Record<PresenceStatus, number> = { active: 0, idle: 1, offline: 2 };

function newerOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * The roster, with live presence folded in.
 *
 * One person can hold several devices, so presence is reduced rather than picked:
 * the best status any of their devices reports is the status of the person. Picking
 * whichever device the API happened to list first made an active employee render as
 * offline whenever their phone had not checked in.
 */
export function rosterRows(
  employees: EmployeeRow[],
  live: LiveWorkforceRow[],
  sort: RosterSort,
): RosterRow[] {
  const byProfile = new Map<string, LiveWorkforceRow[]>();
  for (const row of live) {
    if (!row.profileId) continue;
    const bucket = byProfile.get(row.profileId);
    if (bucket) bucket.push(row);
    else byProfile.set(row.profileId, [row]);
  }

  const rows = employees.map((person): RosterRow => {
    const presence = byProfile.get(person.id) ?? [];
    const best = presence.reduce<LiveWorkforceRow | null>((winner, candidate) => {
      if (!winner) return candidate;
      const better = STATUS_RANK[candidate.status] - STATUS_RANK[winner.status];
      if (better < 0) return candidate;
      if (better > 0) return winner;
      return newerOf(candidate.lastSeenAt, winner.lastSeenAt) === candidate.lastSeenAt
        ? candidate
        : winner;
    }, null);

    const enrolledLastSeen = person.devices.reduce<string | null>(
      (latest, device) => newerOf(latest, device.last_seen_at),
      null,
    );

    return {
      profileId: person.id,
      // A profile with no name still has to read as a person.
      name: person.full_name?.trim() || person.email,
      email: person.email,
      department: person.department,
      status: best?.status ?? "offline",
      lastSeenAt: best?.lastSeenAt ?? enrolledLastSeen,
      deviceLabel: best?.label ?? person.devices[0]?.label ?? null,
      monitoringEnabled: person.monitoring_enabled,
    };
  });

  return rows.sort((a, b) => {
    if (sort === "activity") {
      const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (byStatus !== 0) return byStatus;

      const seenA = a.lastSeenAt ? Date.parse(a.lastSeenAt) : -Infinity;
      const seenB = b.lastSeenAt ? Date.parse(b.lastSeenAt) : -Infinity;
      if (seenA !== seenB) return seenB - seenA;
    }

    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/*
 * There is deliberately no marker/span reducer here.
 *
 * `components/timeline/model.ts` owns `railEvents` and `ActivityTimeline` calls it
 * itself, so this screen hands the component a whole `DayTimeline` and lets it
 * reduce. A second reduction living here would be a second answer to "what happened
 * at 10:30", and the two would drift the first time either changed.
 */

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

/** The unit the ribbon, the screenshot review and the app list all share. */
export const DEFAULT_SLOT_SECONDS = 600;

/**
 * One person's reduced day.
 *
 * `retry: false` because the two ways this fails are settled: an employee asking for
 * somebody else is a 403 that a second attempt cannot change, and a malformed window
 * is a 400 about the request itself.
 */
export function useDayTimeline(
  profileId: string | null,
  from: string,
  to: string,
  bucketSeconds: number = DEFAULT_SLOT_SECONDS,
) {
  return useQuery({
    queryKey: ["timeline", profileId, from, to, bucketSeconds],
    queryFn: () =>
      apiFetch<DayTimeline>(
        `/api/analytics/timeline?profileId=${profileId}&from=${encodeURIComponent(from)}` +
          `&to=${encodeURIComponent(to)}&bucketSeconds=${bucketSeconds}`,
      ),
    enabled: Boolean(profileId),
    retry: false,
  });
}
