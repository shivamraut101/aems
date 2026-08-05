import { describe, expect, it } from "vitest";

import { platformLabel, resolvePresence, type PresenceDevice, type PresenceLiveRow } from "./presence";

const now = new Date("2026-08-05T14:30:00.000Z").getTime();

function device(over: Partial<PresenceDevice> = {}): PresenceDevice {
  return {
    id: "d1",
    platform: "windows",
    label: "Work laptop",
    status: "active",
    last_seen_at: new Date(now - 30_000).toISOString(),
    ...over,
  };
}

function live(over: Partial<PresenceLiveRow> = {}): PresenceLiveRow {
  return { deviceId: "d1", status: "active", idleSince: null, ...over };
}

describe("resolvePresence", () => {
  it("is offline with no devices, and names no device it does not have", () => {
    const presence = resolvePresence([], [], now);

    expect(presence.status).toBe("offline");
    expect(presence.device).toBeNull();
    expect(presence.lastSeenAt).toBeNull();
  });

  it("ignores revoked devices — a revoked agent is not evidence of anything", () => {
    const presence = resolvePresence([device({ status: "revoked" })], [], now);

    expect(presence.status).toBe("offline");
    expect(presence.device).toBeNull();
  });

  it("speaks for the most recently seen device when a person has several", () => {
    const presence = resolvePresence(
      [
        device({ id: "old", label: "Old laptop", last_seen_at: new Date(now - 90_000).toISOString() }),
        device({ id: "new", label: "New laptop", last_seen_at: new Date(now - 10_000).toISOString() }),
      ],
      [],
      now,
    );

    expect(presence.device?.id).toBe("new");
    expect(presence.status).toBe("active");
  });

  it("calls a device that has gone quiet offline", () => {
    const presence = resolvePresence(
      [device({ last_seen_at: new Date(now - 5 * 60_000).toISOString() })],
      [],
      now,
    );

    expect(presence.status).toBe("offline");
    expect(presence.device?.id).toBe("d1");
  });

  it("is offline when a device has never reported at all", () => {
    expect(resolvePresence([device({ last_seen_at: null })], [], now).status).toBe("offline");
  });

  it("takes idle from the live board, which is the only thing that knows it", () => {
    const presence = resolvePresence(
      [device()],
      [live({ status: "idle", idleSince: "2026-08-05T14:05:00.000Z" })],
      now,
    );

    expect(presence.status).toBe("idle");
    expect(presence.idleSince).toBe("2026-08-05T14:05:00.000Z");
  });

  it("never invents idle without the live board — active or offline is all we know", () => {
    const presence = resolvePresence([device()], [], now);

    expect(presence.status).toBe("active");
    expect(presence.idleSince).toBeNull();
  });

  it("trusts the server's offline over a recent heartbeat", () => {
    expect(resolvePresence([device()], [live({ status: "offline" })], now).status).toBe("offline");
  });

  it("ignores a live row belonging to somebody else's device", () => {
    const presence = resolvePresence([device({ id: "mine" })], [live({ deviceId: "theirs", status: "idle" })], now);

    expect(presence.status).toBe("active");
  });

  it("clears idleSince whenever the status is not idle", () => {
    const presence = resolvePresence(
      [device()],
      [live({ status: "active", idleSince: "2026-08-05T09:00:00.000Z" })],
      now,
    );

    expect(presence.idleSince).toBeNull();
  });
});

describe("platformLabel", () => {
  it("writes platform names the way their vendors do", () => {
    expect(platformLabel("windows")).toBe("Windows");
    expect(platformLabel("macos")).toBe("macOS");
    expect(platformLabel("android")).toBe("Android");
  });
});
