import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, homedir, hostname, totalmem } from "node:os";
import { basename } from "node:path/posix";
import { promisify } from "node:util";

import type { DeviceEnrollmentRequest, DevicePlatform, InstalledApplication } from "@aems/types";

/**
 * The raw OS readings the enrolment payload is built from.
 *
 * Split out from `collectDeviceFacts` so the mapping rules below can be tested
 * without an Electron runtime or a particular machine underneath them.
 */
export interface DeviceHostFacts {
  /** `process.platform` verbatim — mapping it is this module's job, not the caller's. */
  platform: string;
  hostname: string;
  osVersion: string;
  agentVersion: string;
  cpuModel: string | null;
  totalMemoryBytes: number;
  totalStorageBytes: number | null;
  /**
   * Make and model, e.g. `LENOVO 21CB` or `MacBookPro18,3`.
   *
   * Read separately from everything else in this interface because it is the only
   * field with no in-process source — see {@link readMachineModel}. Null until that
   * subprocess answers, which is why the Devices table read "Unknown model" for every
   * enrolled machine: nothing ever put a value here.
   */
  model: string | null;
}

/**
 * Node's platform ids are not the API's enum, and the difference is not cosmetic:
 * the Tauri build used `if windows { windows } else { macos }`, so every Linux or
 * BSD build enrolled itself as a Mac. Anything unrecognised is refused rather than
 * guessed, because a wrong platform silently mis-attributes a whole device.
 */
function toDevicePlatform(nodePlatform: string): DevicePlatform {
  if (nodePlatform === "win32") return "windows";
  if (nodePlatform === "darwin") return "macos";
  throw new Error(`Unsupported platform "${nodePlatform}"`);
}

export function collectDeviceFacts(
  host: DeviceHostFacts = readHostFacts(),
): DeviceEnrollmentRequest {
  return {
    platform: toDevicePlatform(host.platform),
    label: host.hostname,
    deviceName: host.hostname,
    osVersion: host.osVersion,
    agentVersion: host.agentVersion,
    // The API validates `model` as an optional string of at most 120 characters, and
    // rejects the whole enrolment past it. `undefined` rather than `null` because the
    // field is `model?: string` — a null would fail the schema and cost the enrolment.
    model: withinLimit(host.model, 120),
    cpu: host.cpuModel,
    ramMb: toMegabytes(host.totalMemoryBytes),
    storageMb: toMegabytes(host.totalStorageBytes),
  };
}

function withinLimit(value: string | null, max: number): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/**
 * The API validates `ramMb` and `storageMb` as positive ints, so anything that
 * rounds to zero — or a reading the OS refused to give — is omitted rather than
 * sent. One unreadable field must not fail the whole enrolment.
 */
function toMegabytes(bytes: number | null): number | null {
  if (bytes === null || !Number.isFinite(bytes)) return null;
  const mb = Math.round(bytes / 1024 / 1024);
  return mb > 0 ? mb : null;
}

const requireHere = createRequire(import.meta.url);

/**
 * Deliberately no `systeminformation`: it spawns PowerShell per call, which is
 * restricted by AppLocker in exactly the enterprises this ships into, to obtain
 * fields `node:os` already has. `process.getSystemVersion()` is what gives the
 * macOS marketing version instead of the Darwin kernel version.
 */
export function readHostFacts(): DeviceHostFacts {
  return {
    platform: process.platform,
    hostname: hostname(),
    osVersion: process.getSystemVersion(),
    agentVersion: readAgentVersion(),
    cpuModel: cpus()[0]?.model ?? null,
    totalMemoryBytes: totalmem(),
    totalStorageBytes: readVolumeBytes(homedir()),
    // Filled in by `collectEnrollmentRequest`, which can await the subprocess this
    // synchronous reader cannot.
    model: null,
  };
}

/**
 * Everything `collectDeviceFacts` needs, including the one field that costs an OS call.
 *
 * This is what `index.ts` calls at enrolment. `collectDeviceFacts` stays synchronous
 * and pure so its mapping rules — the platform refusal, the megabyte rounding, the
 * length caps — remain testable without a process spawn.
 */
export async function collectEnrollmentRequest(): Promise<DeviceEnrollmentRequest> {
  const [model, installedMemoryBytes] = await Promise.all([
    readMachineModel(),
    readInstalledMemoryBytes(),
  ]);

  const host = readHostFacts();

  return collectDeviceFacts({
    ...host,
    model,
    // `readHostFacts` reports usable memory because it is synchronous and cannot
    // await a subprocess. Prefer the installed figure when the OS gave us one.
    totalMemoryBytes: installedMemoryBytes ?? host.totalMemoryBytes,
  });
}

/**
 * `SystemManufacturer` + `SystemProductName` out of `reg query`'s BIOS key.
 *
 * These are the values Windows itself shows in System Information, and they are the
 * two halves of what an IT administrator calls "the model" — the product name alone is
 * often a bare code like `21CB`, which identifies nothing without the maker in front
 * of it. Vendors leave placeholder strings in either field on white-box machines, so
 * those are dropped rather than reported as a model.
 */
export function parseWindowsModel(output: string): string | null {
  const values = new Map<string, string>();

  for (const line of output.split(/\r?\n/)) {
    const value = REG_VALUE_LINE.exec(line);
    if (value?.[1] !== undefined) values.set(value[1], (value[2] ?? "").trim());
  }

  const parts = [values.get("SystemManufacturer"), values.get("SystemProductName")]
    .map((part) => (part === undefined || isPlaceholderModel(part) ? null : part))
    .filter((part): part is string => part !== null);

  return parts.length === 0 ? null : [...new Set(parts)].join(" ");
}

/**
 * The strings vendors ship when they never filled the field in.
 *
 * "System manufacturer System Product Name" on a device row is worse than the em-dash
 * it replaced: it looks like a real reading and tells an administrator nothing.
 */
const MODEL_PLACEHOLDERS = new Set([
  "system manufacturer",
  "system product name",
  "to be filled by o.e.m.",
  "to be filled by oem",
  "default string",
  "not specified",
  "not applicable",
  "none",
  "n/a",
  "o.e.m.",
  "oem",
  "unknown",
]);

function isPlaceholderModel(value: string): boolean {
  const normalised = value.trim().toLowerCase();
  return normalised.length === 0 || MODEL_PLACEHOLDERS.has(normalised);
}

/** `sysctl -n hw.model` prints one line: `MacBookPro18,3`, `Macmini9,1`. */
export function parseMacModel(output: string): string | null {
  const trimmed = output.trim();
  return trimmed.length === 0 || isPlaceholderModel(trimmed) ? null : trimmed;
}

/**
 * The machine's make and model.
 *
 * Neither platform exposes this to a process without asking the OS, and both answers
 * come from a built-in that is not PowerShell: `reg.exe` reads the key the firmware
 * populated at boot, and `sysctl` is a syscall wrapper. Enrolment is a cold path, so a
 * one-off spawn there costs nothing the collection loop will feel — and a failure
 * yields null, because a device that enrols without a model is far better than one
 * that cannot enrol.
 */
export async function readMachineModel(
  platform: string = process.platform,
  exec: (file: string, args: string[]) => Promise<string> = defaultModelExec,
): Promise<string | null> {
  try {
    if (platform === "win32") {
      return parseWindowsModel(
        await exec("reg", ["query", "HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS"]),
      );
    }

    if (platform === "darwin") {
      return parseMacModel(await exec("/usr/sbin/sysctl", ["-n", "hw.model"]));
    }
  } catch {
    // A hardened image can deny either command. One missing field must never be what
    // stops a machine enrolling.
  }

  return null;
}

async function defaultModelExec(file: string, args: string[]): Promise<string> {
  const { stdout } = await run(file, args, { timeout: 5_000, windowsHide: true });
  return stdout;
}

/** Sums the DIMM capacities `wmic memorychip` prints, one per line under a header. */
export function parseWindowsMemory(output: string): number | null {
  let total = 0;

  for (const line of output.split(/\r?\n/)) {
    const digits = /^\s*(\d+)\s*$/.exec(line);
    if (digits?.[1] === undefined) continue;
    total += Number(digits[1]);
  }

  return total > 0 ? total : null;
}

/** `sysctl -n hw.memsize`: one integer, and already installed rather than usable. */
export function parseMacMemory(output: string): number | null {
  const parsed = Number(output.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * How much memory is *installed*, which is not what `os.totalmem()` answers.
 *
 * `totalmem()` is `GlobalMemoryStatusEx().ullTotalPhys` on Windows — physical memory
 * **available to the OS**, with hardware reservations already subtracted. Integrated
 * graphics take their share out of exactly that, so a Ryzen laptop with 8 GB fitted
 * reports about 6.8 and the inventory column read "6 GB". Measured on a 16 GB machine
 * here: `totalmem()` 15.65 GB, DIMMs 16.00 GB.
 *
 * An inventory answers "what is in this machine", so it has to be the DIMMs. Neither
 * command is PowerShell, for the reason `readHostFacts` documents — a hardened image
 * denies it. `wmic` is deprecated and absent from the newest Windows builds, and macOS
 * `hw.memsize` is already installed memory, so both paths fall back to `totalmem()`
 * rather than failing: a slightly low number beats an empty column.
 */
export async function readInstalledMemoryBytes(
  platform: string = process.platform,
  exec: (file: string, args: string[]) => Promise<string> = defaultModelExec,
): Promise<number | null> {
  try {
    if (platform === "win32") {
      return parseWindowsMemory(await exec("wmic", ["memorychip", "get", "Capacity"]));
    }

    if (platform === "darwin") {
      return parseMacMemory(await exec("/usr/sbin/sysctl", ["-n", "hw.memsize"]));
    }
  } catch {
    // Same rule as the model: one field is never worth failing an enrolment over.
  }

  return null;
}

/**
 * Total size of the volume holding the given path.
 *
 * `statfs` is a syscall rather than the PowerShell/WMI round-trip the usual
 * libraries make, and the Tauri build simply sent `null` here — scope §7 asks for
 * storage, so an unreadable volume degrades to null instead of the field not existing.
 */
function readVolumeBytes(path: string): number | null {
  try {
    const { bsize, blocks } = statfsSync(path);
    return bsize * blocks;
  } catch {
    return null;
  }
}

/**
 * Resolved lazily. A top-level `import { app } from "electron"` would drag the
 * Electron runtime into every unit test that imports this module; outside Electron
 * the module resolves to the binary path, so `app` is simply absent.
 */
function readAgentVersion(): string {
  const electron = requireHere("electron") as {
    app?: { getVersion(): string };
  };
  return electron.app?.getVersion() ?? "0.0.0";
}

/** A subkey line: the leaf is the uninstall key, which is the closest thing to a product id. */
const REG_KEY_LINE = /^HKEY_[A-Z_]+\\.*\\([^\\]+)\s*$/;

/** `    Name    REG_TYPE    data` — data may itself contain single spaces. */
const REG_VALUE_LINE = /^\s{4}(\S.*?)\s{4}REG_[A-Z_]+\s{4}(.*)$/;

/**
 * Parses `reg query <uninstall key> /s` output.
 *
 * Text parsing rather than a native registry binding: `reg.exe` enumerates subkeys
 * natively, and `@vscode/windows-registry` can only read a single named value.
 * Shipping a native module to do what a built-in already does is the wrong trade.
 */
export function parseWindowsUninstallKeys(output: string): InstalledApplication[] {
  const apps: InstalledApplication[] = [];
  let identifier: string | null = null;
  let values = new Map<string, string>();

  const commit = (): void => {
    // Patch and orphaned-installer keys have no DisplayName and are not applications.
    const name = values.get("DisplayName");
    if (name === undefined || name.length === 0) return;

    // Drivers and redistributables mark themselves SystemComponent; Windows hides
    // them from Add/Remove Programs, and an inventory that lists them is noise.
    if (isTruthyDword(values.get("SystemComponent"))) return;

    apps.push({
      name,
      version: values.get("DisplayVersion") ?? null,
      identifier,
    });
  };

  for (const line of output.split(/\r?\n/)) {
    const key = REG_KEY_LINE.exec(line);
    if (key) {
      commit();
      identifier = key[1] ?? null;
      values = new Map();
      continue;
    }

    const value = REG_VALUE_LINE.exec(line);
    if (value?.[1] !== undefined) values.set(value[1], (value[2] ?? "").trim());
  }

  commit();
  return apps;
}

/** REG_DWORD data arrives as `0x0` / `0x1`, so a plain truthiness check would read both as set. */
function isTruthyDword(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const parsed = Number.parseInt(raw, 16);
  return Number.isFinite(parsed) && parsed !== 0;
}

/**
 * All four uninstall hives. A 64-bit machine keeps 32-bit installers under
 * WOW6432Node, and per-user installs (Slack, VS Code, Teams) live in HKCU — reading
 * only the first key returns a partial inventory that looks complete.
 */
const UNINSTALL_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
] as const;

/** Injected so the parser above is exercised against fixtures rather than this machine. */
export type RegistryReader = (key: string) => Promise<string>;

export async function collectWindowsApplications(
  read: RegistryReader,
): Promise<InstalledApplication[]> {
  // Keyed by name: a product commonly registers in both the native and WOW6432Node
  // views of the same hive, and the uninstall key differs between them, so the key
  // cannot be used for identity.
  const byName = new Map<string, InstalledApplication>();

  for (const key of UNINSTALL_KEYS) {
    // A hive that does not exist makes reg.exe exit non-zero. Two of these four are
    // routinely absent, so one failure must not cost the other three.
    const output = await read(key).catch(() => "");

    for (const app of parseWindowsUninstallKeys(output)) {
      if (!byName.has(app.name)) byName.set(app.name, app);
    }
  }

  return [...byName.values()];
}

/**
 * Turns one `.app` bundle into an inventory entry.
 *
 * `plistJson` is what `plutil -convert json -o - <bundle>/Contents/Info.plist`
 * prints. `system_profiler SPApplicationsDataType` is more authoritative but
 * routinely takes 10-30s, which is too much for a cold path that runs at enrolment.
 */
export function parseMacApplication(bundlePath: string, plistJson: string): InstalledApplication {
  const info = readPlistJson(plistJson);

  return {
    name: stringOrNull(info["CFBundleName"]) ?? bundleName(bundlePath),
    version: stringOrNull(info["CFBundleShortVersionString"]),
    identifier: stringOrNull(info["CFBundleIdentifier"]),
  };
}

/** `/Applications/Google Chrome.app` → `Google Chrome`. */
function bundleName(bundlePath: string): string {
  return basename(bundlePath, ".app");
}

function readPlistJson(plistJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(plistJson);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A binary plist plutil refused, or an empty read. The bundle is still installed,
    // so the entry degrades to its folder name instead of vanishing.
    return {};
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The platform-specific readers, injected so the dispatch below is testable off-platform. */
export interface ApplicationSources {
  registry: RegistryReader;
  mac: MacApplicationReader;
  homeDirectory: string;
}

/** Injected so the bundle walk is exercised against fixtures rather than this machine. */
export interface MacApplicationReader {
  listDirectory(directory: string): Promise<string[]>;
  readInfoPlist(bundlePath: string): Promise<string>;
}

export async function collectMacApplications(
  reader: MacApplicationReader,
  homeDirectory: string,
): Promise<InstalledApplication[]> {
  // /System/Applications holds everything Apple ships and ~/Applications the
  // per-user installs, so scanning /Applications alone misses both.
  const directories = ["/Applications", "/System/Applications", `${homeDirectory}/Applications`];
  const apps: InstalledApplication[] = [];

  for (const directory of directories) {
    // ~/Applications is absent on most Macs; one missing directory must not cost
    // the other two.
    const entries = await reader.listDirectory(directory).catch(() => []);

    for (const entry of entries) {
      if (!entry.endsWith(".app")) continue;

      // An unreadable plist degrades the entry to its bundle name rather than
      // dropping an app that is demonstrably installed.
      const bundlePath = `${directory}/${entry}`;
      const plist = await reader.readInfoPlist(bundlePath).catch(() => "");

      apps.push(parseMacApplication(bundlePath, plist));
    }
  }

  return apps;
}

const run = promisify(execFile);

/**
 * The real readers.
 *
 * `get-installed-apps` was rejected for this: its macOS path is a shell-interpolated
 * `ls` of a single directory, and its Windows path vendors an old `winreg` copy.
 * Both of the calls below are `execFile`, so no shell parses these arguments.
 */
function defaultSources(): ApplicationSources {
  return {
    registry: async (key) => {
      // The uninstall hive dumps several megabytes; the default 1 MB buffer would
      // throw ENOBUFS, which the per-hive catch would swallow as an empty inventory.
      const { stdout } = await run("reg", ["query", key, "/s"], {
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    },
    mac: {
      listDirectory: (directory) => readdir(directory),
      readInfoPlist: async (bundlePath) => {
        const plist = `${bundlePath}/Contents/Info.plist`;
        const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", plist]);
        return stdout;
      },
    },
    homeDirectory: homedir(),
  };
}

/**
 * Installed-application inventory: `reg query` on Windows, `plutil` over the
 * `.app` bundles on macOS.
 *
 * Cold path — run at enrolment and then occasionally, never on the collection timer.
 */
export async function collectInstalledApplications(
  platform: string = process.platform,
  sources: ApplicationSources = defaultSources(),
): Promise<InstalledApplication[]> {
  const apps = await readApplications(platform, sources);
  return apps.slice(0, MAX_APPLICATIONS);
}

/**
 * `POST /api/devices/applications` caps the array at 2000 and rejects the whole
 * batch past it — so an unusually loaded machine would report no inventory at all
 * rather than a truncated one.
 */
const MAX_APPLICATIONS = 2000;

function readApplications(
  platform: string,
  sources: ApplicationSources,
): Promise<InstalledApplication[]> {
  if (platform === "win32") return collectWindowsApplications(sources.registry);
  if (platform === "darwin") return collectMacApplications(sources.mac, sources.homeDirectory);

  // Unreachable in practice — `collectDeviceFacts` refuses to enrol anything else.
  // An empty inventory beats throwing on a cold path nobody awaits for correctness.
  return Promise.resolve([]);
}
