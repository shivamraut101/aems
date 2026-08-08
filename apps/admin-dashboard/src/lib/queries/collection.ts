"use client";

/**
 * What each machine is allowed to collect, and who decided.
 *
 * Two routes, both under the already-mounted `/api/devices` namespace:
 *
 *   GET   /api/devices/:deviceId/collection   — `requireUser`, and the existing device
 *                                               read guard lets an employee read their
 *                                               own (non-negotiable #3).
 *   PATCH /api/devices/:deviceId/collection   — `requireManager`.
 *
 * The wire shape is a **deny list**: the response carries one row per (device, type)
 * somebody has made a decision about, and a type with no row is permitted. That is the
 * database's shape too, and it is what makes an absent policy mean "everything this
 * platform supports" rather than "nothing" — so a device enrolled before this feature
 * existed, and an Android phone nobody has touched, both keep collecting exactly what
 * they collect today.
 *
 * A re-enabled type keeps its row with `enabled: true`. That is not redundancy: "Sam
 * turned screenshots back on on 9 Aug" is a fact the compliance surfaces have to be
 * able to state, and a deleted row states nothing.
 */

import { useQueries, useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import {
  DATA_TYPE_IDS,
  DATA_TYPE_LABEL,
  PLATFORM_DATA_TYPES,
  type DataTypeId,
  type DeviceCollectionSetting,
  type DeviceCollectionUpdate,
} from "@aems/types";

import { apiFetch, useApiQuery, type DeviceRow } from "@/lib/api";
import { devicesQuery } from "@/components/employee/employee-queries";
import { devicesForProfile } from "@/lib/queries/usage";
import type { CollectionOffType } from "@/components/states";

/**
 * The short noun for each type, as a dashboard column names it.
 *
 * Deliberately not `describeDataType(...).title` from `@aems/types`: those are consent
 * sentences written to be read by the person being recorded ("Not the websites you
 * visit"), and a sentence does not fit in a badge or a switch row. This is the same
 * vocabulary the Devices tab already uses for its spec labels.
 */
// Re-exported, not redeclared. The API sends email naming these same types, and two
// lists of names for one set of things is how a dashboard and an inbox disagree.
export { DATA_TYPE_LABEL };

/** Every type, in consent-screen order — what the Add device dialog offers. */
export const ALL_DATA_TYPES: readonly DataTypeId[] = DATA_TYPE_IDS;

/** Types this platform can physically report. An admin cannot switch on the rest. */
export function typesFor(platform: DeviceRow["platform"]): readonly DataTypeId[] {
  return PLATFORM_DATA_TYPES[platform] ?? DATA_TYPE_IDS;
}

function collectionKey(deviceId: string) {
  return ["deviceCollection", deviceId] as const;
}

/**
 * One device's exceptions.
 *
 * Cached for a minute and not retried: the failures are settled (403 for a device that
 * is not this viewer's to read, 404 for one outside the company), and a policy decision
 * does not change while somebody reads a page.
 */
export function useDeviceCollection(deviceId: string, enabled = true) {
  return useQuery({
    queryKey: collectionKey(deviceId),
    queryFn: () =>
      apiFetch<DeviceCollectionSetting[]>(
        `/api/devices/${encodeURIComponent(deviceId)}/collection`,
      ),
    enabled: enabled && Boolean(deviceId),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Switch types on or off for one machine.
 *
 * Not optimistic, and for the same reason revoking a device is not: the switch's
 * position is a claim about what a binary on somebody's laptop is doing right now, and
 * showing "off" before the server has agreed is the one lie a monitoring product cannot
 * afford. The agent learns about it on its next heartbeat, within a minute.
 *
 * Invalidates the reads that quote the setting — the per-device list, and the timeline
 * and report caches whose empty stretches this is the explanation for.
 */
export function useUpdateDeviceCollection(deviceId: string) {
  const queryClient = useQueryClient();

  return useMutation<DeviceCollectionSetting[], unknown, DeviceCollectionUpdate>({
    mutationFn: (body) =>
      apiFetch<DeviceCollectionSetting[]>(
        `/api/devices/${encodeURIComponent(deviceId)}/collection`,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: (rows) => {
      queryClient.setQueryData(collectionKey(deviceId), rows);
      void queryClient.invalidateQueries({ queryKey: ["timeline"] });
      void queryClient.invalidateQueries({ queryKey: ["report"] });
    },
    retry: false,
  });
}

/** The PATCH body for a single switch. Written long-hand because a computed union key
 *  in an object literal widens to a string index signature, which does not assign. */
export function oneType(dataType: DataTypeId, enabled: boolean): DeviceCollectionUpdate {
  const types: DeviceCollectionUpdate["types"] = {};
  types[dataType] = enabled;
  return { types };
}

/** A switched-off (device, type) pair, ready to be grouped for the reader. */
interface OffRow {
  dataType: DataTypeId;
  deviceName: string;
  byName: string | null;
  atISO: string;
}

/** What a surface hands straight to `<CollectionOff {...off("screenshots")} />`. */
export interface CollectionOffProps {
  types: CollectionOffType[];
  scopes: string[];
}

/**
 * Every type switched off across one person's fleet, keyed by type.
 *
 * A person-level tab unions devices — screenshots off on the laptop and on for the
 * phone is the ordinary case — so this dedupes by type and collects the machines into
 * `scopes`, which is what lets a notice sit above content that is still rendering for
 * the other device.
 *
 * **A failed or pending read returns nothing.** That is the deliberate direction: the
 * only claim this makes is the positive one, "an administrator switched this off". A
 * settings query that 500'd must never render as a switched-off notice, because telling
 * an employee nothing is being recorded while it is, is the failure that matters.
 * Revoked devices are skipped too — they carry their own, louder notice, and a revoked
 * machine's per-type scope is not the reason it stopped reporting.
 */
export function useCollectionOff(profileId: string) {
  const devices = useApiQuery(devicesQuery);

  const fleet = useMemo(
    () =>
      devicesForProfile(devices.data ?? [], profileId).filter(
        (device) => device.status !== "revoked",
      ),
    [devices.data, profileId],
  );

  const results = useQueries({
    queries: fleet.map((device) => ({
      queryKey: collectionKey(device.id),
      queryFn: () =>
        apiFetch<DeviceCollectionSetting[]>(
          `/api/devices/${encodeURIComponent(device.id)}/collection`,
        ),
      staleTime: 60_000,
      retry: false,
    })),
  });

  const rows = useMemo<OffRow[]>(() => {
    const out: OffRow[] = [];
    fleet.forEach((device, index) => {
      for (const setting of results[index]?.data ?? []) {
        if (setting.enabled) continue;
        out.push({
          dataType: setting.dataType,
          deviceName: device.device_name || device.label,
          byName: setting.changedByName,
          atISO: setting.changedAt,
        });
      }
    });
    return out;
  }, [fleet, results]);

  /**
   * The props for one notice covering the types this surface renders.
   *
   * `scopes` is omitted when the whole fleet is off for every named type — "on John's
   * laptop and John's phone" adds nothing when those are all the machines there are.
   */
  const off = useCallback(
    (...types: DataTypeId[]): CollectionOffProps => {
      const wanted = new Set(types);
      const matched = rows.filter((row) => wanted.has(row.dataType));
      const scopes = [...new Set(matched.map((row) => row.deviceName))];

      const grouped = new Map<DataTypeId, OffRow>();
      for (const row of matched) {
        const existing = grouped.get(row.dataType);
        // Newest decision wins the attribution when two machines disagree about when.
        if (!existing || Date.parse(row.atISO) > Date.parse(existing.atISO)) {
          grouped.set(row.dataType, row);
        }
      }

      return {
        types: [...grouped.values()].map((row) => ({
          label: DATA_TYPE_LABEL[row.dataType],
          byName: row.byName,
          atISO: row.atISO,
        })),
        scopes: scopes.length === fleet.length ? [] : scopes,
      };
    },
    [rows, fleet.length],
  );

  return { off, isPending: devices.isPending || results.some((result) => result.isPending) };
}
