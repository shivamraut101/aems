import { describe, expect, it } from "vitest";

import type { MyDeviceRow } from "@/lib/queries/account";

import { deviceReporting, deviceTitle, ownDevices, reportingCopy } from "./device-list";

const NOW = Date.parse("2026-08-05T15:00:00.000Z");

function device(overrides: Partial<MyDeviceRow> & Pick<MyDeviceRow, "id" | "profile_id">): MyDeviceRow {
  return {
    platform: "windows",
    label: "Laptop",
    device_name: "EVAN-WIN11",
    os_version: "11",
    agent_version: "0.1.0",
    is_primary: false,
    model: null,
    cpu: null,
    ram_mb: null,
    storage_mb: null,
    status: "active",
    last_seen_at: null,
    enrolled_at: "2026-08-01T00:00:00.000Z",
    browser_extension_linked: null,
    browser_extension_version: null,
    browser_extension_seen_at: null,
    browser_extension_count: null,
    website_addresses_recorded: null,
    ...overrides,
  };
}

describe("ownDevices", () => {
  /**
   * The case this function exists for. `GET /api/devices` filters by profile only for
   * an employee — a manager or admin is handed the whole company — so a page titled
   * "My devices" that trusted the endpoint would show a manager everyone's hardware and
   * offer them a consent-withdrawal button for a machine that is not theirs.
   */
  it("keeps only the signed-in person's devices", () => {
    const rows = [
      device({ id: "a", profile_id: "me" }),
      device({ id: "b", profile_id: "someone-else" }),
    ];

    expect(ownDevices(rows, "me").map((row) => row.id)).toEqual(["a"]);
  });

  it("returns nothing before the session is known, rather than everything", () => {
    const rows = [device({ id: "a", profile_id: "me" })];

    expect(ownDevices(rows, null)).toEqual([]);
    expect(ownDevices(rows, undefined)).toEqual([]);
    expect(ownDevices(undefined, "me")).toEqual([]);
  });

  it("puts the most recently heard-from device first", () => {
    const rows = [
      device({ id: "old", profile_id: "me", last_seen_at: "2026-08-05T10:00:00.000Z" }),
      device({ id: "new", profile_id: "me", last_seen_at: "2026-08-05T14:59:00.000Z" }),
    ];

    expect(ownDevices(rows, "me").map((row) => row.id)).toEqual(["new", "old"]);
  });

  it("sorts a device that has never reported last, not first", () => {
    const rows = [
      device({ id: "never", profile_id: "me", last_seen_at: null }),
      device({ id: "seen", profile_id: "me", last_seen_at: "2026-08-05T10:00:00.000Z" }),
    ];

    expect(ownDevices(rows, "me").map((row) => row.id)).toEqual(["seen", "never"]);
  });
});

describe("deviceReporting", () => {
  it("calls a recent heartbeat reporting", () => {
    const row = device({ id: "a", profile_id: "me", last_seen_at: "2026-08-05T14:59:00.000Z" });
    expect(deviceReporting(row, NOW)).toBe("reporting");
  });

  it("calls a few minutes of silence quiet", () => {
    const row = device({ id: "a", profile_id: "me", last_seen_at: "2026-08-05T14:50:00.000Z" });
    expect(deviceReporting(row, NOW)).toBe("quiet");
  });

  it("calls an hour of silence not reporting", () => {
    const row = device({ id: "a", profile_id: "me", last_seen_at: "2026-08-05T10:00:00.000Z" });
    expect(deviceReporting(row, NOW)).toBe("silent");
  });

  it("separates never-reported from stopped-reporting", () => {
    const row = device({ id: "a", profile_id: "me", last_seen_at: null });
    expect(deviceReporting(row, NOW)).toBe("never");
  });

  /**
   * A revoked device is an administrative fact that outranks the clock: it cannot
   * collect anything whatever its last heartbeat said, so describing it as "reporting"
   * because it beat a minute ago would be actively misleading.
   */
  it("lets a revocation outrank a fresh heartbeat", () => {
    const row = device({
      id: "a",
      profile_id: "me",
      status: "revoked",
      last_seen_at: "2026-08-05T14:59:59.000Z",
    });

    expect(deviceReporting(row, NOW)).toBe("revoked");
  });

  it("does not treat an unparseable timestamp as a heartbeat", () => {
    const row = device({ id: "a", profile_id: "me", last_seen_at: "not-a-date" });
    expect(deviceReporting(row, NOW)).toBe("never");
  });
});

describe("reportingCopy", () => {
  it("only paints the healthy state as success", () => {
    expect(reportingCopy("reporting").tone).toBe("success");
    expect(reportingCopy("quiet").tone).toBe("warning");
    expect(reportingCopy("silent").tone).toBe("warning");
  });

  it("explains what a person can do about a silent agent", () => {
    expect(reportingCopy("silent").detail).toContain("agent may not be running");
  });

  it("says a revoked device cannot collect regardless of consent", () => {
    expect(reportingCopy("revoked").detail).toContain("whatever its consent says");
  });
});

describe("deviceTitle", () => {
  it("prefers the reported machine name", () => {
    expect(deviceTitle({ device_name: "EVAN-WIN11", label: "Evan Laptop" })).toBe("EVAN-WIN11");
  });

  it("falls back to the enrolment label, then to a word rather than a blank", () => {
    expect(deviceTitle({ device_name: "  ", label: "Evan Laptop" })).toBe("Evan Laptop");
    expect(deviceTitle({ device_name: "", label: "" })).toBe("Unnamed device");
  });
});
