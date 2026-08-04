/**
 * Turns `AgentStatus` into the handful of decisions the screens make.
 *
 * Kept out of the components so the routing and the wording of a state can be read
 * in one place — which state is on screen is a compliance question, not a layout one.
 */

import type {
  AgentPermissions,
  AgentStatus,
  PermissionState,
  PermissionTarget,
} from "../../shared/types/index.js";

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

export function connectionLabel(
  status: AgentStatus,
  gaps: readonly PermissionGap[],
): ConnectionLabel {
  if (status.revoked) return { text: "Stopped by your administrator", tone: "off" };
  if (!status.enrolled) return { text: "Not signed in", tone: "off" };
  // Ranked above the consent gate: a break is the employee's own decision, and
  // reading "consent needed" while they are on one would be alarming and wrong.
  if (status.onBreak) return { text: "On a break — paused", tone: "warn" };
  if (!status.collecting) return { text: "Paused — consent needed", tone: "warn" };

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

  if (isBlocked(permissions.screenRecording)) {
    gaps.push({ target: "screen-recording", ...GAP_COPY["screen-recording"] });
  }
  if (isBlocked(permissions.accessibility)) {
    gaps.push({ target: "accessibility", ...GAP_COPY.accessibility });
  }

  return gaps;
}

/**
 * `not-determined` counts as blocked: nothing is captured until the employee answers
 * the OS prompt, so from the readout's point of view it is identical to a refusal.
 * `unknown` does not — reporting a gap we cannot confirm would cry wolf.
 */
function isBlocked(state: PermissionState): boolean {
  return state === "denied" || state === "restricted" || state === "not-determined";
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
