// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentApi, AgentStatus } from "../shared/types/index.js";
import { emptyTotals } from "../shared/types/index.js";
import { App } from "./App.js";

/**
 * The agent window, driven through its only input: the preload bridge.
 *
 * Every assertion here is about what the employee is told. A readout that overstates
 * monitoring frightens someone who is not being recorded; one that understates it
 * tells someone who *is* being recorded that they are not. The second is the worse
 * failure, so most of these tests push on it.
 *
 * The "cannot reach the agent" block is RED-first against a real defect. The rest are
 * regression guards over existing code, verified by mutation: `screenFor`'s revocation
 * branch, the `tracked === null` branch and the `pendingEvents > 0` branch were each
 * broken, the failure observed, and the line restored.
 */

const READY: AgentStatus = {
  enrolled: true,
  collecting: true,
  consentRequired: false,
  revoked: false,
  policyVersion: "2026.08.1",
  workSessionId: 1,
  pendingEvents: 0,
  lastSyncAt: null,
  permissions: { screenRecording: "granted", accessibility: "granted", websiteTracking: "browser-url" },
  totals: emptyTotals(),
  onBreak: false,
  collection: null,
  pendingTypes: [],
  dayEnded: false,
};

function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return { ...READY, ...overrides };
}

/** A bridge that answers everything successfully, so each test breaks one answer. */
function bridge(overrides: Partial<AgentApi> = {}): AgentApi {
  return {
    getStatus: () => Promise.resolve(status()),
    getPolicy: () => Promise.resolve(null),
    enroll: () => Promise.resolve(status()),
    acceptConsent: () => Promise.resolve(status()),
    getPermissions: () =>
      Promise.resolve({ screenRecording: "granted", accessibility: "granted", websiteTracking: "browser-url" } as const),
    openPermissionSettings: () => Promise.resolve(),
    startBreak: () => Promise.resolve(status()),
    endBreak: () => Promise.resolve(status()),
    endDay: () => Promise.resolve(status()),
    startDay: () => Promise.resolve(status()),
    quit: () => Promise.resolve(),
    onStatusChanged: () => () => undefined,
    ...overrides,
  };
}

/** Mounts the window against a bridge that reports `value` and nothing else. */
async function showing(value: AgentStatus): Promise<void> {
  window.aems = bridge({ getStatus: () => Promise.resolve(value) });
  mount(<App />);
  await settle();
}

function install(api: AgentApi | null): void {
  if (api === null) delete (window as Partial<Window>).aems;
  else window.aems = api;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(element: ReactElement): void {
  const container = document.createElement("div");
  document.body.append(container);

  const created = createRoot(container);
  root = created;
  host = container;

  act(() => {
    created.render(element);
  });
}

/** Lets the seed `getStatus()` promise settle and React commit the result. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function text(): string {
  return host?.textContent ?? "";
}

function buttonLabelled(pattern: RegExp): HTMLButtonElement | undefined {
  return [...(host?.querySelectorAll("button") ?? [])].find((button) =>
    pattern.test(button.textContent ?? ""),
  );
}

/** The consent gate is the only screen with an agreement checkbox. */
function consentGateShown(): boolean {
  return host?.querySelector("input[type=checkbox]") !== null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
  install(null);
});

/**
 * The window is a viewer, not the collector.
 *
 * `main/index.ts` calls `attachDevice()` — and therefore `collector.start()` — before
 * `createWindow()`, and the collection loop runs on its own timer from then on. So a
 * preload bridge that never attached, or an invoke that rejected, says nothing at all
 * about whether the machine is being recorded. It only says this window cannot see.
 */
describe("when the window cannot reach the agent", () => {
  it("does not claim that nothing is being recorded", async () => {
    install(null);
    mount(<App />);
    await settle();

    expect(text()).not.toMatch(/nothing is being recorded/i);
  });

  it("says outright that monitoring may still be running", async () => {
    install(null);
    mount(<App />);
    await settle();

    expect(text()).toMatch(/may still be recording/i);
  });

  it("points at the tray icon, the signal that does not depend on this window", async () => {
    install(null);
    mount(<App />);
    await settle();

    expect(text()).toMatch(/tray/i);
  });

  it("gives the same honest answer when the agent rejects the status request", async () => {
    install(bridge({ getStatus: () => Promise.reject(new Error("no runtime")) }));
    mount(<App />);
    await settle();

    expect(text()).not.toMatch(/nothing is being recorded/i);
    expect(text()).toMatch(/may still be recording/i);
  });

  // Electron rethrows a failed handler as "Error invoking remote method 'aems:status:get'".
  // An IPC channel name in front of someone trying to use their laptop is not an error
  // message, and it buries the sentence that matters underneath it.
  it("keeps the reported cause without leaking the IPC channel at the employee", async () => {
    install(
      bridge({
        getStatus: () =>
          Promise.reject(
            new Error("Error invoking remote method 'aems:status:get': Error: agent not started"),
          ),
      }),
    );
    mount(<App />);
    await settle();

    expect(text()).toMatch(/agent not started/);
    expect(text()).not.toMatch(/aems:status:get/);
  });
});

describe("before the first status arrives", () => {
  // The window opens from the tray at any moment. A blank frame while the invoke is in
  // flight looks like a crashed agent, which is its own wrong answer about monitoring.
  it("says it is checking rather than rendering an empty frame", () => {
    install(bridge({ getStatus: () => new Promise<AgentStatus>(() => undefined) }));
    mount(<App />);

    expect(text()).toMatch(/checking with the agent/i);
    expect(text().length).toBeGreaterThan(20);
  });
});

describe("which screen the status routes to", () => {
  it("asks an unbound machine to sign in", async () => {
    await showing(status({ enrolled: false, collecting: false }));

    expect(host?.querySelector("input[type=password]")).not.toBeNull();
    expect(consentGateShown()).toBe(false);
  });

  // No router and no back button: the readout is not reachable while consent is
  // outstanding, so there is nothing to step around the gate with.
  it("holds an enrolled device on the consent gate, with no readout behind it", async () => {
    await showing(status({ collecting: false, consentRequired: true }));

    expect(consentGateShown()).toBe(true);
    expect(text()).not.toMatch(/today's time/i);
  });

  // Revocation is terminal. Offering the gate would put "Accept and start" in front of
  // an employee whose device an administrator switched off, and imply they could undo it.
  it("sends a revoked device to the readout instead of back through the gate", async () => {
    await showing(status({ collecting: false, consentRequired: true, revoked: true }));

    expect(consentGateShown()).toBe(false);
    expect(text()).toMatch(/administrator/i);
    expect(text()).toMatch(/no longer sending data/i);
  });

  // Every control on the readout implies a running agent. A revoked device offering
  // "Start a break" would suggest there is collection to pause.
  it("offers a revoked device no controls that imply it is still running", async () => {
    await showing(status({ collecting: false, revoked: true }));

    expect(buttonLabelled(/break/i)).toBeUndefined();
  });
});

describe("the readout on a day with nothing in it", () => {
  it("distinguishes a day that has not started from a day of no work", async () => {
    await showing(status());

    expect(text()).toMatch(/not tracked yet/i);
    expect(text()).not.toMatch(/0m/);
  });

  it("says there has been no sync rather than leaving the row blank", async () => {
    await showing(status({ lastSyncAt: null }));

    expect(text()).toMatch(/no sync yet/i);
  });

  // A permanent "0 waiting" trains the employee to ignore the one line that matters
  // during an outage.
  it("keeps the sync backlog row out of the way while there is no backlog", async () => {
    await showing(status({ pendingEvents: 0 }));

    expect(text()).not.toMatch(/waiting to sync/i);
  });

  it("still tells the employee whether monitoring is running", async () => {
    await showing(status());

    expect(text()).toMatch(/connected/i);
  });
});

describe("the readout on a day with work in it", () => {
  it("reports the day in the shape docs/design.md specifies", async () => {
    await showing(
      status({
        totals: {
          totalSeconds: 26_400,
          activeSeconds: 23_400,
          idleSeconds: 3_000,
          breakSeconds: 0,
        },
      }),
    );

    expect(text()).toMatch(/7h 20m/);
    expect(text()).toMatch(/6h 30m/);
    expect(text()).toMatch(/50m/);
  });

  it("counts the backlog in events the employee can read", async () => {
    await showing(status({ pendingEvents: 12 }));

    expect(text()).toMatch(/waiting to sync/i);
    expect(text()).toContain("12 events");
  });

  it("keeps the singular for a backlog of one", async () => {
    await showing(status({ pendingEvents: 1 }));

    expect(text()).toContain("1 event");
    expect(text()).not.toContain("1 events");
  });
});

describe("when the OS is blocking part of the collection", () => {
  // A plain "Connected" over a machine where macOS is refusing screen capture tells
  // the employee more is being recorded than actually is.
  it("marks the connection limited and explains what stopped", async () => {
    await showing(
      status({
        permissions: {
          screenRecording: "denied",
          accessibility: "granted",
          websiteTracking: "browser-url",
        },
      }),
    );

    expect(text()).toMatch(/limited/i);
    expect(text()).toMatch(/screenshot/i);
  });

  it("offers the employee a way to fix it", async () => {
    const openPermissionSettings = vi.fn(() => Promise.resolve());
    window.aems = bridge({
      getStatus: () =>
        Promise.resolve(
          status({
        permissions: {
          screenRecording: "denied",
          accessibility: "granted",
          websiteTracking: "browser-url",
        },
      }),
        ),
      openPermissionSettings,
    });
    mount(<App />);
    await settle();

    const button = buttonLabelled(/system settings/i);
    expect(button).toBeDefined();

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(openPermissionSettings).toHaveBeenCalledWith("screen-recording");
  });
});

describe("following the agent", () => {
  // Nothing is cached locally on purpose: a renderer holding its own copy would keep
  // showing "Connected" through a revocation for as long as the window stayed open.
  it("repaints when the agent pushes a revocation while the window is open", async () => {
    let publish: (next: AgentStatus) => void = () => undefined;
    window.aems = bridge({
      onStatusChanged: (listener) => {
        publish = listener;
        return () => undefined;
      },
    });
    mount(<App />);
    await settle();

    expect(text()).toMatch(/connected/i);

    act(() => {
      publish(status({ collecting: false, revoked: true }));
    });

    expect(text()).toMatch(/administrator/i);
    expect(text()).not.toMatch(/\bConnected\b/);
  });

  // The listener is registered in an effect. Leaving it attached after unmount would
  // have main pushing into a dead React root every five seconds.
  it("lets the agent go when the window closes", async () => {
    const unsubscribe = vi.fn();
    window.aems = bridge({ onStatusChanged: () => unsubscribe });
    mount(<App />);
    await settle();

    act(() => {
      root?.unmount();
    });
    root = null;

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

/**
 * The readout has to be honest about the platform, not only about the grants.
 *
 * A Windows machine reports every permission as `not-required`, so nothing warns and
 * the screen reads "Connected" — while the Websites view it implies stays empty for a
 * reason nobody is told. Saying so is a notice, not a warning: no click can fix it.
 */
describe("what this computer cannot see", () => {
  it("says website addresses are not recorded on a computer that cannot read them", async () => {
    await showing(
      status({
        permissions: {
          screenRecording: "not-required",
          accessibility: "not-required",
          websiteTracking: "window-title",
        },
      }),
    );

    expect(text()).toContain("cannot report the addresses of pages you open");
  });

  it("stays quiet where the address really is read", async () => {
    await showing(status());

    expect(text()).not.toContain("cannot report the addresses of pages you open");
  });
});

/**
 * What the readout says about the per-device collection scope.
 *
 * Two statements, and they answer different questions. "What this computer records" is
 * the standing answer to what is being collected right now — until this existed the
 * employee could only get it by re-reading a consent screen they can no longer reach.
 * The other is the one change to the agreement the employee did not make, so it is put
 * in front of them rather than left to be noticed on the web.
 */
describe("the collection scope on the readout", () => {
  it("names what this machine is recording", async () => {
    await showing(status({ collection: ["applications", "idle"] }));

    expect(text()).toContain("What this computer records");
    expect(text()).toMatch(/applications you use/i);
  });

  it("does not name a type an administrator has switched off", async () => {
    await showing(status({ collection: ["applications", "idle"] }));

    expect(text()).not.toMatch(/screenshots ·|· screenshots/i);
  });

  it("says so when an administrator has switched something back on", async () => {
    await showing(status({ collection: ["applications"], pendingTypes: ["screenshots"] }));

    expect(text()).toContain("Your administrator has changed what is collected");
    // The employee must not be left thinking it has already started.
    expect(text()).toMatch(/none of it is being recorded until you agree/i);
  });

  it("stays quiet when nothing has been added", async () => {
    await showing(status());

    expect(text()).not.toContain("Your administrator has changed what is collected");
  });

  it("claims nothing on a revoked device, which is recording none of it", async () => {
    await showing(status({ revoked: true, collection: ["applications"], pendingTypes: ["idle"] }));

    expect(text()).not.toContain("What this computer records");
    expect(text()).not.toContain("Your administrator has changed what is collected");
  });
});
