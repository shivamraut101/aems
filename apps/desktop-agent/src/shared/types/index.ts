/**
 * The contract between the Electron main process and the React renderer.
 *
 * Everything the renderer is allowed to know lives here. The main process holds the
 * device token, the employee's access token and the event buffers; none of those
 * appear in any type below, because the preload bridge can only expose what this
 * file describes.
 */

import type { AgentPolicy } from "@aems/types";

export type { AgentPolicy };

/**
 * IPC channel names.
 *
 * Every channel is namespaced so a stray `ipcRenderer.on` in third-party code cannot
 * collide with one. `STATUS_CHANGED` is the only main → renderer push; the rest are
 * invoke/handle pairs.
 */
export const IPC_CHANNELS = {
  STATUS_GET: "aems:status:get",
  STATUS_CHANGED: "aems:status:changed",
  POLICY_GET: "aems:policy:get",
  ENROLL: "aems:enroll",
  CONSENT_ACCEPT: "aems:consent:accept",
  PERMISSIONS_GET: "aems:permissions:get",
  PERMISSIONS_OPEN_SETTINGS: "aems:permissions:open-settings",
  BREAK_START: "aems:break:start",
  BREAK_END: "aems:break:end",
  QUIT: "aems:quit",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// -- permissions ----------------------------------------------------------

/** Mirrors Electron's media-access states, plus a value for platforms that have no such gate. */
export type PermissionState =
  "granted" | "denied" | "restricted" | "not-determined" | "unknown" | "not-required";

/**
 * How much of a browser address the platform can actually be seen to report.
 *
 * Lives here rather than beside the reader that produces it because it is a claim the
 * renderer has to make to the employee, not an implementation detail of `main/`.
 * `window-title` means the address is only ever recovered when a page carried no
 * `<title>` of its own — in practice almost never — so a Windows machine reporting an
 * empty Websites view is the platform working as designed, not the agent failing.
 */
export type UrlFidelity = "browser-url" | "window-title";

/**
 * Whether the OS still lets the agent see what it claims to be collecting.
 *
 * macOS can revoke Screen Recording at any time, and Sequoia re-prompts on a
 * schedule. Without this, a lapsed permission is indistinguishable from an employee
 * who simply stopped working — so it is reported, not just logged.
 */
export interface AgentPermissions {
  screenRecording: PermissionState;
  /** Needed for browser URL reads on macOS. Not a concept on Windows. */
  accessibility: PermissionState;
  /**
   * A capability, not a grant — which is why it is not a `PermissionState`.
   *
   * Nothing the employee or an administrator can click changes it, so it deliberately
   * does not feed `permissionGaps`: a permanent "limited" badge on every Windows
   * machine would train people to ignore the badge that means a real, fixable block.
   */
  websiteTracking: UrlFidelity;
}

export type PermissionTarget = "screen-recording" | "accessibility";

/**
 * Whether a state means "the agent is being stopped from seeing this".
 *
 * `not-determined` counts: nothing is captured until the employee answers the OS
 * prompt, so from a readout's point of view it is identical to a refusal. `unknown`
 * does not — reporting a gap we cannot confirm would cry wolf.
 *
 * Shared rather than renderer-local because the main process asks the same question
 * when it decides whether the indicator says "Monitoring" or "Monitoring — limited",
 * and two copies of a compliance rule eventually disagree.
 */
export function isPermissionBlocked(state: PermissionState): boolean {
  return state === "denied" || state === "restricted" || state === "not-determined";
}

/** True when the OS is blocking something the agent claims to be collecting. */
export function hasPermissionGap(permissions: AgentPermissions): boolean {
  return (
    isPermissionBlocked(permissions.screenRecording) ||
    isPermissionBlocked(permissions.accessibility)
  );
}

// -- agent state ----------------------------------------------------------

/**
 * Agent state that survives a restart.
 *
 * `deviceToken` is the only secret; it is encrypted at rest with Electron's
 * `safeStorage` (DPAPI on Windows, Keychain on macOS) rather than sitting in the
 * JSON alongside the rest. The employee's Supabase access token is deliberately
 * absent — main holds it in memory for the enrol → consent handshake and drops it.
 */
export interface AgentConfig {
  apiUrl: string;
  deviceId: string | null;
  deviceToken: string | null;
  profileId: string | null;
  companyId: string | null;
  /**
   * Version the employee agreed to. A policy bump leaves this behind the current
   * version, which is what makes consent lapse automatically.
   */
  consentedPolicyVersion: string | null;
  policy: AgentPolicy | null;
  /** Set when the server has told us to stop. Re-consent must not clear it. */
  revoked: boolean;
}

export function emptyConfig(apiUrl: string): AgentConfig {
  return {
    apiUrl,
    deviceId: null,
    deviceToken: null,
    profileId: null,
    companyId: null,
    consentedPolicyVersion: null,
    policy: null,
    revoked: false,
  };
}

/**
 * Whether the agent is allowed to collect anything at all.
 *
 * Enrolment alone is not enough — consent must be on file, and it must be for the
 * policy version currently in force. Re-checking this every tick is what makes
 * revocation from the dashboard take effect without restarting the agent.
 *
 * This is the agent-side half of the gate only. The API rejects ingestion
 * independently, because an agent is a binary on someone else's laptop.
 */
export function mayCollect(config: AgentConfig): boolean {
  if (config.revoked) return false;
  if (!config.deviceToken || !config.policy || !config.consentedPolicyVersion) return false;
  return config.policy.version === config.consentedPolicyVersion;
}

// -- observed time --------------------------------------------------------

/**
 * A stretch of wall-clock time in ISO-8601. `endedAt` is null while it is still running.
 *
 * Work sessions, idle stretches and breaks are all this shape, which is what lets the
 * day summary treat them as one kind of thing.
 */
export interface DaySpan {
  startedAt: string;
  endedAt: string | null;
}

/**
 * Scope §2.2's headline block for one day.
 *
 * The three parts partition the total exactly — the renderer displays them together,
 * so parts that add to more than the total read as a bug in the product.
 */
export interface DayTotals {
  totalSeconds: number;
  activeSeconds: number;
  idleSeconds: number;
  breakSeconds: number;
}

export function emptyTotals(): DayTotals {
  return { totalSeconds: 0, activeSeconds: 0, idleSeconds: 0, breakSeconds: 0 };
}

/** What the renderer and the tray render from. Contains no credentials. */
export interface AgentStatus {
  enrolled: boolean;
  collecting: boolean;
  /** Enrolled, not revoked, but the in-force policy has not been accepted. */
  consentRequired: boolean;
  /**
   * Terminal state: the device was revoked or the employee disabled server-side.
   * Kept separate from `consentRequired` so the UI does not offer to re-consent
   * out of a revocation.
   */
  revoked: boolean;
  policyVersion: string | null;
  workSessionId: number | null;
  /** Observed but not yet acknowledged by the API. */
  pendingEvents: number;
  lastSyncAt: string | null;
  permissions: AgentPermissions;
  totals: DayTotals;
  /** An explicit break is open, so idle is not being inferred and capture is paused. */
  onBreak: boolean;
}

export function statusOf(
  config: AgentConfig,
  extra: Pick<
    AgentStatus,
    "workSessionId" | "pendingEvents" | "lastSyncAt" | "permissions" | "totals" | "onBreak"
  >,
): AgentStatus {
  const enrolled = config.deviceToken !== null;
  const collecting = mayCollect(config);

  return {
    enrolled,
    collecting,
    consentRequired: enrolled && !config.revoked && !collecting,
    revoked: config.revoked,
    policyVersion: config.policy?.version ?? null,
    ...extra,
  };
}

// -- the always-visible indicator -----------------------------------------

/**
 * The always-on-top indicator's state machine (non-negotiable #2).
 *
 * It lives in the shared contract because *both* processes need the same answer: main
 * decides whether the window exists at all, and the window decides what it says. Two
 * copies of that rule would eventually disagree, and a pill reading "Monitoring" over
 * a stopped agent is the same lie as collecting with no pill at all.
 *
 * Keeping it here rather than in `renderer/lib` is also what stops the main-process
 * bundle from importing renderer modules to get at it — a direction that only holds
 * for as long as nobody adds a DOM import to the file at the other end.
 */

/**
 * How the indicator window tells itself apart from the main agent window.
 *
 * Both load the same `index.html` — the renderer has one Vite entry — so the fragment
 * is what the entry point reads to decide which of the two it is painting.
 */
export const INDICATOR_HASH = "#indicator";

export function isIndicatorRoute(hash: string): boolean {
  return hash === INDICATOR_HASH;
}

/** Why the indicator is not on screen. Carried so a hidden indicator can be logged. */
export type IndicatorHiddenReason = "not-enrolled" | "consent-required" | "revoked" | "on-break";

export type IndicatorTone = "recording" | "limited";

export type IndicatorState =
  | { visible: false; reason: IndicatorHiddenReason }
  | { visible: true; tone: IndicatorTone; label: string };

/**
 * When the indicator is on screen, and what it says while it is.
 *
 * One rule, in one direction: the pill appears if and only if the agent is actually
 * recording. Anything else — no sign-in, a revoked device, an open consent gate, a
 * declared break — leaves the screen clear, because an indicator over an agent that
 * is collecting nothing tells the employee something untrue.
 *
 * The reasons are ordered most-terminal first, so a revoked device is never described
 * as merely needing consent.
 */
export function indicatorStateFor(status: AgentStatus): IndicatorState {
  if (!status.enrolled) return { visible: false, reason: "not-enrolled" };
  if (status.revoked) return { visible: false, reason: "revoked" };
  // Ranked above the consent gate because a break is the employee's own decision and
  // `collecting` stays true through one — it describes the consent record, not the loop.
  if (status.onBreak) return { visible: false, reason: "on-break" };
  if (!status.collecting) return { visible: false, reason: "consent-required" };

  if (hasPermissionGap(status.permissions)) {
    return { visible: true, tone: "limited", label: "Monitoring — limited" };
  }

  return { visible: true, tone: "recording", label: "Monitoring" };
}

// -- channel payloads -----------------------------------------------------

export interface EnrollRequest {
  /**
   * Supabase access token for the signed-in employee. Enrolment and the consent
   * POST both run as the user, so main keeps this in memory until consent lands
   * and never writes it to disk.
   */
  accessToken: string;
}

/** Shape of every invoke channel: what it takes and what it gives back. */
export interface IpcContract {
  [IPC_CHANNELS.STATUS_GET]: { request: void; response: AgentStatus };
  [IPC_CHANNELS.POLICY_GET]: { request: void; response: AgentPolicy | null };
  [IPC_CHANNELS.ENROLL]: { request: EnrollRequest; response: AgentStatus };
  [IPC_CHANNELS.CONSENT_ACCEPT]: { request: void; response: AgentStatus };
  [IPC_CHANNELS.PERMISSIONS_GET]: { request: void; response: AgentPermissions };
  [IPC_CHANNELS.PERMISSIONS_OPEN_SETTINGS]: {
    request: PermissionTarget;
    response: void;
  };
  [IPC_CHANNELS.BREAK_START]: { request: void; response: AgentStatus };
  [IPC_CHANNELS.BREAK_END]: { request: void; response: AgentStatus };
  [IPC_CHANNELS.QUIT]: { request: void; response: void };
}

/**
 * The entire surface exposed on `window.aems`.
 *
 * No Node primitive, no file path, no token. Adding anything here is a security
 * decision, not a convenience one.
 */
export interface AgentApi {
  getStatus(): Promise<AgentStatus>;
  getPolicy(): Promise<AgentPolicy | null>;
  enroll(request: EnrollRequest): Promise<AgentStatus>;
  acceptConsent(): Promise<AgentStatus>;
  getPermissions(): Promise<AgentPermissions>;
  openPermissionSettings(target: PermissionTarget): Promise<void>;
  /**
   * Declares a break. Collection pauses for its duration and the span is reported,
   * so the time reads as a break rather than as unexplained idle.
   */
  startBreak(): Promise<AgentStatus>;
  endBreak(): Promise<AgentStatus>;
  quit(): Promise<void>;
  /** Returns an unsubscribe function — the renderer must call it on unmount. */
  onStatusChanged(listener: (status: AgentStatus) => void): () => void;
}
