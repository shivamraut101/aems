/**
 * Battery, network, free storage and screen-active time (scope §7, "Device Inventory").
 *
 * These are the four columns the Devices table renders per device, and until this
 * module existed every one of them was a permanent em-dash: `reportTelemetry()` was in
 * the SDK and `POST /api/devices/telemetry` was in the API, and nothing anywhere called
 * either.
 *
 * Three of the four are answered inside this process — `node:fs` for the volume,
 * `node:os` for the interfaces, Electron's `powerMonitor` for the AC state. Only the
 * battery *percentage* has no in-process source on either platform, so it is the one
 * reading that costs a subprocess; it is cached, deadlined, and degrades to `null`
 * rather than throwing, because a desktop PC has no battery and that is not a fault.
 */

import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { promisify } from "node:util";

import type { NetworkType, TelemetryInput } from "@aems/types";

import type { DayTotals } from "../shared/types/index.js";
import type { SyncOutcome } from "./sync.js";
import { classifyError } from "./sync.js";

/**
 * How often a sample is sent — the heartbeat cadence.
 *
 * Telemetry rides alongside the heartbeat rather than on its own schedule because both
 * answer the same question ("what is this machine doing right now"), and a device row
 * whose `last_seen_at` is 20 seconds old but whose battery is an hour old reads as a
 * bug in the dashboard rather than as two different cadences.
 */
export const TELEMETRY_INTERVAL_MS = 60_000;

/**
 * How long a battery percentage may be reused before the OS is asked again.
 *
 * The reading costs a `powershell.exe` (Windows) or `pmset` (macOS) spawn, and a
 * battery moves by a percent over minutes. Spawning a shell every sixty seconds for
 * the life of an agent — on every employee's laptop — is the kind of cost that gets a
 * monitoring agent uninstalled, so the *sample* stays on the heartbeat cadence and the
 * expensive half of it does not.
 */
export const BATTERY_CACHE_MS = 5 * 60_000;

/**
 * How long the battery subprocess may run.
 *
 * PowerShell's own startup is a large part of this. A machine where WMI is wedged, or
 * where AppLocker refuses the interpreter outright, must cost one null reading rather
 * than a hung collection tick — `Collector.tick()` holds its re-entrancy latch across
 * this call.
 */
export const BATTERY_TIMEOUT_MS = 4_000;

// -- network --------------------------------------------------------------

/**
 * One entry of `os.networkInterfaces()`, reduced to what classification needs.
 *
 * Declared rather than imported from `node:os` so the pure functions below can be
 * exercised against fixtures for a platform this machine is not.
 */
export interface NetworkInterfaceReading {
  name: string;
  address: string;
  internal: boolean;
  /** Absent on a pseudo-adapter that reports no hardware address. */
  mac?: string;
}

/**
 * Names that prove what a link is.
 *
 * Matched against the interface name on Windows ("Wi-Fi", "Ethernet 2") and against
 * the *hardware port* name on macOS, where the interface itself is only ever called
 * `enN`. Ordered most-specific first: "Wi-Fi" must not be read as an Ethernet because
 * some vendor called the adapter "Wireless Ethernet Adapter".
 */
const LINK_PATTERNS: readonly { type: NetworkType; pattern: RegExp }[] = [
  { type: "cellular", pattern: /cellular|wwan|mobile\s*broadband|\bpdp_ip\d|\brmnet/i },
  { type: "wifi", pattern: /wi[-\s]?fi|wlan|wireless|airport|\bwlp\d/i },
  { type: "ethernet", pattern: /ethernet|local\s+area\s+connection|^eth\d|^enp?\d+s\d/i },
];

/**
 * Virtual adapters that are up whenever their software is installed.
 *
 * A machine with Docker Desktop or Hyper-V has a permanently "connected" `vEthernet`
 * with a routable address, so without this every such Windows box reports `ethernet`
 * regardless of whether it has any network at all — which makes the column worse than
 * empty, because it is confidently wrong.
 */
const VIRTUAL_ADAPTERS =
  /^(v?ethernet\s*\(|vmnet|vboxnet|docker|br-|veth|utun|ipsec|ppp|tap|tun|zt|wg|bridge|awdl|llw|anpi|ap\d)/i;

/** Link-local: an address the OS assigned itself because nothing answered. */
function isLinkLocal(address: string): boolean {
  return address.startsWith("169.254.") || /^fe80:/i.test(address);
}

/**
 * A pseudo-adapter's all-zero MAC. Loopback aliases and some VPN clients report it,
 * and they are not the link that carries the employee's traffic.
 */
function hasHardware(reading: NetworkInterfaceReading): boolean {
  return reading.mac !== undefined && reading.mac !== "00:00:00:00:00:00";
}

function isCarrying(reading: NetworkInterfaceReading): boolean {
  if (reading.internal) return false;
  if (isLinkLocal(reading.address)) return false;
  if (VIRTUAL_ADAPTERS.test(reading.name)) return false;
  return hasHardware(reading);
}

function classifyLink(label: string): NetworkType | null {
  return LINK_PATTERNS.find(({ pattern }) => pattern.test(label))?.type ?? null;
}

/**
 * Which kind of link this machine is on, or `null` when the names do not say.
 *
 * `offline` is claimed only when *no* interface carries a routable address, which is a
 * fact rather than an inference. Everything else rests on the adapter's name, so an
 * unrecognised one yields `null` — the column is then blank, which is honest, instead
 * of showing a manager an ethernet badge on a phone tether.
 *
 * `portNames` maps interface → hardware port and is macOS-only: `os.networkInterfaces()`
 * there reports `en0`, which is Wi-Fi on a laptop and Ethernet on a Mac mini. Guessing
 * between them from the digit is exactly the kind of confident wrongness this whole
 * function is written to avoid.
 */
export function networkTypeFrom(
  readings: readonly NetworkInterfaceReading[],
  portNames: ReadonlyMap<string, string> = new Map(),
): NetworkType | null {
  const carrying = readings.filter(isCarrying);
  if (carrying.length === 0) return "offline";

  for (const reading of carrying) {
    const type = classifyLink(portNames.get(reading.name) ?? reading.name);
    if (type !== null) return type;
  }

  return null;
}

/** Flattens `os.networkInterfaces()` into the reading shape the classifier takes. */
export function readNetworkInterfaces(): NetworkInterfaceReading[] {
  const readings: NetworkInterfaceReading[] = [];

  for (const [name, infos] of Object.entries(networkInterfaces())) {
    for (const info of infos ?? []) {
      readings.push({
        name,
        address: info.address,
        internal: info.internal,
        mac: info.mac,
      });
    }
  }

  return readings;
}

/**
 * Parses `networksetup -listallhardwareports`.
 *
 * The only supported way to learn that `en0` is the Wi-Fi radio. The output is stanzas
 * of `Hardware Port:` / `Device:` / `Ethernet Address:`; a stanza with no device (a
 * VLAN or a bridge member) is skipped rather than mapped to an empty key.
 */
export function parseMacHardwarePorts(stdout: string): Map<string, string> {
  const ports = new Map<string, string>();
  let port: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const portMatch = /^Hardware Port:\s*(.+?)\s*$/.exec(line);
    if (portMatch?.[1] !== undefined) {
      port = portMatch[1];
      continue;
    }

    const deviceMatch = /^Device:\s*(\S+)\s*$/.exec(line);
    if (deviceMatch?.[1] !== undefined && port !== null) {
      ports.set(deviceMatch[1], port);
      port = null;
    }
  }

  return ports;
}

// -- battery --------------------------------------------------------------

/**
 * Reads `Win32_Battery.EstimatedChargeRemaining` out of PowerShell's stdout.
 *
 * A machine with no battery prints nothing at all, which is the desktop-PC case and
 * must read as "no battery" rather than as a failure. A machine with two batteries
 * prints two lines; the first is taken rather than averaged, because the dashboard
 * shows one percentage and an average of a full and an absent cell is a number that
 * describes neither.
 */
export function parseWindowsBatteryPercent(stdout: string): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d{1,3})\s*$/.exec(line);
    if (match?.[1] === undefined) continue;

    return clampPercent(Number.parseInt(match[1], 10));
  }

  return null;
}

/**
 * Reads a percentage out of `pmset -g batt`.
 *
 * Its first line is always `Now drawing from '...'`; the battery line only exists when
 * one is fitted, so a Mac mini yields null here exactly as a desktop PC does on
 * Windows. The percentage is matched on the battery line specifically — the header can
 * contain a number, and "0:43 remaining" on the same line must not be read as one.
 */
export function parseMacBatteryPercent(stdout: string): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!/-InternalBattery/i.test(line)) continue;

    const match = /(\d{1,3})%/.exec(line);
    if (match?.[1] === undefined) continue;

    return clampPercent(Number.parseInt(match[1], 10));
  }

  return null;
}

/**
 * The API rejects the whole sample outside 0-100, and a rejected sample takes the
 * storage and network readings down with it. A nonsense percentage costs its own field.
 */
function clampPercent(value: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

// -- storage --------------------------------------------------------------

/**
 * Bytes an unprivileged process may still write on the volume holding `path`.
 *
 * `bavail` rather than `bfree`: the difference is the reserve only root may use, and
 * reporting that as free space tells an administrator a disk has room it does not have.
 * `statfs` is a syscall — the same choice `device.ts` made, and the reason there is no
 * WMI round trip here either.
 */
export function readFreeStorageBytes(path: string = homedir()): number | null {
  try {
    const { bsize, bavail } = statfsSync(path);
    return bsize * bavail;
  } catch {
    return null;
  }
}

/** The API validates `storageFreeMb` as a non-negative int, so a bad reading is omitted. */
export function toMegabytes(bytes: number | null): number | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  return Math.round(bytes / 1024 / 1024);
}

// -- the readers ----------------------------------------------------------

/**
 * Everything this module reads from outside itself.
 *
 * Injected wholesale so the sample assembly — which is where the compliance-relevant
 * decisions live, like refusing to claim a charging state for a machine with no
 * battery — is exercisable in a plain Node process on either platform.
 */
export interface TelemetryReaders {
  /** Percentage, or null when the machine has no battery or would not say. */
  batteryPercent(): Promise<number | null>;
  /** Electron's `powerMonitor.isOnBatteryPower()`. Null where it cannot be read. */
  onBatteryPower(): boolean | null;
  networkType(): Promise<NetworkType | null>;
  freeStorageBytes(): number | null;
}

/**
 * Assembles one sample.
 *
 * `batteryCharging` is deliberately null whenever the percentage is null. On a desktop
 * PC `isOnBatteryPower()` answers `false`, and forwarding that would put "charging" on
 * a machine with nothing to charge — a claim the dashboard would render as a fact.
 */
export async function readTelemetry(
  readers: TelemetryReaders,
  totals: DayTotals,
): Promise<TelemetryInput> {
  const [batteryLevel, networkType] = await Promise.all([
    readers.batteryPercent(),
    readers.networkType(),
  ]);

  const onBattery = readers.onBatteryPower();

  return {
    batteryLevel,
    batteryCharging: batteryLevel === null || onBattery === null ? null : !onBattery,
    networkType,
    storageFreeMb: toMegabytes(readers.freeStorageBytes()),
    // Time the machine was actually being used today, which is what the agent can
    // honestly answer for "screen active" — it is `DayTotals.activeSeconds`, the same
    // number the tray and the agent window show, so the two can never disagree.
    screenActiveSeconds: Math.max(0, Math.round(totals.activeSeconds)),
  };
}

// -- the real readers -----------------------------------------------------

const run = promisify(execFile);

/**
 * Runs a short OS query, answering "" rather than throwing.
 *
 * Every caller is on the telemetry path, and every one of them has a defined answer
 * for "the OS would not say": null. A rejected promise here would instead abort the
 * whole sample, so a machine whose battery cannot be read would also stop reporting
 * its free storage.
 */
async function tryRun(file: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run(file, [...args], {
      timeout: BATTERY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

/**
 * The battery percentage, per platform.
 *
 * Windows has no in-process source at all — `powerMonitor` reports the AC state and
 * nothing else — so this is the one place the agent spawns PowerShell. `device.ts`
 * rejected `systeminformation` partly *because* it spawns PowerShell per call; the
 * difference is that this asks for something `node:os` genuinely cannot answer, it
 * happens at most once every five minutes, and an AppLocker refusal degrades to a null
 * percentage instead of to a broken inventory.
 *
 * `-NoProfile -NonInteractive` and no `-ExecutionPolicy` switch: a profile can print
 * banner text that would be parsed as output, and an agent that passes `Bypass` looks
 * to an EDR exactly like something trying not to be stopped.
 */
export function readBatteryPercent(platform: NodeJS.Platform = process.platform): Promise<number | null> {
  if (platform === "win32") {
    return tryRun("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance -ClassName Win32_Battery | Select-Object -ExpandProperty EstimatedChargeRemaining",
    ]).then(parseWindowsBatteryPercent);
  }

  if (platform === "darwin") {
    return tryRun("/usr/bin/pmset", ["-g", "batt"]).then(parseMacBatteryPercent);
  }

  return Promise.resolve(null);
}

/** Reads the macOS interface → hardware-port map. Empty everywhere else. */
export async function readMacHardwarePorts(
  platform: NodeJS.Platform = process.platform,
): Promise<Map<string, string>> {
  if (platform !== "darwin") return new Map();
  return parseMacHardwarePorts(await tryRun("/usr/sbin/networksetup", ["-listallhardwareports"]));
}

/**
 * The production readers, with the two subprocess-backed ones cached.
 *
 * `powerMonitor` is passed in rather than imported: it does not exist until the app is
 * ready, and importing `electron` at module scope would drag the runtime into every
 * unit test that touches this file.
 */
export function createTelemetryReaders(options: {
  powerMonitor: { isOnBatteryPower(): boolean };
  platform?: NodeJS.Platform;
  now?: () => number;
}): TelemetryReaders {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;

  let battery: { value: number | null; at: number } | null = null;
  let ports: { value: Map<string, string>; at: number } | null = null;

  return {
    batteryPercent: async () => {
      if (battery !== null && now() - battery.at < BATTERY_CACHE_MS) return battery.value;

      const value = await readBatteryPercent(platform);
      battery = { value, at: now() };
      return value;
    },

    onBatteryPower: () => {
      try {
        return options.powerMonitor.isOnBatteryPower();
      } catch {
        // Reported on some virtualised Windows guests as an ACPI failure. One
        // unreadable field must not cost the sample it travels in.
        return null;
      }
    },

    networkType: async () => {
      // Hardware ports change when a dongle is plugged in, so the map is cached rather
      // than resolved once — on the same clock as the battery, since neither moves fast.
      if (ports === null || now() - ports.at >= BATTERY_CACHE_MS) {
        ports = { value: await readMacHardwarePorts(platform), at: now() };
      }

      return networkTypeFrom(readNetworkInterfaces(), ports.value);
    },

    freeStorageBytes: () => readFreeStorageBytes(),
  };
}

// -- the reporter ---------------------------------------------------------

/** The one SDK method this needs, narrowed so a test substitutes a fake. */
export interface TelemetryApiClient {
  reportTelemetry(body: TelemetryInput): Promise<{ ok: true }>;
}

/**
 * Sends one sample and classifies the answer.
 *
 * Deliberately *not* buffered through `SyncQueue`. Everything in that queue is an
 * observation with a timestamp, replayable weeks later; a battery percentage is only
 * true at the instant it is read, so a week-old sample flushed after an outage would
 * put a stale reading on a device row and date it as current. A dropped sample is
 * simply the next one, sixty seconds later.
 *
 * The outcome matters even though the payload does not: `/api/devices/telemetry` is
 * consent-gated, so it is one more place the server can tell the agent that consent has
 * lapsed or the device has been revoked — and the loop acts on that exactly as it does
 * for a flush.
 */
export class TelemetryReporter {
  constructor(
    private readonly client: TelemetryApiClient,
    private readonly readers: TelemetryReaders,
  ) {}

  async report(totals: DayTotals): Promise<SyncOutcome> {
    let sample: TelemetryInput;

    try {
      sample = await readTelemetry(this.readers, totals);
    } catch {
      // The readers each degrade to null on their own, so reaching here means something
      // outside them failed. Nothing was sent, so nothing was refused: "retry" keeps the
      // loop's stop signals meaning what they say.
      return "retry";
    }

    try {
      await this.client.reportTelemetry(sample);
    } catch (error) {
      return classifyError(error);
    }

    return "sent";
  }
}
