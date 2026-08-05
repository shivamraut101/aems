import { describe, expect, it, vi } from "vitest";

import type { PermissionState } from "../shared/types/index.js";
import type { ElectronPermissionSlice, MacPermissionApi } from "./permissions.js";
import {
  macPermissionApi,
  mayCaptureScreen,
  PermissionGatedCapturer,
  PermissionMonitor,
  ScreenRecordingDeniedError,
} from "./permissions.js";
import type { CapturedFrame, Capturer } from "./screenshot.js";

/** Every method stubbed to the permissive answer, so each test only varies its own field. */
function macApi(overrides: Partial<MacPermissionApi> = {}): MacPermissionApi {
  return {
    screenRecordingStatus: () => "granted",
    accessibilityTrusted: () => true,
    registerForScreenRecording: () => Promise.resolve(),
    openSettings: () => Promise.resolve(),
    ...overrides,
  };
}

describe("PermissionMonitor.read", () => {
  it("reports not-required on Windows without consulting the macOS APIs", () => {
    const screenRecordingStatus = vi.fn<MacPermissionApi["screenRecordingStatus"]>(
      () => "granted",
    );
    const accessibilityTrusted = vi.fn<MacPermissionApi["accessibilityTrusted"]>(() => true);

    const monitor = new PermissionMonitor(
      macApi({ screenRecordingStatus, accessibilityTrusted }),
      "win32",
    );

    expect(monitor.read()).toEqual({
      screenRecording: "not-required",
      accessibility: "not-required",
      websiteTracking: "window-title",
    });
    expect(screenRecordingStatus).not.toHaveBeenCalled();
    expect(accessibilityTrusted).not.toHaveBeenCalled();
  });

  it("mirrors the macOS screen-recording state verbatim", () => {
    const monitor = new PermissionMonitor(
      macApi({ screenRecordingStatus: () => "denied" }),
      "darwin",
    );

    expect(monitor.read().screenRecording).toBe("denied");
  });

  it("maps macOS accessibility trust onto granted and denied", () => {
    const trusted = new PermissionMonitor(
      macApi({ accessibilityTrusted: () => true }),
      "darwin",
    );
    const untrusted = new PermissionMonitor(
      macApi({ accessibilityTrusted: () => false }),
      "darwin",
    );

    expect(trusted.read().accessibility).toBe("granted");
    expect(untrusted.read().accessibility).toBe("denied");
  });

  // The readout polls status every collection tick. Reading with prompt: true would
  // put a TCC dialog in front of the employee every five seconds.
  it("never raises the accessibility prompt while reading", () => {
    const accessibilityTrusted = vi.fn<MacPermissionApi["accessibilityTrusted"]>(() => false);
    const monitor = new PermissionMonitor(macApi({ accessibilityTrusted }), "darwin");

    monitor.read();
    monitor.read();

    expect(accessibilityTrusted).toHaveBeenCalledTimes(2);
    expect(accessibilityTrusted).toHaveBeenNthCalledWith(1, { prompt: false });
    expect(accessibilityTrusted).toHaveBeenNthCalledWith(2, { prompt: false });
  });
});

describe("mayCaptureScreen", () => {
  it("permits capture on a platform that does not gate it", () => {
    expect(mayCaptureScreen("not-required")).toBe(true);
  });

  it("permits capture once macOS has granted screen recording", () => {
    expect(mayCaptureScreen("granted")).toBe(true);
  });

  // A blank frame uploaded every five minutes reads as evidence that the employee sat
  // doing nothing. Every state that is not an affirmative grant fails closed —
  // including `unknown`, where an honest gap beats a wall of black rectangles.
  it("refuses capture in every state that is not an affirmative grant", () => {
    const refused: PermissionState[] = ["denied", "restricted", "not-determined", "unknown"];

    for (const state of refused) {
      expect(mayCaptureScreen(state), state).toBe(false);
    }
  });
});

describe("PermissionGatedCapturer", () => {
  class SpyCapturer implements Capturer {
    calls = 0;

    capture(): Promise<CapturedFrame[]> {
      this.calls += 1;
      return Promise.resolve([{ displayId: "1", image: Buffer.from("frame") }]);
    }
  }

  it("refuses to reach the display at all when macOS is blocking screen recording", async () => {
    const inner = new SpyCapturer();
    const gated = new PermissionGatedCapturer(inner, () => ({
      screenRecording: "denied",
      accessibility: "granted",
      websiteTracking: "browser-url",
    }));

    await expect(gated.capture(60)).rejects.toBeInstanceOf(ScreenRecordingDeniedError);
    expect(inner.calls).toBe(0);
  });

  it("passes the quality through to the real capturer once the grant is in place", async () => {
    const inner = new SpyCapturer();
    const gated = new PermissionGatedCapturer(inner, () => ({
      screenRecording: "granted",
      accessibility: "denied",
      websiteTracking: "browser-url",
    }));

    await expect(gated.capture(60)).resolves.toHaveLength(1);
    expect(inner.calls).toBe(1);
  });

  // Sequoia re-prompts on a schedule, so a grant that held this morning can be gone by
  // the afternoon. Snapshotting it at construction would keep capturing right through
  // the revocation until the agent happened to restart.
  it("re-reads the grant on every capture rather than snapshotting it", async () => {
    const inner = new SpyCapturer();
    let screenRecording: PermissionState = "granted";
    const gated = new PermissionGatedCapturer(inner, () => ({
      screenRecording,
      accessibility: "granted",
      websiteTracking: "browser-url",
    }));

    await gated.capture(60);
    screenRecording = "denied";

    await expect(gated.capture(60)).rejects.toBeInstanceOf(ScreenRecordingDeniedError);
    expect(inner.calls).toBe(1);
  });
});

describe("PermissionMonitor.request", () => {
  /** Records the order of every side effect, because for screen recording order is the fix. */
  function recordingApi(overrides: Partial<MacPermissionApi> = {}) {
    const calls: string[] = [];
    const api = macApi({
      registerForScreenRecording: () => {
        calls.push("register");
        return Promise.resolve();
      },
      // Only the prompting form is a side effect; the read-only form runs constantly.
      accessibilityTrusted: (options) => {
        if (options.prompt) calls.push("prompt-accessibility");
        return false;
      },
      openSettings: (url) => {
        calls.push(`open:${url}`);
        return Promise.resolve();
      },
      ...overrides,
    });

    return { api, calls };
  }

  // Reading the status never registers the binary with TCC, so on a fresh Mac the
  // Screen Recording list does not contain AEMS at all. Deep-linking first would show
  // the employee an empty pane and no row to switch on — the classic dead end.
  it("registers with TCC before deep-linking the Screen Recording pane", async () => {
    const { api, calls } = recordingApi();
    const monitor = new PermissionMonitor(api, "darwin");

    await monitor.request("screen-recording");

    expect(calls).toEqual([
      "register",
      "open:x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ]);
  });

  // Accessibility has its own prompt, and registering for Screen Recording means taking
  // a frame. Asking for one permission must never capture the screen to do it.
  it("prompts for accessibility without capturing anything", async () => {
    const { api, calls } = recordingApi();
    const monitor = new PermissionMonitor(api, "darwin");

    await monitor.request("accessibility");

    expect(calls).toEqual([
      "prompt-accessibility",
      "open:x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    ]);
  });

  // Nothing to remediate on Windows, and an x-apple.systempreferences: URL handed to
  // the Windows shell is a dead link in front of an employee who was told to click it.
  it("does nothing on Windows", async () => {
    const { api, calls } = recordingApi();
    const monitor = new PermissionMonitor(api, "win32");

    await expect(monitor.request("screen-recording")).resolves.toEqual({
      screenRecording: "not-required",
      accessibility: "not-required",
      websiteTracking: "window-title",
    });
    await monitor.request("accessibility");

    expect(calls).toEqual([]);
  });

  // The IPC handler publishes status straight after, so a grant given while the pane
  // was open shows up without waiting for the next collection tick.
  it("returns the state re-read after the prompt", async () => {
    let status: PermissionState = "denied";
    const monitor = new PermissionMonitor(
      macApi({
        screenRecordingStatus: () => status,
        registerForScreenRecording: () => {
          status = "granted";
          return Promise.resolve();
        },
      }),
      "darwin",
    );

    await expect(monitor.request("screen-recording")).resolves.toMatchObject({
      screenRecording: "granted",
    });
  });
});

describe("macPermissionApi", () => {
  function electron(overrides: Partial<ElectronPermissionSlice> = {}): ElectronPermissionSlice {
    return {
      systemPreferences: {
        getMediaAccessStatus: () => "granted",
        isTrustedAccessibilityClient: () => true,
      },
      desktopCapturer: { getSources: () => Promise.resolve([]) },
      shell: { openExternal: () => Promise.resolve() },
      ...overrides,
    };
  }

  // On a fresh Mac the very first getSources() raises the TCC dialog and rejects with
  // "Failed to get sources." straight away. That rejection IS the registration working,
  // so surfacing it as an error would put a scary dialog behind a button that succeeded.
  it("treats a refused warm-up capture as the normal first-run outcome", async () => {
    const api = macPermissionApi(
      electron({
        desktopCapturer: {
          getSources: () => Promise.reject(new Error("Failed to get sources.")),
        },
      }),
    );

    await expect(api.registerForScreenRecording()).resolves.toBeUndefined();
  });

  // The warm-up exists to make the app appear in the Screen Recording list, not to
  // collect. One pixel is the smallest thing that still counts as a capture attempt.
  it("registers with a one-pixel thumbnail rather than a real frame", async () => {
    const getSources = vi.fn(() => Promise.resolve([]));
    const api = macPermissionApi(electron({ desktopCapturer: { getSources } }));

    await api.registerForScreenRecording();

    expect(getSources).toHaveBeenCalledWith({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
    });
  });

  // A future Electron could return a state this union does not know. Letting it through
  // would put an unhandled string into AgentPermissions and past the capture gate.
  it("degrades an unrecognised media-access state to unknown", () => {
    const api = macPermissionApi(
      electron({
        systemPreferences: {
          getMediaAccessStatus: () => "something-new",
          isTrustedAccessibilityClient: () => true,
        },
      }),
    );

    expect(api.screenRecordingStatus()).toBe("unknown");
  });

  // "not-required" is this agent's word for a platform with no gate. If macOS ever
  // reported it, capture would be permitted without an actual grant.
  it("never reports not-required from a macOS answer", () => {
    const api = macPermissionApi(
      electron({
        systemPreferences: {
          getMediaAccessStatus: () => "not-required",
          isTrustedAccessibilityClient: () => true,
        },
      }),
    );

    expect(api.screenRecordingStatus()).toBe("unknown");
  });
});

/**
 * Website tracking is a capability question, not a permission one, and Windows answers
 * it differently from macOS. Without it on `AgentPermissions` the readout says
 * "Connected" on a Windows machine whose Websites view can only ever be near-empty,
 * and the consent screen promises a domain list the platform cannot produce.
 */
describe("PermissionMonitor website-tracking fidelity", () => {
  it("reports title-only fidelity on Windows", () => {
    const monitor = new PermissionMonitor(macApi(), "win32");
    expect(monitor.read().websiteTracking).toBe("window-title");
  });

  it("reports a real browser address on macOS", () => {
    const monitor = new PermissionMonitor(macApi(), "darwin");
    expect(monitor.read().websiteTracking).toBe("browser-url");
  });
});

describe("PermissionMonitor and the managed browser extension", () => {
  /** A reader whose fidelity moves, which is what a connected extension produces. */
  function movingReader(fidelity: () => "browser-url" | "window-title") {
    return {
      get fidelity() {
        return fidelity();
      },
      read: () => null,
    };
  }

  it("reads the fidelity on every call, so a connection that lands mid-day is reflected", () => {
    // Latched in the constructor, this left the consent screen promising website
    // tracking on a machine that had lost its extension hours earlier.
    let connected = false;
    const monitor = new PermissionMonitor(
      macApi(),
      "win32",
      movingReader(() => (connected ? "browser-url" : "window-title")),
    );

    expect(monitor.read().websiteTracking).toBe("window-title");
    connected = true;
    expect(monitor.read().websiteTracking).toBe("browser-url");
  });

  it("carries the same answer on macOS, where the rest of the readout is a real grant", () => {
    const monitor = new PermissionMonitor(
      macApi(),
      "darwin",
      movingReader(() => "browser-url"),
    );

    expect(monitor.read()).toEqual({
      screenRecording: "granted",
      accessibility: "granted",
      websiteTracking: "browser-url",
    });
  });
});
