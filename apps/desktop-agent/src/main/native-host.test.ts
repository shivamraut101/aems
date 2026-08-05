import { describe, expect, it } from "vitest";

import { USER_DATA_FLAG } from "./bridge.js";
import { NATIVE_HOST_NAME } from "./bridge-protocol.js";
import type { NativeHostEnvironment } from "./native-host.js";
import {
  bridgeLauncherName,
  buildHostManifest,
  describeRegistration,
  registerNativeHost,
  resolveBridgeCommand,
} from "./native-host.js";

const EXTENSION = "abcdefghijklmnopabcdefghijklmnop";

interface Fake {
  environment: NativeHostEnvironment;
  files: Map<string, string>;
  commands: string[][];
  executable: string[];
}

function fake(
  patch: Partial<NativeHostEnvironment> = {},
  behaviour: { failKeys?: RegExp; failWrite?: RegExp } = {},
): Fake {
  const files = new Map<string, string>();
  const commands: string[][] = [];
  const executable: string[] = [];

  const environment: NativeHostEnvironment = {
    platform: "win32",
    executablePath: "C:/Program Files/AEMS/AEMS Agent.exe",
    userDataPath: "C:/Users/x/AppData/Roaming/aems",
    homePath: "C:/Users/x",
    fs: {
      read: (path) => files.get(path) ?? null,
      write: (path, contents) => {
        if (behaviour.failWrite?.test(path) === true) throw new Error("EACCES");
        files.set(path, contents);
      },
      append: () => {},
      rename: () => {},
      remove: (path) => {
        files.delete(path);
      },
    },
    run: (file, args) => {
      commands.push([file, ...args]);
      if (behaviour.failKeys?.test(args.join(" ")) === true) {
        return Promise.reject(new Error("Access is denied"));
      }
      return Promise.resolve();
    },
    join: (...parts) => parts.join("/"),
    extensionIds: [EXTENSION],
    bridgeScriptPath: "C:/Program Files/AEMS/resources/app.asar/out/main/bridge.js",
    makeExecutable: (path) => executable.push(path),
    ...patch,
  };

  return { environment, files, commands, executable };
}

describe("buildHostManifest", () => {
  it("names the executable and admits only the pinned extension ids", () => {
    expect(buildHostManifest("C:/AEMS/agent.exe", [EXTENSION])).toEqual({
      name: NATIVE_HOST_NAME,
      description: "AEMS workforce intelligence agent — browser activity and policy bridge",
      path: "C:/AEMS/agent.exe",
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION}/`],
    });
  });
});

describe("resolveBridgeCommand", () => {
  it("runs the bridge entry as Node, which is the only byte-clean stdout on Windows", () => {
    const { environment, files } = fake();

    const command = resolveBridgeCommand(environment);

    expect(command.path).toBe("C:/Users/x/AppData/Roaming/aems/aems-bridge-host.cmd");

    const script = files.get(command.path) ?? "";
    // Without this the Electron binary writes a stray CRLF before any application code
    // runs, and Chrome reads it as the first two bytes of a length prefix.
    expect(script).toContain("set ELECTRON_RUN_AS_NODE=1");
    expect(script).toContain('"C:/Program Files/AEMS/AEMS Agent.exe"');
    expect(script).toContain('"C:/Program Files/AEMS/resources/app.asar/out/main/bridge.js"');
  });

  it("hands the host the userData directory, which Node mode cannot ask Electron for", () => {
    const { environment, files } = fake();

    const script = files.get(resolveBridgeCommand(environment).path) ?? "";

    expect(script).toContain(`${USER_DATA_FLAG} "C:/Users/x/AppData/Roaming/aems"`);
  });

  it("forwards the arguments Chrome appends, or the origin never reaches the host", () => {
    const { environment, files } = fake();
    const windows = files.get(resolveBridgeCommand(environment).path) ?? "";
    expect(windows).toContain("%*");

    const mac = fake({ platform: "darwin" });
    const macScript = mac.files.get(resolveBridgeCommand(mac.environment).path) ?? "";
    expect(macScript).toContain('"$@"');
  });

  it("writes an executable shell launcher on macOS", () => {
    const { environment, files, executable } = fake({ platform: "darwin" });

    const command = resolveBridgeCommand(environment);

    expect(command.path).toBe("C:/Users/x/AppData/Roaming/aems/aems-bridge-host.sh");
    expect(files.get(command.path)).toContain("#!/bin/sh");
    expect(files.get(command.path)).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(executable).toEqual([command.path]);
  });

  it("names the launcher the same way on every run, because a manifest points at it", () => {
    expect(bridgeLauncherName("win32")).toBe("aems-bridge-host.cmd");
    expect(bridgeLauncherName("darwin")).toBe("aems-bridge-host.sh");
  });
});

describe("registerNativeHost on Windows", () => {
  it("writes the manifest and points both browsers at it through HKLM", async () => {
    const { environment, files, commands } = fake();

    const result = await registerNativeHost(environment);

    expect(result.ok).toBe(true);
    expect(result.manifestPath).toBe(
      `C:/Users/x/AppData/Roaming/aems/${NATIVE_HOST_NAME}.json`,
    );
    expect(JSON.parse(files.get(result.manifestPath ?? "") ?? "{}")).toMatchObject({
      allowed_origins: [`chrome-extension://${EXTENSION}/`],
    });

    expect(commands.map((command) => command[2])).toEqual([
      `HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      `HKLM\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    ]);
  });

  it("sets the key's default value with /f, which is where Chrome looks", async () => {
    const { environment, commands } = fake();

    await registerNativeHost(environment);

    expect(commands[0]).toEqual([
      "reg",
      "add",
      `HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      `C:/Users/x/AppData/Roaming/aems/${NATIVE_HOST_NAME}.json`,
      "/f",
    ]);
  });

  it("falls back to HKCU when HKLM is refused, which is the per-user install", async () => {
    const { environment, commands } = fake({}, { failKeys: /HKLM/ });

    const result = await registerNativeHost(environment);

    expect(result.ok).toBe(true);
    expect(commands).toHaveLength(4);
    expect(result.attempts.filter((attempt) => attempt.ok).map((attempt) => attempt.scope)).toEqual([
      "user",
      "user",
    ]);
  });

  it("reports failure rather than degrading quietly when neither scope can be written", async () => {
    const { environment } = fake({}, { failKeys: /HK/ });

    const result = await registerNativeHost(environment);

    expect(result.ok).toBe(false);
    expect(describeRegistration(result)).toContain("could not be registered");
    expect(describeRegistration(result)).toContain("Access is denied");
  });

  it("reports failure rather than registering a launcher it could not write", async () => {
    const { environment, commands } = fake({}, { failWrite: /\.cmd$/ });

    const result = await registerNativeHost(environment);

    expect(result.ok).toBe(false);
    expect(commands).toEqual([]);
    expect(describeRegistration(result)).toContain("EACCES");
  });

  it("leaves the registry untouched when the manifest itself cannot be written", async () => {
    const { environment, commands } = fake({}, { failWrite: /\.json$/ });

    const result = await registerNativeHost(environment);

    // A key pointing at a file that does not exist makes Chrome fail with a confusing
    // error instead of the clear "host not found" the extension reports.
    expect(result.ok).toBe(false);
    expect(result.manifestPath).toBeNull();
    expect(commands).toEqual([]);
  });
});

describe("registerNativeHost on macOS", () => {
  it("writes one manifest per browser under the user's Library", async () => {
    const { environment, files } = fake({ platform: "darwin", homePath: "/Users/x" });

    const result = await registerNativeHost(environment);

    expect(result.ok).toBe(true);
    expect([...files.keys()].filter((path) => path.endsWith(".json"))).toEqual([
      `/Users/x/Library/Application Support/Google/Chrome/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`,
      `/Users/x/Library/Application Support/Microsoft Edge/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`,
    ]);
  });

  it("stays registered for the browser that worked when the other's directory is unwritable", async () => {
    const { environment } = fake({ platform: "darwin" }, { failWrite: /Microsoft Edge/ });

    const result = await registerNativeHost(environment);

    expect(result.ok).toBe(true);
    expect(result.attempts.map((attempt) => attempt.ok)).toEqual([true, false]);
  });
});

describe("describeRegistration", () => {
  it("names the scope, because per-user and per-machine are different rollouts", async () => {
    const { environment } = fake({}, { failKeys: /HKLM/ });

    expect(describeRegistration(await registerNativeHost(environment))).toBe(
      "Browser bridge registered for chrome (user), edge (user)",
    );
  });

  it("says restrictions are inactive when nothing could be registered", async () => {
    const { environment } = fake({}, { failKeys: /HK/ });

    expect(describeRegistration(await registerNativeHost(environment))).toContain(
      "website tracking and restrictions are inactive",
    );
  });
});
