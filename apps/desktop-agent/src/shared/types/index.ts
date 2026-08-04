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
}

export type PermissionTarget = "screen-recording" | "accessibility";

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
