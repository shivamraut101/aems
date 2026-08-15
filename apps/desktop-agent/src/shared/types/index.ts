/**
 * The contract between the Electron main process and the React renderer.
 *
 * Everything the renderer is allowed to know lives here. The main process holds the
 * device token, the employee's access token and the event buffers; none of those
 * appear in any type below, because the preload bridge can only expose what this
 * file describes.
 */

import type { AgentPolicy, DataTypeId } from "@aems/types";

export type { AgentPolicy, DataTypeId };

/**
 * IPC channel names.
 *
 * Every channel is namespaced so a stray `ipcRenderer.on` in third-party code cannot
 * collide with one. `STATUS_CHANGED` and `DAY_END_REQUESTED` are the two main → renderer
 * pushes; the rest are invoke/handle pairs.
 */
export const IPC_CHANNELS = {
  STATUS_GET: "aems:status:get",
  STATUS_CHANGED: "aems:status:changed",
  /**
   * The tray asked for the day to end, and wants the window to do the asking.
   *
   * Carries no payload and ends nothing by itself — it opens the same confirmation the
   * window's own button opens, so there is exactly one wording of what ending the day
   * costs rather than one in the renderer and a second in a native dialog box.
   */
  DAY_END_REQUESTED: "aems:day:end-requested",
  POLICY_GET: "aems:policy:get",
  ENROLL: "aems:enroll",
  CONSENT_ACCEPT: "aems:consent:accept",
  PERMISSIONS_GET: "aems:permissions:get",
  PERMISSIONS_OPEN_SETTINGS: "aems:permissions:open-settings",
  BREAK_START: "aems:break:start",
  BREAK_END: "aems:break:end",
  DAY_END: "aems:day:end",
  DAY_START: "aems:day:start",
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
  /**
   * The data types this device may collect, or null when nobody has told us otherwise.
   *
   * Beside `policy` rather than inside it: the policy is company-scoped and its
   * `version` is what `mayCollect` compares against `consentedPolicyVersion`, so
   * hanging a per-device value off it would make that comparison mean two things.
   *
   * Null is the degrade-safe default and it is the same rule as an absent
   * `device_collection_settings` row — an agent that has not yet heartbeated after an
   * upgrade, or one talking to an API that does not send the field, collects exactly
   * what it collected before.
   */
  collection: DataTypeId[] | null;
  /**
   * Types an administrator has switched on that the employee has not yet agreed to.
   *
   * Never collected — they are absent from `collection` precisely because the server
   * enforces `granted ∩ allowed`. Carried so the readout can say a change was made
   * rather than leaving the employee to notice it from the dashboard.
   */
  pendingTypes: DataTypeId[];
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
    collection: null,
    pendingTypes: [],
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

/**
 * Whether one particular kind of observation is permitted on this device.
 *
 * Every per-type gate in `main/` calls this and nothing else, so there is one place
 * where "switched off" is defined. A type that is off must not be *observed* — not
 * merely not sent: the tray and the indicator both claim what is being collected, and
 * sampling something the employee was told is off makes those claims false.
 *
 * An unusable `collection` — absent, or a hand-edited config holding something that is
 * not an array — permits, in the same direction an absent settings row does. Failing
 * open is right here and only here: the API enforces the same set independently, so a
 * degraded agent over-reports to a server that refuses it rather than silently
 * recording nothing all day.
 */
export function mayCollectType(config: AgentConfig, type: DataTypeId): boolean {
  if (!mayCollect(config)) return false;
  return Array.isArray(config.collection) ? config.collection.includes(type) : true;
}

/**
 * What the consent screen lists, and what accepting it agrees to.
 *
 * Permitted now, plus anything an administrator has added since — the pending types
 * are exactly what the employee is being asked about, and they stay uncollected until
 * this set is submitted. Null means no scope has arrived, i.e. the platform default.
 */
export function offeredTypes(
  collection: DataTypeId[] | null,
  pending: readonly DataTypeId[],
): DataTypeId[] | null {
  if (collection === null) return null;
  return [...collection, ...pending.filter((type) => !collection.includes(type))];
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
  /** What this device may record. Null when no per-device scope has been received. */
  collection: DataTypeId[] | null;
  /** What an administrator has switched on since the employee last agreed. */
  pendingTypes: DataTypeId[];
  workSessionId: number | null;
  /** Observed but not yet acknowledged by the API. */
  pendingEvents: number;
  lastSyncAt: string | null;
  permissions: AgentPermissions;
  totals: DayTotals;
  /** An explicit break is open, so idle is not being inferred and capture is paused. */
  onBreak: boolean;
  /**
   * The employee has clocked out for the day.
   *
   * Distinct from `onBreak`, and the difference is the whole point: a break is a pause
   * inside a working day and the agent expects to resume, where this says the day is
   * over. Nothing is collected until it is cleared, and it clears itself at the next
   * local midnight so nobody has to remember to switch monitoring back on.
   */
  dayEnded: boolean;
}

export function statusOf(
  config: AgentConfig,
  extra: Pick<
    AgentStatus,
    | "workSessionId"
    | "pendingEvents"
    | "lastSyncAt"
    | "permissions"
    | "totals"
    | "onBreak"
    | "dayEnded"
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
    collection: config.collection,
    pendingTypes: config.pendingTypes,
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

/**
 * Why nothing is being recorded, or null while it is.
 *
 * The single answer to "is this agent collecting right now", and the reason this
 * exists as a function rather than as a condition each caller assembles.
 *
 * `status.collecting` does NOT mean what its name suggests. It is `mayCollect(config)`
 * — whether the *consent record* permits collection — and it stays true through a
 * break and through a finished day, because neither of those touches consent. Every
 * surface that reports collection therefore has to subtract the pause reasons itself,
 * and three of them independently forgot to subtract `dayEnded`: the indicator pill
 * read "Monitoring", the tray tooltip read "monitoring active", and the status screen
 * read "Connected", all while `Collector.run` was returning early and recording
 * nothing. Three lies from one missing clause, on the surfaces non-negotiable #2 is
 * made of.
 *
 * So the clause lives here once. A fourth pause reason changes this function and
 * nothing else, and the compiler names every caller that has to handle it.
 *
 * Ordered most-terminal first, so a revoked device is never described as merely
 * needing consent. `day-ended` outranks `on-break` because ending the day is offered
 * *from* a break — "finished for today" is the truer of the two statements.
 */
export type PauseReason =
  | "not-enrolled"
  | "revoked"
  | "day-ended"
  | "on-break"
  | "consent-required";

export function pausedBecause(status: AgentStatus): PauseReason | null {
  if (!status.enrolled) return "not-enrolled";
  if (status.revoked) return "revoked";
  if (status.dayEnded) return "day-ended";
  if (status.onBreak) return "on-break";
  if (!status.collecting) return "consent-required";
  return null;
}

/** Why the indicator is not on screen. Carried so a hidden indicator can be logged. */
export type IndicatorHiddenReason = PauseReason;

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
  const paused = pausedBecause(status);
  if (paused !== null) return { visible: false, reason: paused };

  if (hasPermissionGap(status.permissions)) {
    return { visible: true, tone: "limited", label: "Monitoring — limited" };
  }

  return { visible: true, tone: "recording", label: "Monitoring" };
}

// -- channel payloads -----------------------------------------------------

export interface EnrollRequest {
  /**
   * The short code from the dashboard's Devices → Add device, e.g. `K7P2-9WQX`.
   *
   * Never a Supabase access token. A token grants the account's full rights for an
   * hour and no screen in the product ever shows one, so there was no honest answer
   * to "where does an employee get this". A code authorises exactly one enrolment for
   * exactly one person, dies on first use or in ten minutes, and can be read aloud.
   *
   * Sent once and not retained: the device token that comes back is what the agent
   * uses from then on, including for consent.
   */
  enrollmentCode: string;
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
  [IPC_CHANNELS.DAY_END]: { request: void; response: AgentStatus };
  [IPC_CHANNELS.DAY_START]: { request: void; response: AgentStatus };
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
  /**
   * Clock out for the day.
   *
   * Reachable from the window and not only the tray: the tray is a shortcut for people
   * who know it is there, and the window is where everyone else looks. A control that
   * exists in one place is a control most people do not have.
   */
  endDay(): Promise<AgentStatus>;
  startDay(): Promise<AgentStatus>;
  quit(): Promise<void>;
  /** Returns an unsubscribe function — the renderer must call it on unmount. */
  onStatusChanged(listener: (status: AgentStatus) => void): () => void;
  /** Fires when the tray's End day was chosen. Also returns an unsubscribe function. */
  onEndDayRequested(listener: () => void): () => void;
}
