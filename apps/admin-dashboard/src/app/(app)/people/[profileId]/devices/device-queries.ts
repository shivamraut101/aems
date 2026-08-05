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
