/**
 * Registering the agent as a Chrome/Edge native messaging host.
 *
 * A browser will only start a native host it has been told about beforehand: a small
 * JSON manifest naming the executable and the extension ids allowed to reach it, found
 * through a registry value on Windows and a well-known directory on macOS. Without
 * this the extension's `connectNative` fails instantly with "Specified native
 * messaging host not found" — which is exactly what the extension's status readout is
 * required to say out loud rather than degrade past in silence.
 *
 * Registration is attempted per browser and per scope, and every attempt is reported.
 * A rollout where only the per-user key could be written is a *working* rollout on that
 * machine and a *broken* one for a second Windows account, and an administrator can
 * only know which they have if the agent says so.
 */

import { NATIVE_HOST_NAME } from "./bridge-protocol.js";
import type { DurableFs } from "./persistence.js";

/** The two Chromium browsers `docs/scope.md` §2.5 has to cover on a managed fleet. */
export type ManagedBrowser = "chrome" | "edge";

/** Where a registration landed. `machine` needs an elevated installer; `user` does not. */
export type RegistrationScope = "machine" | "user";

export interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

/**
 * The manifest, built from the ids the protocol pins.
 *
 * `allowed_origins` is the whole access control: Chrome refuses to start the host for
 * any other extension, so widening this list is the one edit here that has a security
 * consequence.
 */
export function buildHostManifest(
  executablePath: string,
  extensionIds: readonly string[],
): HostManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: "AEMS workforce intelligence agent — browser activity and policy bridge",
    path: executablePath,
    type: "stdio",
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
}

/**
 * Registry keys, most-privileged first.
 *
 * HKLM covers every account on a shared machine and is what a properly deployed fleet
 * uses; HKCU is the fallback for the per-user NSIS install this product actually ships
 * (`perMachine: false` in `electron-builder.yml`), where there is no elevation to
 * write HKLM with.
 */
const WINDOWS_KEYS: Record<ManagedBrowser, Record<RegistrationScope, string>> = {
  chrome: {
    machine: "HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts",
    user: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  },
  edge: {
    machine: "HKLM\\Software\\Microsoft\\Edge\\NativeMessagingHosts",
    user: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts",
  },
};

/**
 * macOS manifest directories, relative to the user's home.
 *
 * The system-wide equivalents under `/Library` need root, which a user-installed .app
 * does not have; a managed fleet writes those with an MDM profile instead.
 */
const MAC_DIRECTORIES: Record<ManagedBrowser, string> = {
  chrome: "Library/Application Support/Google/Chrome/NativeMessagingHosts",
  edge: "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
};

export interface HostRegistrationAttempt {
  browser: ManagedBrowser;
  scope: RegistrationScope;
  ok: boolean;
  /** Why it failed, for the log line an administrator will actually read. */
  error: string | null;
}

export interface HostRegistrationResult {
  /** Absolute path of the manifest, or null when it could not be written. */
  manifestPath: string | null;
  attempts: HostRegistrationAttempt[];
  /** True when at least one browser can now find the host. */
  ok: boolean;
}

export interface NativeHostEnvironment {
  platform: NodeJS.Platform;
  /** `process.execPath` — the binary Chrome will re-enter in bridge mode. */
  executablePath: string;
  /** Electron's `userData`, where the Windows manifest lives. */
  userDataPath: string;
  homePath: string;
  fs: DurableFs;
  /** `execFile`-shaped; never a shell, so no argument here is ever parsed by one. */
  run(file: string, args: readonly string[]): Promise<void>;
  join(...parts: string[]): string;
  extensionIds: readonly string[];
  /**
   * Absolute path of `out/main/bridge.js` — the Node-mode native messaging host.
   *
   * A second build entry rather than a branch inside the agent's own bundle, for the
   * reason spelled out in {@link resolveBridgeCommand}.
   */
  bridgeScriptPath: string;
  /** `chmod +x`. Only called for the POSIX launcher, where the bit is required. */
  makeExecutable?(path: string): void;
}

/** The path a browser is told to start, and the launcher written to make it work. */
export interface BridgeCommand {
  path: string;
  launcherPath: string;
}

/** The launcher's filename. Stable, because Chrome's manifest points at it by path. */
export function bridgeLauncherName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "aems-bridge-host.cmd" : "aems-bridge-host.sh";
}

/**
 * Writes the launcher Chrome will actually start, and returns its path.
 *
 * # Why a launcher rather than the agent binary itself
 *
 * Two independent reasons, and either alone would be enough.
 *
 * **Stdout is not clean.** On Windows the Electron binary writes a bare CRLF to stdout
 * during Chromium's startup, before any application code runs — measured against this
 * repository's Electron 43.3.0 with a host that writes nothing at all. Chrome reads a
 * native messaging stream as a uint32 length followed by exactly that many bytes, so
 * two stray leading bytes desynchronise the port from its first frame and it dies with
 * nothing in any log. Running the same executable with `ELECTRON_RUN_AS_NODE=1`
 * produces a byte-clean stream, and a native messaging manifest has no field for an
 * environment variable — only a path. A launcher is the only place to set it.
 *
 * **There is no field for an argument either.** The host needs to be told where the
 * agent's `userData` lives, because in Node mode there is no `app.getPath` to ask.
 *
 * Chromium launches `.bat`/`.cmd` hosts through the command processor on Windows and
 * any executable script on POSIX, and `%*` / `"$@"` forwards the manifest path and the
 * `chrome-extension://` origin Chrome appends — which is what
 * `readBridgeInvocation` reads.
 */
export function resolveBridgeCommand(environment: NativeHostEnvironment): BridgeCommand {
  const windows = environment.platform === "win32";
  const path = environment.join(
    environment.userDataPath,
    bridgeLauncherName(environment.platform),
  );

  environment.fs.write(path, launcherScript(environment, windows));
  if (!windows) environment.makeExecutable?.(path);

  return { path, launcherPath: path };
}

function launcherScript(environment: NativeHostEnvironment, windows: boolean): string {
  const { executablePath, bridgeScriptPath, userDataPath } = environment;

  // `setlocal` keeps the variable inside this launcher rather than leaking it into
  // whatever else the command processor is doing; the bridge must run as Node, and
  // nothing else should.
  return windows
    ? [
        "@echo off",
        "setlocal",
        "set ELECTRON_RUN_AS_NODE=1",
        `"${executablePath}" "${bridgeScriptPath}" ${USER_DATA_LAUNCH_FLAG} "${userDataPath}" %*`,
        "",
      ].join("\r\n")
    : [
        "#!/bin/sh",
        "ELECTRON_RUN_AS_NODE=1 \\",
        `exec "${executablePath}" "${bridgeScriptPath}" ${USER_DATA_LAUNCH_FLAG} "${userDataPath}" "$@"`,
        "",
      ].join("\n");
}

/**
 * Repeated rather than imported from `bridge-main.ts`, which is a *program* — importing
 * it here would run it. `native-host.test.ts` asserts the two strings are the same.
 */
const USER_DATA_LAUNCH_FLAG = "--aems-user-data";

/**
 * Writes the manifest and points every installed browser at it.
 *
 * Never throws. A failure to register is a degraded install, not a reason for a
 * monitoring agent to refuse to start — the browser half simply reports itself as not
 * connected, which is the honest state.
 */
export async function registerNativeHost(
  environment: NativeHostEnvironment,
): Promise<HostRegistrationResult> {
  let command: BridgeCommand;

  try {
    command = resolveBridgeCommand(environment);
  } catch (error) {
    return {
      manifestPath: null,
      attempts: [{ browser: "chrome", scope: "user", ok: false, error: describe(error) }],
      ok: false,
    };
  }

  const manifest = buildHostManifest(command.path, environment.extensionIds);
  const body = JSON.stringify(manifest, null, 2);

  return environment.platform === "win32"
    ? registerWindows(environment, body)
    : registerMac(environment, body);
}

async function registerWindows(
  environment: NativeHostEnvironment,
  body: string,
): Promise<HostRegistrationResult> {
  const manifestPath = environment.join(environment.userDataPath, `${NATIVE_HOST_NAME}.json`);

  try {
    environment.fs.write(manifestPath, body);
  } catch (error) {
    // Nothing to register without a manifest, so the registry is left untouched: a key
    // pointing at a file that does not exist makes Chrome fail with a confusing error
    // rather than the clear "host not found" the extension is written to report.
    return {
      manifestPath: null,
      attempts: [{ browser: "chrome", scope: "user", ok: false, error: describe(error) }],
      ok: false,
    };
  }

  const attempts: HostRegistrationAttempt[] = [];

  for (const browser of ["chrome", "edge"] as const) {
    for (const scope of ["machine", "user"] as const) {
      const key = `${WINDOWS_KEYS[browser][scope]}\\${NATIVE_HOST_NAME}`;
      const attempt = await attemptRegistration(browser, scope, () =>
        // `/ve` sets the key's default value, which is where Chrome looks; `/f`
        // overwrites without the interactive confirmation reg.exe would otherwise wait
        // for forever in a process with no console.
        environment.run("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]),
      );

      attempts.push(attempt);
      // HKLM succeeding covers every account, so the per-user key would be redundant.
      if (attempt.ok) break;
    }
  }

  return { manifestPath, attempts, ok: attempts.some((attempt) => attempt.ok) };
}

async function registerMac(
  environment: NativeHostEnvironment,
  body: string,
): Promise<HostRegistrationResult> {
  const attempts: HostRegistrationAttempt[] = [];
  let manifestPath: string | null = null;

  for (const browser of ["chrome", "edge"] as const) {
    const path = environment.join(
      environment.homePath,
      MAC_DIRECTORIES[browser],
      `${NATIVE_HOST_NAME}.json`,
    );

    const attempt = await attemptRegistration(browser, "user", () => {
      environment.fs.write(path, body);
      return Promise.resolve();
    });

    if (attempt.ok) manifestPath ??= path;
    attempts.push(attempt);
  }

  return { manifestPath, attempts, ok: attempts.some((attempt) => attempt.ok) };
}

async function attemptRegistration(
  browser: ManagedBrowser,
  scope: RegistrationScope,
  action: () => Promise<void>,
): Promise<HostRegistrationAttempt> {
  try {
    await action();
    return { browser, scope, ok: true, error: null };
  } catch (error) {
    return { browser, scope, ok: false, error: describe(error) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One line an administrator can act on.
 *
 * Names the scope, because "registered for the current user only" and "registered for
 * the whole machine" are different rollouts with different failure modes on a shared
 * workstation, and a bare "ok" hides which one happened.
 */
export function describeRegistration(result: HostRegistrationResult): string {
  if (!result.ok) {
    const reasons = result.attempts.map((a) => `${a.browser}/${a.scope}: ${a.error ?? "failed"}`);
    return `The browser bridge could not be registered, so website tracking and restrictions are inactive (${reasons.join("; ")})`;
  }

  const registered = result.attempts
    .filter((attempt) => attempt.ok)
    .map((attempt) => `${attempt.browser} (${attempt.scope})`);

  return `Browser bridge registered for ${registered.join(", ")}`;
}
