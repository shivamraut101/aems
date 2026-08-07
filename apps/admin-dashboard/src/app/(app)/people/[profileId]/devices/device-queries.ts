"use client";

/**
 * The two things the Devices tab could not do.
 *
 * `device_applications` has been written by `POST /api/devices/applications` since
 * enrolment shipped and read by nothing, so scope §7's "installed applications" was a
 * column collected from every machine and shown on no screen. And the panel narrated
 * "this device was revoked" as after-the-fact prose for a state the product offered
 * no way to enter.
 *
 * Colocated with the only page that uses them rather than added to `lib/queries`:
 * these are one tab's data, and the shared modules are already the file every screen
 * has to touch.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";

/** A row of `device_applications`, as the API returns the table. */
export interface DeviceApplicationRow {
  id: number;
  name: string;
  version: string | null;
  identifier: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * Software reported by one machine.
 *
 * Inventory changes when somebody installs something, which is to say rarely, so it
 * is cached for five minutes rather than refetched every time a tab regains focus.
 * `retry: false` because the failures are settled: 403 for a device that is not this
 * viewer's to read, 404 for one that is not in this company.
 */
export function useDeviceApplications(deviceId: string) {
  return useQuery({
    queryKey: ["deviceApplications", deviceId],
    queryFn: () =>
      apiFetch<DeviceApplicationRow[]>(
        `/api/devices/${encodeURIComponent(deviceId)}/applications`,
      ),
    enabled: Boolean(deviceId),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** One row of `device_telemetry`, as `GET /api/devices/:id/telemetry` returns it. */
export interface DeviceTelemetryRow {
  id: number;
  recorded_at: string;
  battery_level: number | null;
  battery_charging: boolean | null;
  network_type: "wifi" | "cellular" | "ethernet" | "offline" | null;
  storage_free_mb: number | null;
  /**
   * Screen-on seconds **since local midnight**, not since the previous sample.
   *
   * Verified against live data before this was rendered: the samples climb
   * 56 → 559 → 617 → 766 → 917 → 1097 within one day, and the Kotlin behind it
   * (`ScreenTimeTracker.getTodaySeconds`, which calls `resetIfNewDay`) accumulates
   * rather than reporting a delta. So the newest sample is today's total and these
   * must never be summed. Migration `…0004` says the opposite in a column comment;
   * `…0012` corrects it.
   */
  screen_active_seconds: number | null;
}

/**
 * The newest telemetry sample for one device.
 *
 * Only Android sends these — battery, network and screen-on time have no desktop
 * counterpart — which is why the phone card can show live state the laptop card
 * cannot, and why this is fetched per device rather than folded into the roster.
 *
 * `limit=1`: the card shows current state, not a history. A 60-second stale time
 * because the agent samples about that often, so anything shorter refetches a number
 * that has not moved.
 */
export function useDeviceTelemetry(deviceId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["deviceTelemetry", deviceId],
    queryFn: () =>
      apiFetch<{ latest: DeviceTelemetryRow | null; samples: DeviceTelemetryRow[] }>(
        `/api/devices/${encodeURIComponent(deviceId)}/telemetry?limit=1`,
      ),
    enabled: enabled && Boolean(deviceId),
    staleTime: 60_000,
    retry: false,
  });
}

/** One row of `location_points`, as `GET /api/activity/locations` returns it. */
export interface LocationPoint {
  id: number;
  deviceId: string;
  recordedAt: string;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
}

/**
 * Where a phone was, over one day.
 *
 * The most sensitive read in the product, so it is scoped by day rather than opened as
 * a browsable history: the API refuses another person's trail outright unless the
 * caller `canViewOthers`, and asking a day at a time means a manager sees the day they
 * navigated to and not a month they did not ask for.
 *
 * `enabled` is false for a laptop — desktops send no location at all.
 */
export function useDeviceLocations(
  profileId: string,
  from: string,
  to: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["deviceLocations", profileId, from, to],
    queryFn: () =>
      apiFetch<{ points: LocationPoint[] }>(
        `/api/activity/locations?profileId=${encodeURIComponent(profileId)}` +
          `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),
    enabled: enabled && Boolean(profileId) && Boolean(from) && Boolean(to),
    staleTime: 60_000,
    retry: false,
  });
}

/** Newest-seen first, then by name, so the list has a stable order across renders. */
export function sortApplications(rows: readonly DeviceApplicationRow[]): DeviceApplicationRow[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * `POST /api/devices/:deviceId/revoke` — non-negotiable #4.
 *
 * Not optimistic, for the same reason the monitoring toggle is not: "Revoked" on
 * screen is a claim that a machine has stopped collecting, and showing it before the
 * server agrees is the one lie a monitoring product cannot afford.
 */
/**
 * `POST /api/devices/:deviceId/primary` — names the machine that defines this
 * person's working hours (migration …0016).
 *
 * Not optimistic. The same rule as revoking: this changes the hours a person is
 * judged on, and showing the badge before the server agrees would state something
 * about somebody's day that might not be true.
 *
 * Invalidates the timeline as well as the device list, because the number on every
 * other tab is computed from whichever device this now is.
 */
export function useSetPrimaryDevice() {
  const queryClient = useQueryClient();

  return useMutation<unknown, unknown, string>({
    mutationFn: (deviceId) =>
      apiFetch<unknown>(`/api/devices/${encodeURIComponent(deviceId)}/primary`, {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      void queryClient.invalidateQueries({ queryKey: ["timeline"] });
      void queryClient.invalidateQueries({ queryKey: ["analytics"] });
    },
    retry: false,
  });
}

export function useRevokeDevice() {
  const queryClient = useQueryClient();

  return useMutation<unknown, unknown, string>({
    mutationFn: (deviceId) =>
      apiFetch<unknown>(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, { method: "POST" }),
    onSuccess: () => {
      // The device table feeds this tab, the roster's device count and the live board.
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      void queryClient.invalidateQueries({ queryKey: ["employees"] });
      void queryClient.invalidateQueries({ queryKey: ["analytics", "live"] });
    },
    retry: false,
  });
}
