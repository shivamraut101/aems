import { describe, expect, it, vi } from "vitest";

import type { DayTotals } from "../shared/types/index.js";
import { emptyTotals } from "../shared/types/index.js";
import type { NetworkInterfaceReading, TelemetryReaders } from "./telemetry.js";
import {
  BATTERY_CACHE_MS,
  createTelemetryReaders,
  networkTypeFrom,
  parseMacBatteryPercent,
  parseMacHardwarePorts,
  parseWindowsBatteryPercent,
  readTelemetry,
  TelemetryReporter,
  toMegabytes,
} from "./telemetry.js";

function iface(patch: Partial<NetworkInterfaceReading>): NetworkInterfaceReading {
  return {
    name: "Ethernet",
    address: "192.168.1.20",
    internal: false,
    mac: "aa:bb:cc:dd:ee:ff",
    ...patch,
  };
}

describe("networkTypeFrom", () => {
  it("reports offline when nothing carries a routable address", () => {
    expect(networkTypeFrom([iface({ name: "Loopback", internal: true, address: "127.0.0.1" })])).toBe(
      "offline",
    );
    expect(networkTypeFrom([])).toBe("offline");
  });

  it("reads the Windows adapter names the two supported link types actually use", () => {
    expect(networkTypeFrom([iface({ name: "Wi-Fi" })])).toBe("wifi");
    expect(networkTypeFrom([iface({ name: "Wi-Fi 2" })])).toBe("wifi");
    expect(networkTypeFrom([iface({ name: "Ethernet 3" })])).toBe("ethernet");
    expect(networkTypeFrom([iface({ name: "Local Area Connection" })])).toBe("ethernet");
  });

  it("recognises a tethered phone as cellular rather than as ethernet", () => {
    expect(networkTypeFrom([iface({ name: "Cellular" })])).toBe("cellular");
    expect(networkTypeFrom([iface({ name: "Mobile Broadband Connection" })])).toBe("cellular");
  });

  it("prefers wifi over ethernet for an adapter whose name contains both", () => {
    // Vendors ship "Wireless Ethernet Adapter"; reading that as a wired link would put
    // an ethernet badge on every laptop carrying one.
    expect(networkTypeFrom([iface({ name: "Intel Wireless Ethernet Adapter" })])).toBe("wifi");
  });

  it("ignores a link-local address, because nothing answered on it", () => {
    expect(networkTypeFrom([iface({ name: "Wi-Fi", address: "169.254.10.4" })])).toBe("offline");
    expect(networkTypeFrom([iface({ name: "Wi-Fi", address: "fe80::1c2d" })])).toBe("offline");
  });

  it("ignores the virtual adapters a developer machine is permanently 'connected' through", () => {
    // Docker Desktop and Hyper-V both leave a routable vEthernet up whether or not the
    // machine has any network, so without this every such box reports ethernet forever.
    const virtual = [
      iface({ name: "vEthernet (Default Switch)", address: "172.20.0.1" }),
      iface({ name: "Docker0", address: "172.17.0.1" }),
      iface({ name: "utun4", address: "10.8.0.2" }),
    ];

    expect(networkTypeFrom(virtual)).toBe("offline");
  });

  it("ignores a pseudo-adapter that reports no hardware address", () => {
    expect(networkTypeFrom([iface({ name: "Wi-Fi", mac: "00:00:00:00:00:00" })])).toBe("offline");
    expect(networkTypeFrom([iface({ name: "Wi-Fi", mac: undefined })])).toBe("offline");
  });

  it("returns null rather than guessing when a carrying adapter's name says nothing", () => {
    // The honest answer for an unrecognised link. `offline` would be a lie — something
    // is plainly connected — and a guess would put a wrong badge on a device row.
    expect(networkTypeFrom([iface({ name: "en0" })])).toBeNull();
  });

  it("resolves a macOS interface through its hardware port name", () => {
    const ports = new Map([
      ["en0", "Wi-Fi"],
      ["en5", "Thunderbolt Ethernet Slot 1"],
    ]);

    expect(networkTypeFrom([iface({ name: "en0" })], ports)).toBe("wifi");
    expect(networkTypeFrom([iface({ name: "en5" })], ports)).toBe("ethernet");
  });
});

describe("parseMacHardwarePorts", () => {
  it("maps each device to its hardware port", () => {
    const output = [
      "Hardware Port: Wi-Fi",
      "Device: en0",
      "Ethernet Address: 3c:22:fb:11:22:33",
      "",
      "Hardware Port: Thunderbolt Bridge",
      "Device: bridge0",
      "Ethernet Address: 36:22:fb:11:22:34",
      "",
      "VLAN Configurations",
      "===================",
      "",
    ].join("\n");

    const ports = parseMacHardwarePorts(output);

    expect(ports.get("en0")).toBe("Wi-Fi");
    expect(ports.get("bridge0")).toBe("Thunderbolt Bridge");
    expect(ports.size).toBe(2);
  });

  it("skips a stanza that names no device instead of mapping an empty key", () => {
    expect(parseMacHardwarePorts("Hardware Port: Bluetooth PAN\nEthernet Address: N/A\n").size).toBe(0);
  });
});

describe("parseWindowsBatteryPercent", () => {
  it("reads the percentage PowerShell prints", () => {
    expect(parseWindowsBatteryPercent("87\r\n")).toBe(87);
    expect(parseWindowsBatteryPercent("  100  \r\n")).toBe(100);
  });

  it("reports no battery for the empty output a desktop PC produces", () => {
    // A machine with no battery is not an error, and must not become one.
    expect(parseWindowsBatteryPercent("")).toBeNull();
    expect(parseWindowsBatteryPercent("\r\n\r\n")).toBeNull();
  });

  it("takes the first cell rather than averaging two", () => {
    expect(parseWindowsBatteryPercent("64\r\n0\r\n")).toBe(64);
  });

  it("refuses a percentage outside 0-100, which the API would reject wholesale", () => {
    expect(parseWindowsBatteryPercent("255\r\n")).toBeNull();
  });

  it("ignores a PowerShell error written into stdout", () => {
    expect(parseWindowsBatteryPercent("Get-CimInstance : Access is denied.\r\n")).toBeNull();
  });
});

describe("parseMacBatteryPercent", () => {
  const laptop = [
    "Now drawing from 'Battery Power'",
    " -InternalBattery-0 (id=12345)\t62%; discharging; 4:18 remaining present: true",
  ].join("\n");

  it("reads the percentage off the battery line", () => {
    expect(parseMacBatteryPercent(laptop)).toBe(62);
  });

  it("reports no battery for a Mac that has none", () => {
    expect(parseMacBatteryPercent("Now drawing from 'AC Power'\n")).toBeNull();
  });

  it("does not read the remaining-time figure as a percentage", () => {
    const charged = [
      "Now drawing from 'AC Power'",
      " -InternalBattery-0 (id=12345)\t100%; charged; 0:00 remaining present: true",
    ].join("\n");

    expect(parseMacBatteryPercent(charged)).toBe(100);
  });
});

describe("toMegabytes", () => {
  it("rounds to whole megabytes and passes zero through", () => {
    expect(toMegabytes(1024 * 1024 * 512)).toBe(512);
    // Unlike ramMb, storageFreeMb is validated as >= 0 — a genuinely full disk is
    // reportable, and omitting it would hide the one reading an admin needs.
    expect(toMegabytes(0)).toBe(0);
  });

  it("omits a reading the OS refused or that came back nonsensical", () => {
    expect(toMegabytes(null)).toBeNull();
    expect(toMegabytes(Number.NaN)).toBeNull();
    expect(toMegabytes(-1)).toBeNull();
  });
});

function readers(patch: Partial<TelemetryReaders> = {}): TelemetryReaders {
  return {
    batteryPercent: () => Promise.resolve(55),
    onBatteryPower: () => true,
    networkType: () => Promise.resolve("wifi"),
    freeStorageBytes: () => 200 * 1024 * 1024 * 1024,
    ...patch,
  };
}

const totals: DayTotals = {
  totalSeconds: 3600,
  activeSeconds: 3000,
  idleSeconds: 400,
  breakSeconds: 200,
};

describe("readTelemetry", () => {
  it("assembles the four fields the Devices table renders", async () => {
    expect(await readTelemetry(readers(), totals)).toEqual({
      batteryLevel: 55,
      batteryCharging: false,
      networkType: "wifi",
      storageFreeMb: 204_800,
      screenActiveSeconds: 3000,
    });
  });

  it("reports charging when the machine is on mains and has a battery", async () => {
    const sample = await readTelemetry(readers({ onBatteryPower: () => false }), totals);
    expect(sample.batteryCharging).toBe(true);
  });

  it("claims no charging state for a machine with no battery", async () => {
    // A desktop PC answers isOnBatteryPower() false. Forwarding that would put
    // "charging" on a device row that has nothing to charge.
    const sample = await readTelemetry(
      readers({ batteryPercent: () => Promise.resolve(null), onBatteryPower: () => false }),
      totals,
    );

    expect(sample.batteryLevel).toBeNull();
    expect(sample.batteryCharging).toBeNull();
  });

  it("still reports the other fields when one reader gives up", async () => {
    const sample = await readTelemetry(
      readers({ batteryPercent: () => Promise.resolve(null), freeStorageBytes: () => null }),
      totals,
    );

    expect(sample).toEqual({
      batteryLevel: null,
      batteryCharging: null,
      networkType: "wifi",
      storageFreeMb: null,
      screenActiveSeconds: 3000,
    });
  });

  it("never sends a negative screen-active time", async () => {
    const sample = await readTelemetry(readers(), { ...emptyTotals(), activeSeconds: -5 });
    expect(sample.screenActiveSeconds).toBe(0);
  });
});

describe("createTelemetryReaders", () => {
  it("caches the battery reading rather than spawning a shell every sample", async () => {
    let clock = 1_000;
    const isOnBatteryPower = vi.fn(() => true);

    const created = createTelemetryReaders({
      powerMonitor: { isOnBatteryPower },
      // A platform with no battery command, so the reader resolves without a subprocess
      // while still exercising the cache around it.
      platform: "linux",
      now: () => clock,
    });

    expect(await created.batteryPercent()).toBeNull();
    clock += BATTERY_CACHE_MS - 1;
    expect(await created.batteryPercent()).toBeNull();

    // The AC state is read fresh every time, because it is free.
    created.onBatteryPower();
    created.onBatteryPower();
    expect(isOnBatteryPower).toHaveBeenCalledTimes(2);
  });

  it("survives a powerMonitor that throws instead of losing the whole sample", () => {
    const created = createTelemetryReaders({
      powerMonitor: {
        isOnBatteryPower: () => {
          throw new Error("ACPI unavailable");
        },
      },
      platform: "linux",
    });

    expect(created.onBatteryPower()).toBeNull();
  });
});

describe("TelemetryReporter", () => {
  it("sends a sample and reports it as sent", async () => {
    const reportTelemetry = vi.fn(() => Promise.resolve({ ok: true as const }));
    const reporter = new TelemetryReporter({ reportTelemetry }, readers());

    expect(await reporter.report(totals)).toBe("sent");
    expect(reportTelemetry).toHaveBeenCalledWith({
      batteryLevel: 55,
      batteryCharging: false,
      networkType: "wifi",
      storageFreeMb: 204_800,
      screenActiveSeconds: 3000,
    });
  });

  it("passes the server's stop signals through, so the loop can act on them", async () => {
    const refuse = (code: string, statusCode: number) => ({
      reportTelemetry: () => Promise.reject(Object.assign(new Error(code), { code, statusCode })),
    });

    expect(await new TelemetryReporter(refuse("consent_required", 403), readers()).report(totals)).toBe(
      "consent-required",
    );
    expect(await new TelemetryReporter(refuse("device_revoked", 403), readers()).report(totals)).toBe(
      "revoked",
    );
  });

  it("treats an unreachable API as retry rather than as a verdict on the sample", async () => {
    const reporter = new TelemetryReporter(
      { reportTelemetry: () => Promise.reject(new Error("ECONNREFUSED")) },
      readers(),
    );

    expect(await reporter.report(totals)).toBe("retry");
  });

  it("does not send at all when assembling the sample throws", async () => {
    const reportTelemetry = vi.fn(() => Promise.resolve({ ok: true as const }));
    const reporter = new TelemetryReporter(
      { reportTelemetry },
      readers({
        networkType: () => Promise.reject(new Error("boom")),
      }),
    );

    expect(await reporter.report(totals)).toBe("retry");
    expect(reportTelemetry).not.toHaveBeenCalled();
  });
});
