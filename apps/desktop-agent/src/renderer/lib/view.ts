/**
 * Turns `AgentStatus` into the handful of decisions the screens make.
 *
 * Kept out of the components so the routing and the wording of a state can be read
 * in one place — which state is on screen is a compliance question, not a layout one.
 */

import { PLATFORM_DATA_TYPES } from "@aems/types";

import type {
  AgentPermissions,
  AgentStatus,
  DataTypeId,
  PauseReason,
  PermissionTarget,
} from "../../shared/types/index.js";
import { isPermissionBlocked, offeredTypes, pausedBecause } from "../../shared/types/index.js";

export type Screen = "login" | "consent" | "status";

export type Tone = "ok" | "warn" | "off";

export interface ConnectionLabel {
  text: string;
  tone: Tone;
}

export interface PermissionGap {
  target: PermissionTarget;
  title: string;
  detail: string;
}

export function screenFor(status: AgentStatus): Screen {
  if (!status.enrolled) return "login";

  // Revocation is terminal, so it stays on the readout. Sending a revoked device back
  // to the consent gate would offer the employee a button that cannot restore
  // anything, and imply the decision was theirs to reverse.
  if (status.revoked) return "status";

  return status.consentRequired ? "consent" : "status";
}

/** Every way collection can be stopped, said in the employee's words. Total on purpose. */
const PAUSED_LABEL: Record<PauseReason, ConnectionLabel> = {
  revoked: { text: "Stopped by your administrator", tone: "off" },
  "not-enrolled": { text: "Not signed in", tone: "off" },
  "day-ended": { text: "Finished for today", tone: "off" },
  "on-break": { text: "On a break — paused", tone: "warn" },
  "consent-required": { text: "Paused — consent needed", tone: "warn" },
};

export function connectionLabel(
  status: AgentStatus,
  gaps: readonly PermissionGap[],
): ConnectionLabel {
  // One source for "is anything being recorded" — see `pausedBecause` — read through a
  // total map so a new pause reason cannot fall through to "Connected". Assembling the
  // condition inline is what let this screen report "Connected" directly above its own
  // "You have finished for today" notice.
  const paused = pausedBecause(status);
  if (paused !== null) return PAUSED_LABEL[paused];

  // Claiming a plain "Connected" while the OS is blocking capture would tell the
  // employee more is being recorded than actually is.
  if (gaps.length > 0) return { text: "Connected — limited", tone: "warn" };

  return { text: "Connected", tone: "ok" };
}

const GAP_COPY: Record<PermissionTarget, Omit<PermissionGap, "target">> = {
  "screen-recording": {
    title: "Screen recording is turned off",
    detail:
      "macOS is blocking screen capture, so no screenshots are being taken. Everything else is unaffected.",
  },
  accessibility: {
    title: "Accessibility access is turned off",
    detail: "macOS is blocking window details, so website addresses are not being recorded.",
  },
};

export function permissionGaps(permissions: AgentPermissions): PermissionGap[] {
  const gaps: PermissionGap[] = [];

  if (isPermissionBlocked(permissions.screenRecording)) {
    gaps.push({ target: "screen-recording", ...GAP_COPY["screen-recording"] });
  }
  if (isPermissionBlocked(permissions.accessibility)) {
    gaps.push({ target: "accessibility", ...GAP_COPY.accessibility });
  }

  // `websiteTracking` is deliberately absent: it is a platform capability nobody can
  // grant, and a gap the employee cannot close is a notice, not a warning.
  return gaps;
}

/**
 * What this platform can honestly promise about website tracking, or null when the
 * full promise holds.
 *
 * Windows has no supported way to read a browser tab's address, so the Websites view
 * there is near-empty by construction. Saying so is the difference between an honest
 * product and a consent screen that promises something the binary cannot do.
 */
export function websiteTrackingNote(permissions: AgentPermissions): string | null {
  if (permissions.websiteTracking === "browser-url") return null;

  return "This computer cannot report the addresses of pages you open, so website activity is not recorded here.";
}

/**
 * The sentence every "cannot reach the agent" state has to carry.
 *
 * This window is a viewer, not the collector. `main/index.ts` calls `collector.start()`
 * before `createWindow()`, and the loop runs on its own timer from then on — so a
 * preload bridge that never attached, or an invoke that rejected, tells us only that
 * the window cannot see. It is not evidence that recording stopped.
 *
 * Of the two ways to be wrong here, a false all-clear is the worse one: it reads as
 * permission to relax on a machine that is still being recorded. So the window says it
 * does not know, and hands the employee the signal that does not depend on it.
 */
const MONITORING_UNKNOWN =
  "It cannot tell you whether monitoring is running, and the agent may still be recording. " +
  "The tray icon is the signal that does not depend on this window — quit from there if you " +
  "need monitoring to stop.";

const NO_BRIDGE = "This window could not reach the agent.";

/** Prefixes whatever went wrong to the standing "we do not know" sentence. */
export function unreachableMessage(detail: string | null): string {
  const lead = (detail ?? "").trim();
  if (lead.length === 0) return `${NO_BRIDGE} ${MONITORING_UNKNOWN}`;

  // The detail comes from a rejected IPC call and may be a bare clause with no
  // terminator, which would run straight into the sentence below it.
  const terminated = /[.!?]$/.test(lead) ? lead : `${lead}.`;
  return `${terminated} ${MONITORING_UNKNOWN}`;
}

/**
 * The day's tracked total, or null before anything has been recorded.
 *
 * Zero and "nothing yet" are the same number but not the same statement — showing
 * "0m" on a machine that has not clocked in reads as a day of no work rather than as
 * a day that has not started.
 */
export function trackedSecondsToday(status: AgentStatus): number | null {
  return status.totals.totalSeconds > 0 ? status.totals.totalSeconds : null;
}

/**
 * What a desktop agent may collect before any per-device scope has reached it.
 *
 * `windows` and `macos` carry the same set, so one constant covers both platforms this
 * agent ships on — the renderer is sandboxed and has no `process.platform` to branch on
 * anyway. Reached whenever `status.collection` is null, which is an agent that has not
 * heartbeated since an upgrade or one talking to an API that does not send the field:
 * both must describe exactly what the agent collected before this existed.
 */
const DESKTOP_DEFAULT_TYPES: readonly DataTypeId[] = PLATFORM_DATA_TYPES.windows;

/** What this device is recording right now. Never empty by accident — null means default. */
export function collectedTypes(status: AgentStatus): readonly DataTypeId[] {
  return status.collection ?? DESKTOP_DEFAULT_TYPES;
}

/**
 * What the consent gate lists: permitted now, plus anything an administrator has added.
 *
 * The pending types belong on the gate precisely because they are not being collected —
 * they are what the employee is being asked about, and they stay uncollected until this
 * set is submitted.
 */
export function consentTypes(status: AgentStatus): readonly DataTypeId[] {
  return offeredTypes(status.collection, status.pendingTypes) ?? DESKTOP_DEFAULT_TYPES;
}
