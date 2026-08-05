/**
 * Which devices are *mine*, and how each one is doing.
 *
 * Pure so the two judgements it makes can be asserted: an employee must never be shown
 * somebody else's machine under a heading that says "yours", and a device that has
 * simply never checked in must not be described the same way as one that checked in a
 * minute ago.
 */

import type { MyDeviceRow } from "@/lib/queries/account";

/**
 * The devices belonging to one person, most recently heard from first.
 *
 * `GET /api/devices` filters to the caller only when the caller is an employee — a
 * manager or an admin is handed the whole company estate by design, because the same
 * endpoint feeds the inventory screen. So every "my" surface has to filter again, and
 * doing it here means it is done once and can be tested rather than being an `.filter()`
 * inside a component that renders correctly for the only role anyone tried it with.
 *
 * A device that has never reported sorts last: `null` is "no heartbeat ever", which is
 * the least current thing on the page rather than the most.
 */
export function ownDevices(
  devices: readonly MyDeviceRow[] | undefined,
  profileId: string | null | undefined,
): MyDeviceRow[] {
  if (!devices || !profileId) return [];

  return devices
    .filter((device) => device.profile_id === profileId)
    .sort((a, b) => lastSeenRank(b.last_seen_at) - lastSeenRank(a.last_seen_at));
}

function lastSeenRank(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export type DeviceReporting = "reporting" | "quiet" | "silent" | "never" | "revoked";

/** Past this, an agent that should be running is not running. */
const QUIET_AFTER_MS = 5 * 60_000;
const SILENT_AFTER_MS = 60 * 60_000;

/**
 * How this device is behaving, from its last heartbeat.
 *
 * Separate from `devices.status`, which is an administrative fact ("revoked") rather
 * than an observation. The distinction matters on this page because the reader is the
 * person whose machine it is: "your agent stopped reporting three hours ago" is
 * something they can act on, and "offline" — the word the inventory uses — is not.
 */
export function deviceReporting(
  device: Pick<MyDeviceRow, "status" | "last_seen_at">,
  now: number,
): DeviceReporting {
  if (device.status === "revoked") return "revoked";
  if (!device.last_seen_at) return "never";

  const seen = Date.parse(device.last_seen_at);
  if (!Number.isFinite(seen)) return "never";

  const age = now - seen;
  if (age <= QUIET_AFTER_MS) return "reporting";
  if (age <= SILENT_AFTER_MS) return "quiet";
  return "silent";
}

export interface ReportingCopy {
  label: string;
  /** Emerald / amber / muted, chosen by meaning rather than by the caller. */
  tone: "success" | "warning" | "muted";
  detail: string | null;
}

export function reportingCopy(state: DeviceReporting): ReportingCopy {
  switch (state) {
    case "reporting":
      return { label: "Reporting", tone: "success", detail: null };
    case "quiet":
      return {
        label: "Quiet",
        tone: "warning",
        detail: "This device has not checked in for a few minutes. It may be asleep or offline.",
      };
    case "silent":
      return {
        label: "Not reporting",
        tone: "warning",
        detail:
          "This device has not checked in for over an hour. If you are working on it, the agent may not be running.",
      };
    case "never":
      return {
        label: "Never reported",
        tone: "muted",
        detail: "This device was enrolled but has not sent anything yet.",
      };
    case "revoked":
      return {
        label: "Revoked",
        tone: "muted",
        detail:
          "An administrator revoked this device. It cannot collect anything, whatever its consent says.",
      };
  }
}

/** "Evan Laptop" — the name the person recognises, not the enrolment label. */
export function deviceTitle(device: Pick<MyDeviceRow, "device_name" | "label">): string {
  return device.device_name.trim() || device.label.trim() || "Unnamed device";
}
