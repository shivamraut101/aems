import { describe, expect, it } from "vitest";

import type { AgentPermissions, AgentStatus, PermissionState } from "../../shared/types/index.js";
import { emptyTotals } from "../../shared/types/index.js";
import {
  connectionLabel,
  permissionGaps,
  screenFor,
  trackedSecondsToday,
  unreachableMessage,
} from "./view.js";

/**
 * The status view model — what the agent window tells the person it is monitoring.
 *
 * `screenFor` decides whether the consent gate can be stepped around, and
 * `connectionLabel` is the one line an employee reads to learn whether they are being
 * recorded right now. Both are compliance statements wearing presentation clothes.
 *
 * `unreachableMessage` is the only RED-first block here; it was written against a
 * defect the review found (see App.test.tsx). The rest are regression guards over code
 * that already existed, each verified by mutation — the line was broken, the failure
 * observed, the line restored — because a test that cannot fail reads like coverage
 * without being any.
 */

/** Enrolled, consented, nothing blocked. Every test varies one field off this. */
function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
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
    ...overrides,
  };
}

function permissions(overrides: Partial<AgentPermissions> = {}): AgentPermissions {
  return {
    screenRecording: "granted",
    accessibility: "granted",
    websiteTracking: "browser-url",
    ...overrides,
  };
}

/** Reads the label the way a screen does, from the status alone. */
function labelOf(value: AgentStatus): ReturnType<typeof connectionLabel> {
  return connectionLabel(value, permissionGaps(value.permissions));
}

describe("screenFor", () => {
  it("asks a fresh machine to sign in", () => {
    expect(screenFor(status({ enrolled: false, collecting: false }))).toBe("login");
  });

  // The gate is not a screen among screens: it is the only thing between an enrolled
  // device and collection, so nothing else may be routed to while it is outstanding.
  it("holds an enrolled device on the consent gate until consent is on file", () => {
    expect(screenFor(status({ collecting: false, consentRequired: true }))).toBe("consent");
  });

  it("shows the readout once consent permits collection", () => {
    expect(screenFor(status())).toBe("status");
  });

  // Offering "Accept and start" to a device an administrator has switched off would
  // put a button in front of the employee that cannot restore anything, and imply the
  // decision was theirs to reverse.
  it("never returns a revoked device to the consent gate", () => {
    expect(screenFor(status({ collecting: false, revoked: true, consentRequired: true }))).toBe(
      "status",
    );
  });

  // Sign-in comes first even when the rest of the flags disagree: there is no employee
  // to ask for consent yet, and the gate names the person it binds.
  it("puts sign-in ahead of every other state", () => {
    const unbound = status({
      enrolled: false,
      collecting: false,
      consentRequired: true,
      revoked: true,
    });

    expect(screenFor(unbound)).toBe("login");
  });
});

describe("connectionLabel", () => {
  it("reads Connected only when collection is actually running unimpeded", () => {
    expect(labelOf(status())).toEqual({ text: "Connected", tone: "ok" });
  });

  it("says the device was stopped by an administrator", () => {
    const label = labelOf(status({ collecting: false, revoked: true }));

    expect(label.tone).toBe("off");
    expect(label.text).toMatch(/administrator/i);
  });

  // Revocation outranks everything, including a stale `collecting` flag: a device that
  // has been switched off server-side must never advertise a live connection.
  it("keeps the revoked wording even if the rest of the status still looks live", () => {
    const label = labelOf(status({ collecting: true, revoked: true, onBreak: true }));

    expect(label.text).toMatch(/administrator/i);
    expect(label.tone).toBe("off");
  });

  it("says nobody is signed in on a fresh machine", () => {
    expect(labelOf(status({ enrolled: false, collecting: false }))).toEqual({
      text: "Not signed in",
      tone: "off",
    });
  });

  // A break is the employee's own decision. Telling them "consent needed" while they
  // are on one would read as their consent having lapsed, which it has not.
  //
  // Asserted with `collecting` both ways. It describes the consent record rather than
  // the loop and stays true across a break today, so only the false case pins the
  // ranking view.ts documents — and only that case fails if the two are ever swapped.
  it.each([true, false])(
    "describes a declared break as a break rather than as missing consent (collecting: %s)",
    (collecting) => {
      const label = labelOf(status({ onBreak: true, collecting }));

      expect(label.text).toMatch(/break/i);
      expect(label.text).not.toMatch(/consent/i);
      expect(label.tone).toBe("warn");
    },
  );

  // This screen rendered "You have finished for today" and "Connected" at the same
  // time: the notice reads `dayEnded` directly, the status row went through
  // `collecting`, and `collecting` stays true after clock-out because it describes the
  // consent record. The two halves of one screen disagreed about whether the employee
  // was being recorded.
  it.each([true, false])(
    "says the day is finished rather than Connected (collecting: %s)",
    (collecting) => {
      const label = labelOf(status({ dayEnded: true, collecting }));

      expect(label.text).toMatch(/finished/i);
      expect(label.text).not.toMatch(/connected/i);
      expect(label.tone).toBe("off");
    },
  );

  it("asks for consent when collection is paused for no other reason", () => {
    const label = labelOf(status({ collecting: false, consentRequired: true }));

    expect(label.text).toMatch(/consent/i);
    expect(label.tone).toBe("warn");
  });

  // The inverse of silent collection, and just as dishonest: a plain "Connected" over
  // an OS that is refusing screen capture claims more is recorded than actually is.
  it("marks the connection limited while the OS is blocking part of the collection", () => {
    const label = labelOf(status({ permissions: permissions({ screenRecording: "denied" }) }));

    expect(label.text).toMatch(/limited/i);
    expect(label.tone).toBe("warn");
  });

  // A paused agent is not collecting anything, so a permission gap is not the headline.
  it("keeps the break wording ahead of a permission gap", () => {
    const label = labelOf(
      status({ onBreak: true, permissions: permissions({ screenRecording: "denied" }) }),
    );

    expect(label.text).toMatch(/break/i);
  });

  it("never reports the ok tone unless collection is running with nothing blocked", () => {
    const notCollecting: AgentStatus[] = [
      status({ enrolled: false, collecting: false }),
      status({ collecting: false, consentRequired: true }),
      status({ collecting: false, revoked: true }),
      status({ onBreak: true }),
      status({ permissions: permissions({ accessibility: "not-determined" }) }),
    ];

    for (const value of notCollecting) {
      expect(labelOf(value).tone).not.toBe("ok");
    }
  });
});

describe("permissionGaps", () => {
  const blocked: PermissionState[] = ["denied", "restricted", "not-determined"];
  const silent: PermissionState[] = ["granted", "not-required", "unknown"];

  it.each(blocked)("reports screen recording as a gap when it is %s", (state) => {
    const gaps = permissionGaps(permissions({ screenRecording: state }));

    expect(gaps.map((gap) => gap.target)).toEqual(["screen-recording"]);
  });

  // `not-required` is the Windows answer — there is no Accessibility gate there — and
  // `unknown` is a reading we could not take. Reporting either as a gap would put a
  // permanent warning on a healthy Windows agent and train the employee to ignore it.
  it.each(silent)("stays quiet when a permission reads %s", (state) => {
    expect(permissionGaps(permissions({ screenRecording: state, accessibility: state }))).toEqual(
      [],
    );
  });

  it("reports both gaps when the OS is blocking both", () => {
    const blockedBoth = permissions({ screenRecording: "denied", accessibility: "denied" });
    const gaps = permissionGaps(blockedBoth);

    expect(gaps.map((gap) => gap.target)).toEqual(["screen-recording", "accessibility"]);
  });

  // The employee is told which collection stopped, not which OS switch flipped —
  // "screen recording is off" only means something next to "so no screenshots".
  it("explains each gap in terms of what is no longer collected", () => {
    const [screen] = permissionGaps(permissions({ screenRecording: "denied" }));
    const [accessibility] = permissionGaps(permissions({ accessibility: "denied" }));

    expect(screen?.detail).toMatch(/screenshot/i);
    expect(accessibility?.detail).toMatch(/website/i);
  });

  it("finds nothing to report on a fully granted machine", () => {
    expect(permissionGaps(permissions())).toEqual([]);
  });
});

describe("trackedSecondsToday", () => {
  // Zero and "nothing yet" are the same number and not the same statement: "0m" on a
  // machine that has not clocked in reads as a day of no work.
  it("reports nothing rather than zero before the day has started", () => {
    expect(trackedSecondsToday(status())).toBeNull();
  });

  it("passes the total through once there is one", () => {
    const value = status({ totals: { ...emptyTotals(), totalSeconds: 42 } });

    expect(trackedSecondsToday(value)).toBe(42);
  });

  it("treats a single tracked second as a started day", () => {
    const value = status({ totals: { ...emptyTotals(), totalSeconds: 1 } });

    expect(trackedSecondsToday(value)).toBe(1);
  });
});

/**
 * RED-first. The window used to answer a broken bridge with "Nothing is being
 * recorded until it can" — a claim it is in no position to make, because main starts
 * the collection loop before the window exists and runs it on its own timer.
 */
describe("unreachableMessage", () => {
  it("never claims that nothing is being recorded", () => {
    expect(unreachableMessage(null)).not.toMatch(/nothing is being recorded/i);
    expect(unreachableMessage("The agent did not report its status.")).not.toMatch(
      /nothing is being recorded/i,
    );
  });

  it("says the agent may still be recording", () => {
    expect(unreachableMessage(null)).toMatch(/may still be recording/i);
  });

  it("hands the employee the signal that does not depend on this window", () => {
    expect(unreachableMessage(null)).toMatch(/tray/i);
  });

  it("still explains that the window could not reach the agent", () => {
    expect(unreachableMessage(null)).toMatch(/could not reach the agent/i);
  });

  it("keeps whatever the failed call reported", () => {
    expect(unreachableMessage("The agent did not report its status.")).toMatch(
      /did not report its status/,
    );
  });

  // The detail arrives from a rejected IPC call and may be a bare clause, which would
  // otherwise run straight into the sentence after it.
  it("terminates an unpunctuated detail before the standing sentence", () => {
    expect(unreachableMessage("no runtime")).toMatch(/no runtime\. It cannot tell you/);
  });

  it("does not double up punctuation the detail already has", () => {
    expect(unreachableMessage("no runtime!")).not.toMatch(/!\./);
  });

  it("falls back to its own wording when there is no detail to show", () => {
    expect(unreachableMessage("   ")).toBe(unreachableMessage(null));
  });
});
