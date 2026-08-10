"use client";

import type { DayTimeline } from "@aems/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { ApiError, apiFetch } from "@/lib/api";

/**
 * The one grid the ribbon, the screenshot review and the app list all key on.
 *
 * Three views agreeing is a property of there being one unit, not three — so this is
 * a constant rather than a per-screen choice. The API accepts 60/300/600/1800/3600
 * and rejects anything else.
 */
export const TIMELINE_SLOT_SECONDS = 600;

/** Signed screenshot URLs inside the payload live 600 s; refetch before they die. */
const STALE_MS = 5 * 60_000;

export function timelineQueryKey(
  profileId: string,
  from: string,
  to: string,
  bucketSeconds: number = TIMELINE_SLOT_SECONDS,
  deviceId: string | null = null,
) {
  // `deviceId` is part of the key, not a filter applied after the fetch: the whole-person
  // day and one machine's day are different answers to different questions, and caching
  // them under one key would serve whichever arrived first.
  return ["timeline", profileId, from, to, bucketSeconds, deviceId] as const;
}

/**
 * One person's day, already reduced server-side.
 *
 * The response is a `DayTimeline` object — spans, markers, slots and totals — not a
 * list of buckets. Reduction (gap flooding, adjacent merge, short-run clustering)
 * happens in `@aems/analytics` before the browser sees an event, so this hook has no
 * transform step and the component does no gap arithmetic.
 */
export function useDayTimeline(
  profileId: string,
  from: string,
  to: string,
  bucketSeconds: number = TIMELINE_SLOT_SECONDS,
  /** One machine's day. Null asks about the person, which the API answers from their
   *  primary device when one is set, and from every device when none is. */
  deviceId: string | null = null,
) {
  return useQuery({
    queryKey: timelineQueryKey(profileId, from, to, bucketSeconds, deviceId),
    queryFn: () =>
      apiFetch<DayTimeline>(
        `/api/analytics/timeline?profileId=${encodeURIComponent(profileId)}` +
          `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
          `&bucketSeconds=${bucketSeconds}` +
          (deviceId === null ? "" : `&deviceId=${encodeURIComponent(deviceId)}`),
      ),
    // A zero-length window is a day that has not started yet, not a request worth making.
    enabled: Boolean(profileId) && Boolean(from) && Boolean(to) && from !== to,
    staleTime: STALE_MS,
    // The day advances every few minutes, which mints a new `to` and a new key. Without
    // this, scrubbing between days blanks the screen on every step.
    placeholderData: keepPreviousData,
    /*
     * An `ApiError` means the API answered and refused — a 403 on someone else's
     * profile, a 400 on a bad range. Retrying a settled refusal only delays the
     * message. A `NetworkError` never landed, so it is worth two more attempts.
     */
    retry: (failureCount, error) => !(error instanceof ApiError) && failureCount < 2,
  });
}
