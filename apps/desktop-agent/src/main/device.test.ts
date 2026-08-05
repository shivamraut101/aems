import { describe, expect, it, vi } from "vitest";

import {
  collectDeviceFacts,
  collectInstalledApplications,
  collectMacApplications,
  collectWindowsApplications,
  parseMacApplication,
  parseMacModel,
  parseWindowsModel,
  parseWindowsUninstallKeys,
  readMachineModel,
} from "./device.js";
import type { DeviceHostFacts } from "./device.js";

const windowsHost: DeviceHostFacts = {
  platform: "win32",
  hostname: "DESKTOP-7QJ4A2",
  osVersion: "10.0.26200",
  agentVersion: "0.1.0",
  cpuModel: "AMD Ryzen 7 5800H with Radeon Graphics",
  totalMemoryBytes: 16 * 1024 * 1024 * 1024,
  totalStorageBytes: 512 * 1024 * 1024 * 1024,
  model: "LENOVO 21CB",
};

const macHost: DeviceHostFacts = {
  platform: "darwin",
  hostname: "Janes-MacBook-Pro",
  osVersion: "15.3.1",
  agentVersion: "0.1.0",
  cpuModel: "Apple M2 Pro",
  totalMemoryBytes: 32 * 1024 * 1024 * 1024,
  totalStorageBytes: 1024 * 1024 * 1024 * 1024,
  model: "MacBookPro18,3",
};

describe("collectDeviceFacts", () => {
  it("reports a win32 machine as the API's 'windows' platform", () => {
    expect(collectDeviceFacts(windowsHost).platform).toBe("windows");
  });

  it("reports a darwin machine as the API's 'macos' platform", () => {
    expect(collectDeviceFacts(macHost).platform).toBe("macos");
  });

  it("refuses to enrol an unsupported platform rather than guessing one", () => {
    expect(() => collectDeviceFacts({ ...windowsHost, platform: "linux" })).toThrow(/linux/);
  });

  it("converts total memory from bytes to whole megabytes", () => {
    expect(collectDeviceFacts(windowsHost).ramMb).toBe(16384);
  });

  it("omits a memory reading that rounds below one megabyte instead of sending zero", () => {
    // The API validates ramMb as a positive int, so a zero fails the whole enrolment.
    expect(collectDeviceFacts({ ...windowsHost, totalMemoryBytes: 0 }).ramMb).toBeNull();
    expect(collectDeviceFacts({ ...windowsHost, totalMemoryBytes: 524_287 }).ramMb).toBeNull();
  });

  it("converts total storage to megabytes and omits it when the OS would not report", () => {
    expect(collectDeviceFacts(windowsHost).storageMb).toBe(524_288);
    expect(collectDeviceFacts({ ...windowsHost, totalStorageBytes: null }).storageMb).toBeNull();
  });

  it("rounds a partial megabyte to the nearest whole one", () => {
    const mb = 1024 * 1024;
    expect(collectDeviceFacts({ ...windowsHost, totalMemoryBytes: mb }).ramMb).toBe(1);
    expect(collectDeviceFacts({ ...windowsHost, totalMemoryBytes: mb * 1.5 }).ramMb).toBe(2);
    expect(collectDeviceFacts({ ...windowsHost, totalMemoryBytes: mb * 1.4 }).ramMb).toBe(1);
  });

  it("reports the machine model, which is why every device read 'Unknown model'", () => {
    expect(collectDeviceFacts(windowsHost).model).toBe("LENOVO 21CB");
    expect(collectDeviceFacts(macHost).model).toBe("MacBookPro18,3");
  });

  it("omits an unreadable model rather than sending null, which the schema rejects", () => {
    // `model?: string` — a null fails validation and takes the whole enrolment with it.
    expect(collectDeviceFacts({ ...windowsHost, model: null }).model).toBeUndefined();
    expect(collectDeviceFacts({ ...windowsHost, model: "   " }).model).toBeUndefined();
  });

  it("omits a model longer than the 120 characters the API accepts", () => {
    expect(collectDeviceFacts({ ...windowsHost, model: "x".repeat(121) }).model).toBeUndefined();
    expect(collectDeviceFacts({ ...windowsHost, model: "x".repeat(120) }).model).toHaveLength(120);
  });
});

/** Verbatim `reg query HKLM\HARDWARE\DESCRIPTION\System\BIOS` output. */
const BIOS_KEY_OUTPUT = [
  "",
  "HKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\BIOS",
  "    BaseBoardManufacturer    REG_SZ    LENOVO",
  "    BIOSReleaseDate    REG_SZ    05/14/2024",
  "    SystemFamily    REG_SZ    ThinkPad T14 Gen 3",
  "    SystemManufacturer    REG_SZ    LENOVO",
  "    SystemProductName    REG_SZ    21CB",
  "",
].join("\r\n");

describe("parseWindowsModel", () => {
  it("joins the maker to the product name, because neither identifies a machine alone", () => {
    expect(parseWindowsModel(BIOS_KEY_OUTPUT)).toBe("LENOVO 21CB");
  });

  it("drops the placeholder strings a white-box builder leaves behind", () => {
    const whitebox = [
      "HKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\BIOS",
      "    SystemManufacturer    REG_SZ    System manufacturer",
      "    SystemProductName    REG_SZ    System Product Name",
    ].join("\r\n");

    // "System manufacturer System Product Name" looks like a reading and says nothing.
    expect(parseWindowsModel(whitebox)).toBeNull();
  });

  it("keeps whichever half was filled in", () => {
    const partial = [
      "HKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\BIOS",
      "    SystemManufacturer    REG_SZ    To Be Filled By O.E.M.",
      "    SystemProductName    REG_SZ    B550M DS3H",
    ].join("\r\n");

    expect(parseWindowsModel(partial)).toBe("B550M DS3H");
  });

  it("does not repeat a maker that is already the product name", () => {
    const repeated = [
      "HKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\BIOS",
      "    SystemManufacturer    REG_SZ    Microsoft Corporation",
      "    SystemProductName    REG_SZ    Microsoft Corporation",
    ].join("\r\n");

    expect(parseWindowsModel(repeated)).toBe("Microsoft Corporation");
  });

  it("reports nothing for output that carries neither value", () => {
    expect(parseWindowsModel("")).toBeNull();
    expect(parseWindowsModel("ERROR: The system was unable to find the specified key.")).toBeNull();
  });
});

describe("parseMacModel", () => {
  it("reads the one line sysctl prints", () => {
    expect(parseMacModel("MacBookPro18,3\n")).toBe("MacBookPro18,3");
  });

  it("reports nothing for empty output", () => {
    expect(parseMacModel("\n")).toBeNull();
  });
});

describe("readMachineModel", () => {
  it("asks reg.exe on Windows and sysctl on macOS", async () => {
    const calls: string[] = [];
    const exec = (file: string, args: string[]): Promise<string> => {
      calls.push(`${file} ${args.join(" ")}`);
      return Promise.resolve(file === "reg" ? BIOS_KEY_OUTPUT : "Macmini9,1\n");
    };

    expect(await readMachineModel("win32", exec)).toBe("LENOVO 21CB");
    expect(await readMachineModel("darwin", exec)).toBe("Macmini9,1");
    expect(calls).toEqual([
      "reg query HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS",
      "/usr/sbin/sysctl -n hw.model",
    ]);
  });

  it("yields null rather than failing the enrolment when the command is denied", async () => {
    const denied = (): Promise<string> => Promise.reject(new Error("Access is denied"));
    expect(await readMachineModel("win32", denied)).toBeNull();
  });

  it("asks nothing at all on a platform the agent does not enrol", async () => {
    const exec = vi.fn(() => Promise.resolve(""));
    expect(await readMachineModel("linux", exec)).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});

/**
 * Verbatim `reg query <key> /s` output. reg.exe indents value lines by four spaces
 * and separates name, type and data by four more — the data itself may contain
 * single spaces, which is why splitting on whitespace does not work.
 */
const REG_OUTPUT = [
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{8A69D345-D564-463C-AFF1-A69D9E530F96}",
  "    DisplayName    REG_SZ    Google Chrome",
  "    DisplayVersion    REG_SZ    132.0.6834.160",
  "    Publisher    REG_SZ    Google LLC",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\7-Zip",
  "    DisplayName    REG_SZ    7-Zip 24.09 (x64)",
  "    DisplayVersion    REG_SZ    24.09",
  "",
].join("\r\n");

describe("parseWindowsUninstallKeys", () => {
  it("reads the display name, version and uninstall key from reg query output", () => {
    expect(parseWindowsUninstallKeys(REG_OUTPUT)).toEqual([
      {
        name: "Google Chrome",
        version: "132.0.6834.160",
        identifier: "{8A69D345-D564-463C-AFF1-A69D9E530F96}",
      },
      { name: "7-Zip 24.09 (x64)", version: "24.09", identifier: "7-Zip" },
    ]);
  });

  it("drops keys with no DisplayName", () => {
    // Patch and orphaned-installer keys make up most of the hive and are not apps.
    const output = [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\KB5034123",
      "    UninstallString    REG_SZ    C:\\Windows\\SysWOW64\\msiexec.exe /X{ABC}",
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Slack",
      "    DisplayName    REG_SZ    Slack",
      "",
    ].join("\r\n");

    expect(parseWindowsUninstallKeys(output)).toEqual([
      { name: "Slack", version: null, identifier: "Slack" },
    ]);
  });

  it("drops SystemComponent entries, which Windows hides from Add/Remove Programs too", () => {
    const output = [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{VCRedist}",
      "    DisplayName    REG_SZ    Microsoft Visual C++ 2015 Additional Runtime",
      "    SystemComponent    REG_DWORD    0x1",
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{Figma}",
      "    DisplayName    REG_SZ    Figma",
      "    SystemComponent    REG_DWORD    0x0",
      "",
    ].join("\r\n");

    expect(parseWindowsUninstallKeys(output)).toEqual([
      { name: "Figma", version: null, identifier: "{Figma}" },
    ]);
  });
});

describe("collectWindowsApplications", () => {
  it("queries the 32-bit and 64-bit views of both the machine and user hives", async () => {
    const asked: string[] = [];
    await collectWindowsApplications(async (key) => {
      asked.push(key);
      return "";
    });

    // Skipping WOW6432Node leaves every 32-bit app invisible on a 64-bit machine,
    // which looks like a complete inventory rather than half of one.
    expect(asked).toEqual([
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "HKCU\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ]);
  });

  it("reports a product listed in more than one hive once", () => {
    const chrome = [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{CHROME}",
      "    DisplayName    REG_SZ    Google Chrome",
      "    DisplayVersion    REG_SZ    132.0.6834.160",
      "",
    ].join("\r\n");

    // Chrome registers under both the native and WOW6432Node views of the same hive.
    return expect(collectWindowsApplications(async () => chrome)).resolves.toEqual([
      {
        name: "Google Chrome",
        version: "132.0.6834.160",
        identifier: "{CHROME}",
      },
    ]);
  });

  it("keeps the apps it did read when a hive does not exist", async () => {
    // HKCU\...\WOW6432Node is absent on plenty of machines and reg.exe exits 1 for it.
    const apps = await collectWindowsApplications(async (key) => {
      if (key.includes("WOW6432Node")) throw new Error("ERROR: The system was unable to find...");
      return [
        "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Slack",
        "    DisplayName    REG_SZ    Slack",
        "",
      ].join("\r\n");
    });

    expect(apps).toEqual([{ name: "Slack", version: null, identifier: "Slack" }]);
  });
});

describe("parseMacApplication", () => {
  it("reads the bundle name, short version and identifier from an Info.plist", () => {
    // What `plutil -convert json -o - <bundle>/Contents/Info.plist` prints.
    const plist = JSON.stringify({
      CFBundleName: "Slack",
      CFBundleShortVersionString: "4.42.115",
      CFBundleVersion: "44211500",
      CFBundleIdentifier: "com.tinyspeck.slackmacgap",
    });

    expect(parseMacApplication("/Applications/Slack.app", plist)).toEqual({
      name: "Slack",
      version: "4.42.115",
      identifier: "com.tinyspeck.slackmacgap",
    });
  });

  it("names the app after its bundle when the plist omits CFBundleName", () => {
    const plist = JSON.stringify({ CFBundleIdentifier: "com.google.Chrome" });

    expect(parseMacApplication("/Applications/Google Chrome.app", plist)).toEqual({
      name: "Google Chrome",
      version: null,
      identifier: "com.google.Chrome",
    });
  });

  it("still reports the app when plutil returns nothing usable", () => {
    // The bundle exists, so the app is installed. Dropping it because plutil failed
    // would silently shrink the inventory rather than degrade one row of it.
    expect(parseMacApplication("/Applications/Xcode.app", "")).toEqual({
      name: "Xcode",
      version: null,
      identifier: null,
    });
  });
});

describe("collectMacApplications", () => {
  it("scans all three application directories and only .app bundles", async () => {
    const scanned: string[] = [];

    const apps = await collectMacApplications(
      {
        listDirectory: async (directory) => {
          scanned.push(directory);
          return directory === "/Applications" ? ["Slack.app", "Utilities", ".DS_Store"] : [];
        },
        readInfoPlist: async () => JSON.stringify({ CFBundleName: "Slack" }),
      },
      "/Users/jane",
    );

    // /System/Applications holds the Apple-shipped apps and ~/Applications the
    // per-user installs; a scan of /Applications alone misses both.
    expect(scanned).toEqual(["/Applications", "/System/Applications", "/Users/jane/Applications"]);
    expect(apps).toEqual([{ name: "Slack", version: null, identifier: null }]);
  });

  it("keeps scanning when an application directory does not exist", async () => {
    // ~/Applications is absent on most Macs.
    const apps = await collectMacApplications(
      {
        listDirectory: async (directory) => {
          if (directory.startsWith("/Users")) throw new Error("ENOENT");
          return directory === "/Applications" ? ["Slack.app"] : [];
        },
        readInfoPlist: async () => JSON.stringify({ CFBundleName: "Slack" }),
      },
      "/Users/jane",
    );

    expect(apps).toEqual([{ name: "Slack", version: null, identifier: null }]);
  });

  it("still lists a bundle whose Info.plist cannot be read", async () => {
    const apps = await collectMacApplications(
      {
        listDirectory: async (directory) =>
          directory === "/Applications" ? ["Adobe Photoshop 2025.app"] : [],
        readInfoPlist: async () => {
          throw new Error("plutil: operation not permitted");
        },
      },
      "/Users/jane",
    );

    expect(apps).toEqual([{ name: "Adobe Photoshop 2025", version: null, identifier: null }]);
  });
});

const unusedMacReader = {
  listDirectory: () => Promise.reject(new Error("macOS reader used on Windows")),
  readInfoPlist: () => Promise.reject(new Error("macOS reader used on Windows")),
};

const unusedRegistry = () => Promise.reject(new Error("registry read attempted on macOS"));

describe("collectInstalledApplications", () => {
  it("reads the registry on Windows", async () => {
    const apps = await collectInstalledApplications("win32", {
      registry: async () =>
        [
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Slack",
          "    DisplayName    REG_SZ    Slack",
          "",
        ].join("\r\n"),
      mac: unusedMacReader,
      homeDirectory: "C:\\Users\\jane",
    });

    expect(apps).toEqual([{ name: "Slack", version: null, identifier: "Slack" }]);
  });

  it("walks application bundles on macOS", async () => {
    const apps = await collectInstalledApplications("darwin", {
      registry: unusedRegistry,
      mac: {
        listDirectory: async (directory) =>
          directory === "/System/Applications" ? ["Safari.app"] : [],
        readInfoPlist: async () =>
          JSON.stringify({
            CFBundleName: "Safari",
            CFBundleIdentifier: "com.apple.Safari",
          }),
      },
      homeDirectory: "/Users/jane",
    });

    expect(apps).toEqual([{ name: "Safari", version: null, identifier: "com.apple.Safari" }]);
  });

  it("caps the inventory at what the API will accept", async () => {
    const hive = Array.from({ length: 2500 }, (_, i) =>
      [
        `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\App${i}`,
        `    DisplayName    REG_SZ    App ${i}`,
        "",
      ].join("\r\n"),
    ).join("");

    // POST /api/devices/applications caps the array at 2000 and rejects the whole
    // batch past it, so an oversized machine would report nothing at all.
    const apps = await collectInstalledApplications("win32", {
      registry: async () => hive,
      mac: unusedMacReader,
      homeDirectory: "C:\\Users\\jane",
    });

    expect(apps).toHaveLength(2000);
  });
});
