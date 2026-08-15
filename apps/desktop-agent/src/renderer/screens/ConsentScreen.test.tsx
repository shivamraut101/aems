// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentApi, AgentPolicy, AgentStatus } from "../../shared/types/index.js";
import { emptyTotals } from "../../shared/types/index.js";
import { ConsentScreen } from "./ConsentScreen.js";

/**
 * The consent gate — non-negotiable #1, at the surface where the employee meets it.
 *
 * `mayCollect` (tested in shared/types) is the rule; this is the door. These tests are
 * about the door being a door: no way through that is not a deliberate accept, no way
 * around, and no wording that implies collection has begun before it has.
 *
 * All are regression guards except the in-flight label, which was RED-first against a
 * real defect. The guards were verified by mutation — `disabled={!agreed || busy}`
 * loosened, the `if (bridge === null || !agreed || busy) return` guard removed, the
 * error branch dropped — each failure observed, each line restored.
 */

const POLICY: AgentPolicy = {
  version: "2026.08.1",
  name: "Standard Monitoring Policy",
  screenshotIntervalSeconds: 300,
  idleThresholdSeconds: 120,
  trackedCategories: [],
};

const CONSENTED: AgentStatus = {
  enrolled: true,
  collecting: true,
  consentRequired: false,
  revoked: false,
  policyVersion: POLICY.version,
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

function bridge(overrides: Partial<AgentApi> = {}): AgentApi {
  return {
    getStatus: () => Promise.resolve(CONSENTED),
    getPolicy: () => Promise.resolve(POLICY),
    enroll: () => Promise.resolve(CONSENTED),
    acceptConsent: () => Promise.resolve(CONSENTED),
    getPermissions: () =>
      Promise.resolve({ screenRecording: "granted", accessibility: "granted", websiteTracking: "browser-url" } as const),
    openPermissionSettings: () => Promise.resolve(),
    startBreak: () => Promise.resolve(CONSENTED),
    endBreak: () => Promise.resolve(CONSENTED),
    endDay: () => Promise.resolve(CONSENTED),
    startDay: () => Promise.resolve(CONSENTED),
    quit: () => Promise.resolve(),
    onStatusChanged: () => () => undefined,
    onEndDayRequested: () => () => undefined,
    ...overrides,
  };
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

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function text(): string {
  return host?.textContent ?? "";
}

function buttons(): HTMLButtonElement[] {
  return [...(host?.querySelectorAll("button") ?? [])];
}

function declineButton(): HTMLButtonElement {
  const found = buttons().find((button) => /decline/i.test(button.textContent ?? ""));
  if (found === undefined) throw new Error("the gate has no decline control");
  return found;
}

/**
 * Matched as "the button that is not decline", so a label change on the in-flight
 * state cannot make this quietly start returning the decline button instead.
 */
function acceptButton(): HTMLButtonElement {
  const found = buttons().filter((button) => !/decline/i.test(button.textContent ?? ""));
  if (found.length !== 1) {
    throw new Error(`expected exactly one accept control, saw ${found.length}`);
  }
  return found[0] as HTMLButtonElement;
}

function agreementCheckbox(): HTMLInputElement {
  const input = host?.querySelector<HTMLInputElement>("input[type=checkbox]");
  if (input === null || input === undefined) throw new Error("consent checkbox is missing");
  return input;
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
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
  delete (window as Partial<Window>).aems;
});

describe("the gate cannot be bypassed", () => {
  it("keeps the accept control disabled until the employee agrees", async () => {
    window.aems = bridge();
    mount(<ConsentScreen status={CONSENTED} onAccepted={() => undefined} />);
    await settle();

    expect(acceptButton().disabled).toBe(true);

    click(agreementCheckbox());

    expect(agreementCheckbox().checked).toBe(true);
    expect(acceptButton().disabled).toBe(false);
  });

  /**
   * The outcome, over both layers that produce it: React refuses the mouse event on
   * the disabled control, and `accept()` re-checks `agreed` behind it.
   *
   * The two are asserted together on purpose. Stripping the DOM `disabled` attribute
   * to isolate the second would prove nothing — React decides from the prop on the
   * fiber, not from the element — so a test that did it would only look thorough.
   */
  it("records nothing when the accept is pressed without an agreement", async () => {
    const acceptConsent = vi.fn(() => Promise.resolve(CONSENTED));
    const onAccepted = vi.fn();
    window.aems = bridge({ acceptConsent });
    mount(<ConsentScreen status={CONSENTED} onAccepted={onAccepted} />);
    await settle();

    click(acceptButton());
    await settle();

    expect(acceptConsent).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  // Two controls, both terminal: agree, or leave. Anything else on this screen — a
  // close box, a "Later", a "Skip for now" — would be a way to keep an enrolled agent
  // running past a gate it has not passed.
  it("offers exactly two ways out, and neither of them is a dismissal", async () => {
    window.aems = bridge();
    mount(<ConsentScreen status={CONSENTED} onAccepted={() => undefined} />);
    await settle();

    expect(buttons()).toHaveLength(2);
    expect(text()).not.toMatch(/\b(later|skip|not now|remind me|dismiss|close)\b/i);
    expect(host?.querySelector("[aria-label*='close' i], [aria-label*='dismiss' i]")).toBeNull();
  });

  it("stays on screen when the window is dismissed with the keyboard", async () => {
    window.aems = bridge();
    mount(<ConsentScreen status={CONSENTED} onAccepted={() => undefined} />);
    await settle();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(agreementCheckbox()).not.toBeNull();
    expect(buttons()).toHaveLength(2);
  });

  // Declining is not a dismissal: with no consent on file the agent has nothing it is
  // permitted to do, so it exits rather than sitting in the tray implying otherwise.
  it("quits the agent on decline instead of parking it", async () => {
    const quit = vi.fn(() => Promise.resolve());
    const acceptConsent = vi.fn(() => Promise.resolve(CONSENTED));
    const onAccepted = vi.fn();
    window.aems = bridge({ quit, acceptConsent });
    mount(<ConsentScreen status={CONSENTED} onAccepted={onAccepted} />);
    await settle();

    click(declineButton());
    await settle();

    expect(quit).toHaveBeenCalledTimes(1);
    expect(acceptConsent).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });
});

describe("accepting", () => {
  it("records the consent once and hands the new status up", async () => {
    const acceptConsent = vi.fn(() => Promise.resolve(CONSENTED));
    const onAccepted = vi.fn();
    window.aems = bridge({ acceptConsent });
    mount(<ConsentScreen status={CONSENTED} onAccepted={onAccepted} />);
    await settle();

    click(agreementCheckbox());
    click(acceptButton());
    await settle();

    expect(acceptConsent).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledWith(CONSENTED);
  });

  // Two consent rows for one decision would make the audit trail describe something
  // that did not happen.
  it("ignores a second press while the first is still in flight", async () => {
    let release: (status: AgentStatus) => void = () => undefined;
    const acceptConsent = vi.fn(
      () =>
        new Promise<AgentStatus>((resolve) => {
          release = resolve;
        }),
    );
    window.aems = bridge({ acceptConsent });
    mount(<ConsentScreen status={CONSENTED} onAccepted={() => undefined} />);
    await settle();

    click(agreementCheckbox());
    click(acceptButton());
    click(acceptButton());

    expect(acceptConsent).toHaveBeenCalledTimes(1);

    release(CONSENTED);
    await settle();
  });

  /**
   * RED-first. The in-flight label was "Recording…" — on the one screen whose entire
   * claim is that nothing has been recorded yet, and the last thing the employee reads
   * before they look away.
   */
  it("does not imply that monitoring has already started", async () => {
    let release: (status: AgentStatus) => void = () => undefined;
    window.aems = bridge({
      acceptConsent: () =>
        new Promise<AgentStatus>((resolve) => {
          release = resolve;
        }),
    });
    mount(<ConsentScreen status={CONSENTED} onAccepted={() => undefined} />);
    await settle();

    click(agreementCheckbox());
    click(acceptButton());

    expect(acceptButton().textContent ?? "").toMatch(/consent/i);

    release(CONSENTED);
    await settle();
  });
});

describe("when something fails", () => {
  // A gate that reported success on a failed write would leave the agent collecting
  // with no consent row behind it — which the API would reject anyway, leaving the
  // employee with an agent that says it is running and a dashboard that shows nothing.
  it("keeps the gate up and says so when the consent could not be recorded", async () => {
    const onAccepted = vi.fn();
    window.aems = bridge({
      acceptConsent: () => Promise.reject(new Error("the server rejected this device")),
    });
    mount(<ConsentScreen status={CONSENTED} onAccepted={onAccepted} />);
    await settle();

    click(agreementCheckbox());
    click(acceptButton());
    await settle();

    expect(onAccepted).not.toHaveBeenCalled();
    expect(host?.querySelector("[role=alert]")?.textContent ?? "").toMatch(/rejected this device/);
    expect(agreementCheckbox()).not.toBeNull();
  });

  it("lets the employee try again after a failure", async () => {
    const acceptConsent = vi
      .fn<() => Promise<AgentStatus>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(CONSENTED);
    const onAccepted = vi.fn();
    window.aems = bridge({ acceptConsent });
    mount(<ConsentScreen status={CONSENTED} onAccepted={onAccepted} />);
    await settle();

    click(agreementCheckbox());
    click(acceptButton());
    await settle();

    expect(acceptButton().disabled).toBe(false);

    click(acceptButton());
    await settle();

    expect(onAccepted).toHaveBeenCalledWith(CONSENTED);
  });

  // The gate is what the employee is agreeing to. Losing the policy fetch may cost the
  // exact intervals, but a blank or half-rendered gate would be consent to nothing.
  it("still sets out everything collected when the policy cannot be fetched", async () => {
    window.aems = bridge({ getPolicy: () => Promise.reject(new Error("offline")) });
    mount(<ConsentScreen status={CONSENTED} onAccepted={() => undefined} />);
    await settle();

    for (const subject of [/application/i, /website/i, /idle/i, /screenshot/i, /device/i]) {
      expect(text()).toMatch(subject);
    }
    expect(text().length).toBeGreaterThan(200);
  });

  it("still lets the employee accept without a policy on screen", async () => {
    const acceptConsent = vi.fn(() => Promise.resolve(CONSENTED));
    window.aems = bridge({
      getPolicy: () => Promise.reject(new Error("offline")),
      acceptConsent,
    });
    mount(<ConsentScreen status={CONSENTED} onAccepted={() => undefined} />);
    await settle();

    click(agreementCheckbox());
    click(acceptButton());
    await settle();

    expect(acceptConsent).toHaveBeenCalledTimes(1);
  });
});

describe("what the gate discloses", () => {
  it("names the policy version being agreed to once it is known", async () => {
    window.aems = bridge();
    mount(<ConsentScreen status={CONSENTED} onAccepted={() => undefined} />);
    await settle();

    expect(text()).toMatch(POLICY.version);
    expect(text()).toMatch(POLICY.name);
  });

  it("states the screenshot interval the policy actually carries", async () => {
    window.aems = bridge();
    mount(<ConsentScreen status={CONSENTED} onAccepted={() => undefined} />);
    await settle();

    expect(text()).toMatch(/every 5 minutes/i);
  });

  // The absence of these is what employees most often assume wrongly, in both
  // directions. Stating them is the difference between disclosure and a checkbox.
  it("states the limits as well as the collection", async () => {
    window.aems = bridge();
    mount(<ConsentScreen status={CONSENTED} onAccepted={() => undefined} />);
    await settle();

    expect(text()).toMatch(/what you type is never recorded/i);
    expect(text()).toMatch(/page contents are not read/i);
  });

  it("promises the visible indicator and the right to withdraw", async () => {
    window.aems = bridge();
    mount(<ConsentScreen status={CONSENTED} onAccepted={() => undefined} />);
    await settle();

    expect(text()).toMatch(/tray icon/i);
    expect(text()).toMatch(/withdraw your consent/i);
  });
});

/**
 * A consent screen may only promise what the binary on this machine can actually do.
 *
 * Windows has no supported way to read a browser tab's address, so "Website domains you
 * visit" is not a description of what will be collected there — it is a claim the agent
 * cannot honour, made on the one screen where a false claim invalidates the consent
 * itself.
 */
describe("what the gate promises is what this platform can do", () => {
  const titleOnly = {
    screenRecording: "not-required",
    accessibility: "not-required",
    websiteTracking: "window-title",
  } as const;

  it("does not promise website addresses on a computer that cannot read them", async () => {
    window.aems = bridge({ getPermissions: () => Promise.resolve(titleOnly) });
    mount(<ConsentScreen status={CONSENTED} onAccepted={() => undefined} />);
    await settle();

    expect(text()).not.toContain("Website domains you visit");
    expect(text()).toContain("cannot currently report the addresses of pages you open");
    // "Cannot", full stop, was a promise the agreement could not keep: a managed browser
    // extension force-installed later starts recording addresses without bumping the
    // policy version, so nothing re-opens this screen and the signed words become false.
    expect(text()).toContain("you will be told");
  });

  it("still promises them where the address really is read", async () => {
    window.aems = bridge();
    mount(<ConsentScreen status={CONSENTED} onAccepted={() => undefined} />);
    await settle();

    expect(text()).toContain("Website domains you visit");
    expect(text()).not.toContain("cannot currently report the addresses of pages you open");
  });
});

/**
 * The gate lists what this device will actually collect, and nothing else.
 *
 * Asking somebody to agree to something that will not happen is not disclosure — it is
 * the same defect as promising website addresses on a machine that cannot read them,
 * which is why the two are now one code path rather than two lists that can drift.
 */
describe("what the gate lists is what this device is scoped to", () => {
  function scoped(collection: AgentStatus["collection"], pendingTypes: AgentStatus["pendingTypes"] = []) {
    return { ...CONSENTED, collection, pendingTypes };
  }

  it("does not mention a type an administrator has switched off", async () => {
    window.aems = bridge();
    mount(
      <ConsentScreen
        status={scoped(["applications", "idle"])}
        onAccepted={() => undefined}
      />,
    );
    await settle();

    expect(text()).toMatch(/applications you use/i);
    expect(text()).toMatch(/idle periods/i);
    expect(text()).not.toMatch(/screenshot/i);
    expect(text()).not.toMatch(/battery/i);
  });

  it("lists everything the platform supports when no scope has reached the agent", async () => {
    // The deploy case: null means "the platform default of the day", so the gate must
    // read exactly as it did before per-device scope existed.
    window.aems = bridge();
    mount(<ConsentScreen status={scoped(null)} onAccepted={() => undefined} />);
    await settle();

    for (const subject of [/application/i, /website/i, /idle/i, /screenshot/i, /device/i]) {
      expect(text()).toMatch(subject);
    }
  });

  it("includes a type an administrator has added, because that is what is being asked", async () => {
    window.aems = bridge();
    mount(
      <ConsentScreen
        status={scoped(["applications"], ["screenshots"])}
        onAccepted={() => undefined}
      />,
    );
    await settle();

    expect(text()).toMatch(/screenshot/i);
  });
});
