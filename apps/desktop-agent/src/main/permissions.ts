/**
 * Whether the OS still lets the agent see what it claims to be collecting.
 *
 * macOS gates screen capture and window details behind TCC; Windows gates neither.
 * The Windows answer is modelled as an explicit `not-required` state rather than as
 * a platform branch at every call site, so the gate below reads the same on both.
 */

import { createRequire } from "node:module";

import type {
  AgentPermissions,
  PermissionState,
  PermissionTarget,
  UrlFidelity,
} from "../shared/types/index.js";
import type { BrowserUrlReader } from "./browser-url.js";
import { createBrowserUrlReader } from "./browser-url.js";
import type { CapturedFrame, Capturer } from "./screenshot.js";

/**
 * The slice of Electron this module needs, injected so the state machine is
 * exercisable in a plain Node process — no macOS, no display, no TCC daemon.
 */
export interface MacPermissionApi {
  /** `systemPreferences.getMediaAccessStatus("screen")`. Read-only: never prompts. */
  screenRecordingStatus(): PermissionState;
  /** `systemPreferences.isTrustedAccessibilityClient(prompt)`. */
  accessibilityTrusted(options: { prompt: boolean }): boolean;
  /** A throwaway capture — the only call that registers the app with TCC. */
  registerForScreenRecording(): Promise<void>;
  openSettings(url: string): Promise<void>;
}

/**
 * Deep links into the two Privacy panes.
 *
 * System Settings kept the old `com.apple.preference.security` schema when it replaced
 * System Preferences, so these are still correct on Ventura through Tahoe.
 */
export const SETTINGS_PANES: Record<PermissionTarget, string> = {
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

/** Windows gates neither screen capture nor window titles, and has no accessibility ask. */
const WINDOWS_PERMISSIONS = {
  screenRecording: "not-required",
  accessibility: "not-required",
} as const satisfies Omit<AgentPermissions, "websiteTracking">;

/**
 * Whether a screen capture may be attempted at all.
 *
 * Fails closed on every state that is not an affirmative grant. A denied macOS grant
 * historically produced blank frames rather than an error, and a timeline of black
 * rectangles captured every five minutes does not read as "the OS blocked us" — it
 * reads as evidence that the employee sat doing nothing. An honest gap is the lesser
 * harm, so `unknown` refuses too.
 *
 * Deliberately stricter than the renderer's `permissionGaps`, which does not flag
 * `unknown` so the readout never cries wolf. Refusing to capture and declining to
 * accuse the OS are different questions.
 */
export function mayCaptureScreen(state: PermissionState): boolean {
  return state === "not-required" || state === "granted";
}

/** Thrown instead of returning an empty frame list, so a blocked capture is never silent. */
export class ScreenRecordingDeniedError extends Error {
  constructor(readonly state: PermissionState) {
    super(`Screen recording is ${state}, so no capture was attempted`);
    this.name = "ScreenRecordingDeniedError";
  }
}

/**
 * Wraps a `Capturer` so the OS grant is checked immediately before the frame is taken.
 *
 * The check belongs here rather than in the scheduler because this is the last point
 * before the display is actually read — nothing can route around it to produce a frame.
 * `permissions` is a function, not a snapshot: a grant withdrawn mid-day has to stop
 * capture on the next attempt, without a restart.
 */
export class PermissionGatedCapturer implements Capturer {
  constructor(
    private readonly inner: Capturer,
    private readonly permissions: () => AgentPermissions,
  ) {}

  async capture(quality: number): Promise<CapturedFrame[]> {
    const state = this.permissions().screenRecording;
    if (!mayCaptureScreen(state)) throw new ScreenRecordingDeniedError(state);

    return this.inner.capture(quality);
  }
}

export class PermissionMonitor {
  /**
   * The reader itself, rather than a copy of its fidelity.
   *
   * Read on every `read()` rather than latched in the constructor, because the answer
   * is no longer fixed for the life of the process: a managed browser extension
   * connecting upgrades a Windows machine from `window-title` to `browser-url`, and
   * removing it takes the claim away again. A latched value would leave the consent
   * screen promising website tracking on a machine that had lost the extension hours
   * earlier — which is the same class of untrue claim as a stale indicator.
   */
  constructor(
    private readonly api: MacPermissionApi,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly urlReader: BrowserUrlReader = createBrowserUrlReader(platform),
  ) {}

  private get websiteTracking(): UrlFidelity {
    return this.urlReader.fidelity;
  }

  read(): AgentPermissions {
    if (this.platform !== "darwin") {
      return { ...WINDOWS_PERMISSIONS, websiteTracking: this.websiteTracking };
    }

    return {
      screenRecording: this.api.screenRecordingStatus(),
      accessibility: this.api.accessibilityTrusted({ prompt: false }) ? "granted" : "denied",
      websiteTracking: this.websiteTracking,
    };
  }

  /**
   * The one remediation path the employee has: raise the OS prompt, then land them on
   * the pane that holds the switch.
   *
   * Must be user-initiated. Registering for Screen Recording is itself a capture, so
   * firing it at startup would be collection before anybody asked for it.
   */
  async request(target: PermissionTarget): Promise<AgentPermissions> {
    // Nothing to grant on Windows, and an x-apple.systempreferences: URL handed to the
    // Windows shell is a dead link in front of an employee who was told to click it.
    if (this.platform !== "darwin") return this.read();

    if (target === "screen-recording") await this.api.registerForScreenRecording();
    else this.api.accessibilityTrusted({ prompt: true });

    await this.api.openSettings(SETTINGS_PANES[target]);

    return this.read();
  }
}

// -- the real macOS adapter -----------------------------------------------

/** The slice of Electron `macPermissionApi` drives, named so it can be faked wholesale. */
export interface ElectronPermissionSlice {
  systemPreferences: {
    getMediaAccessStatus(mediaType: "screen"): string;
    isTrustedAccessibilityClient(prompt: boolean): boolean;
  };
  desktopCapturer: {
    getSources(options: {
      types: string[];
      thumbnailSize: { width: number; height: number };
    }): Promise<unknown>;
  };
  shell: { openExternal(url: string): Promise<void> };
}

/**
 * States macOS itself can report. `not-required` is deliberately absent — it is this
 * agent's word for a platform with no gate, and accepting it from macOS would open the
 * capture gate without a grant.
 */
const MAC_STATES: readonly PermissionState[] = [
  "granted",
  "denied",
  "restricted",
  "not-determined",
  "unknown",
];

export function macPermissionApi(electron: ElectronPermissionSlice): MacPermissionApi {
  return {
    screenRecordingStatus: () => {
      const reported = electron.systemPreferences.getMediaAccessStatus("screen");
      return MAC_STATES.find((known) => known === reported) ?? "unknown";
    },

    accessibilityTrusted: ({ prompt }) =>
      electron.systemPreferences.isTrustedAccessibilityClient(prompt),

    registerForScreenRecording: async () => {
      try {
        // Electron exposes no askForMediaAccess("screen"); a capture attempt is the only
        // call that reaches CGRequestScreenCaptureAccess, which is what puts the app in
        // the Screen Recording list. The frame is discarded and never leaves the process.
        await electron.desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 1, height: 1 },
        });
      } catch {
        // A rejection here is the registration succeeding on a machine that has not
        // granted the permission yet, which is exactly when this is called.
      }
    },

    openSettings: (url) => electron.shell.openExternal(url),
  };
}

// Electron is loaded lazily so this module can be imported — and its whole state
// machine exercised — in a plain Node process with no Electron runtime.
const requireElectron = createRequire(import.meta.url);

/**
 * The production monitor.
 *
 * `systemPreferences` and `desktopCapturer` are only touched when a permission is
 * actually read or requested, so constructing this does not itself need a ready app.
 */
export function createPermissionMonitor(urlReader?: BrowserUrlReader): PermissionMonitor {
  return new PermissionMonitor(
    macPermissionApi(requireElectron("electron") as ElectronPermissionSlice),
    process.platform,
    urlReader,
  );
}

export type { PermissionTarget };
