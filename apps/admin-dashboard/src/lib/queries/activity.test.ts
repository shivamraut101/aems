import { describe, expect, it } from "vitest";

import type { EmployeeRow, LiveWorkforceRow } from "@/lib/api";

import { dateKeyOf, dayWindow, isFutureDateKey, rosterRows, shiftDateKey } from "./activity";

/* -------------------------------------------------------------------------- */
/* Day keys and windows                                                        */
/* -------------------------------------------------------------------------- */

describe("dateKeyOf", () => {
  it("reads the local calendar day, not the UTC one", () => {
    // 23:30 on the 4th in a UTC+2 zone is still the 4th to the person looking at it.
    const local = new Date(2026, 7, 4, 23, 30, 0);
    expect(dateKeyOf(local)).toBe("2026-08-04");
  });

  it("zero-pads single-digit months and days", () => {
    expect(dateKeyOf(new Date(2026, 0, 9, 12, 0, 0))).toBe("2026-01-09");
  });
});

describe("shiftDateKey", () => {
  it("steps backwards over a month boundary", () => {
    expect(shiftDateKey("2026-08-01", -1)).toBe("2026-07-31");
  });

  it("steps forwards over a year boundary", () => {
    expect(shiftDateKey("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("handles a leap day", () => {
    expect(shiftDateKey("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("isFutureDateKey", () => {
  it("is false for today and true for tomorrow", () => {
    const now = new Date(2026, 7, 5, 9, 0, 0);
    expect(isFutureDateKey("2026-08-05", now)).toBe(false);
    expect(isFutureDateKey("2026-08-04", now)).toBe(false);
    expect(isFutureDateKey("2026-08-06", now)).toBe(true);
  });
});

describe("dayWindow", () => {
  it("covers the whole local day for a day that has finished", () => {
    const now = new Date(2026, 7, 5, 9, 0, 0);
    const { from, to } = dayWindow("2026-08-04", now);

    expect(Date.parse(from)).toBe(new Date(2026, 7, 4, 0, 0, 0, 0).getTime());
    expect(Date.parse(to)).toBe(new Date(2026, 7, 5, 0, 0, 0, 0).getTime());
  });

  it("clips today to now, so the rest of the day is not reported as offline", () => {
    const now = new Date(2026, 7, 5, 14, 32, 10);
    const { to } = dayWindow("2026-08-05", now);

    expect(Date.parse(to)).toBe(now.getTime());
  });

  it("never returns an empty window, which the API refuses", () => {
    // Someone opening the dashboard seconds after local midnight.
    const now = new Date(2026, 7, 5, 0, 0, 3);
    const { from, to } = dayWindow("2026-08-05", now);

    expect(Date.parse(to)).toBeGreaterThan(Date.parse(from));
  });

  it("emits ISO instants the API's datetime({ offset: true }) accepts", () => {
    const { from, to } = dayWindow("2026-08-04", new Date(2026, 7, 5, 9, 0, 0));
    expect(from).toMatch(/Z$|[+-]\d{2}:\d{2}$/);
    expect(to).toMatch(/Z$|[+-]\d{2}:\d{2}$/);
  });
});

/* -------------------------------------------------------------------------- */
/* Roster                                                                      */
/* -------------------------------------------------------------------------- */

function employee(over: Partial<EmployeeRow> & { id: string }): EmployeeRow {
  return {
    email: `${over.id}@example.com`,
    full_name: over.id,
    role: "employee",
    department: null,
    manager_id: null,
    monitoring_enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    devices: [],
    ...over,
  };
}

function liveRow(over: Partial<LiveWorkforceRow> & { profileId: string }): LiveWorkforceRow {
  return {
    deviceId: `${over.profileId}-device`,
    platform: "windows",
    label: "Laptop",
    fullName: null,
    email: null,
    lastSeenAt: null,
    idleSince: null,
    status: "offline",
    ...over,
  };
}

describe("rosterRows", () => {
  it("joins live presence onto the roster by profile id", () => {
    const rows = rosterRows(
      [employee({ id: "a", full_name: "Ada" })],
      [liveRow({ profileId: "a", status: "idle", lastSeenAt: "2026-08-05T09:00:00Z" })],
      "name",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("idle");
    expect(rows[0]?.lastSeenAt).toBe("2026-08-05T09:00:00Z");
  });

  it("takes the most present device when someone has two", () => {
    // A laptop that is working and a phone that has not checked in is one active
    // person, not a coin toss on whichever device the API listed first.
    const rows = rosterRows(
      [employee({ id: "a" })],
      [
        liveRow({ profileId: "a", deviceId: "phone", status: "offline", lastSeenAt: "2026-08-05T07:00:00Z" }),
        liveRow({ profileId: "a", deviceId: "laptop", status: "active", label: "Work laptop", lastSeenAt: "2026-08-05T09:00:00Z" }),
      ],
      "name",
    );

    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.deviceLabel).toBe("Work laptop");
  });

  it("falls back to the enrolled device's last heartbeat when nothing is live", () => {
    const rows = rosterRows(
      [
        employee({
          id: "a",
          devices: [
            {
              id: "d1",
              platform: "macos",
              label: "MacBook",
              status: "offline",
              last_seen_at: "2026-08-04T17:02:00Z",
            },
          ],
        }),
      ],
      [],
      "name",
    );

    expect(rows[0]?.status).toBe("offline");
    expect(rows[0]?.lastSeenAt).toBe("2026-08-04T17:02:00Z");
    expect(rows[0]?.deviceLabel).toBe("MacBook");
  });

  it("sorts by name without letting case decide the order", () => {
    const rows = rosterRows(
      [employee({ id: "1", full_name: "zoe" }), employee({ id: "2", full_name: "Ada" })],
      [],
      "name",
    );

    expect(rows.map((row) => row.name)).toEqual(["Ada", "zoe"]);
  });

  it("sorts by activity: present first, then most recently seen", () => {
    const rows = rosterRows(
      [
        employee({ id: "off", full_name: "Offline" }),
        employee({ id: "idle", full_name: "Idle" }),
        employee({ id: "old", full_name: "ActiveEarlier" }),
        employee({ id: "new", full_name: "ActiveNow" }),
      ],
      [
        liveRow({ profileId: "idle", status: "idle", lastSeenAt: "2026-08-05T09:00:00Z" }),
        liveRow({ profileId: "old", status: "active", lastSeenAt: "2026-08-05T08:00:00Z" }),
        liveRow({ profileId: "new", status: "active", lastSeenAt: "2026-08-05T09:30:00Z" }),
      ],
      "activity",
    );

    expect(rows.map((row) => row.name)).toEqual(["ActiveNow", "ActiveEarlier", "Idle", "Offline"]);
  });

  it("uses the email when a profile has no name, never a blank row", () => {
    const rows = rosterRows([employee({ id: "a", full_name: "", email: "nobody@example.com" })], [], "name");
    expect(rows[0]?.name).toBe("nobody@example.com");
  });
});
