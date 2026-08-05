/**
 * "Is this person working right now?", answered from what we actually know.
 *
 * Two sources with different authority. A device row carries `last_seen_at`, which is
 * enough to separate *reporting* from *gone*. Only the live board joins the open
 * `idle_events` row, so it is the only thing that can say Idle — scope §4.3's amber
 * row. Where the live board is absent (an employee reading their own page cannot call
 * a manager endpoint), this reports Active or Offline and never guesses at the third
 * state.
 */

export type PresenceStatus = "active" | "idle" | "offline";

export type DevicePlatform = "windows" | "macos" | "android";

/** The device columns presence needs. A full row is assignable. */
export interface PresenceDevice {
  id: string;
  platform: DevicePlatform;
  label: string;
  status: "active" | "offline" | "revoked";
  last_seen_at: string | null;
}

/** One row of `GET /api/analytics/live`, narrowed to what presence reads. */
export interface PresenceLiveRow {
  deviceId: string;
  status: PresenceStatus;
  idleSince: string | null;
}

export interface Presence {
  status: PresenceStatus;
  /** The device being spoken for. Null when the person has enrolled none. */
  device: PresenceDevice | null;
  lastSeenAt: string | null;
  /** When the current idle stretch began. Only ever set while `status` is "idle". */
  idleSince: string | null;
}

/**
 * How long a device may go quiet before it is called offline.
 *
 * Same two minutes the API uses (`OFFLINE_AFTER_MS` in `routes/analytics.ts`). Two
 * thresholds would let the header and the live board disagree about the same person
 * on the same screen.
 */
export const OFFLINE_AFTER_MS = 2 * 60 * 1000;

const PLATFORM_LABEL: Record<DevicePlatform, string> = {
  windows: "Windows",
  macos: "macOS",
  android: "Android",
};

export function platformLabel(platform: DevicePlatform): string {
  return PLATFORM_LABEL[platform];
}

function seenAt(device: PresenceDevice): number {
  const parsed = device.last_seen_at ? Date.parse(device.last_seen_at) : NaN;
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

export function resolvePresence(
  devices: readonly PresenceDevice[],
  live: readonly PresenceLiveRow[],
  now: number = Date.now(),
): Presence {
  // A revoked device is not evidence: its token no longer works, so whatever it last
  // reported says nothing about where the person is now.
  const usable = devices.filter((device) => device.status !== "revoked");

  if (usable.length === 0) {
    return { status: "offline", device: null, lastSeenAt: null, idleSince: null };
  }

  // The most recently heard-from device speaks for the person. A laptop and a phone
  // both enrolled is normal, and the quiet one is not the interesting answer.
  const device = usable.reduce((newest, candidate) =>
    seenAt(candidate) > seenAt(newest) ? candidate : newest,
  );

  const row = live.find((entry) => entry.deviceId === device.id);
  const lastSeen = seenAt(device);
  const reporting = Number.isFinite(lastSeen) && now - lastSeen < OFFLINE_AFTER_MS;

  const status: PresenceStatus = row ? row.status : reporting ? "active" : "offline";

  return {
    status,
    device,
    lastSeenAt: device.last_seen_at,
    // Carried only while the state it describes is the current one; a stale timestamp
    // beside "Active" would claim the person is idle after they came back.
    idleSince: status === "idle" ? (row?.idleSince ?? null) : null,
  };
}
