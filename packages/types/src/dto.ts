/**
 * Wire contracts between the agents, the Fastify API, and the dashboard.
 *
 * These are not table rows. Agents report intervals they observed; the API decides
 * what becomes a row. Keeping the two apart means a schema change does not silently
 * alter what an already-deployed agent is allowed to send.
 */

import type { ConsentMethod, DevicePlatform, NetworkType } from "./database.types.js";

/**
 * Sent once when an agent first runs on a machine.
 *
 * Everything past `agentVersion` is inventory (scope §7) rather than identity: a
 * platform that cannot read a figure omits it instead of guessing, because one
 * unreadable field must not fail the whole enrolment.
 */
export interface DeviceEnrollmentRequest {
  platform: DevicePlatform;
  label: string;
  osVersion: string;
  agentVersion: string;
  deviceName?: string;
  model?: string;
  cpu?: string | null;
  ramMb?: number | null;
  storageMb?: number | null;
}

/** One entry in a device's installed-application inventory. */
export interface InstalledApplication {
  name: string;
  version?: string | null;
  /** Uninstall key on Windows, bundle identifier on macOS. */
  identifier?: string | null;
}

/** Cold path — sent at enrolment and then occasionally, never on the collection timer. */
export interface DeviceApplicationsInput {
  applications: InstalledApplication[];
}

export interface DeviceEnrollmentResponse {
  deviceId: string;
  companyId: string;
  profileId: string;
  /** Long-lived token the agent presents on every later request. */
  deviceToken: string;
  /** Agents must block all collection until this is true. */
  consentRequired: boolean;
  policy: AgentPolicy;
}

/** The subset of a policy row an agent needs in order to behave correctly. */
export interface AgentPolicy {
  version: string;
  name: string;
  screenshotIntervalSeconds: number;
  idleThresholdSeconds: number;
  trackedCategories: string[];
}

export interface ConsentSubmission {
  deviceId: string;
  policyVersion: string;
  method: ConsentMethod;
}

/**
 * One observed application/window focus interval.
 *
 * `clientEventId` is generated on the device and must be stable across retries —
 * it is the idempotency key for the whole ingestion path.
 */
export interface ActivityEventInput {
  clientEventId: string;
  appName: string;
  windowTitle?: string | null;
  url?: string | null;
  /**
   * Host the interval was spent on, already reduced from the URL.
   *
   * Website reporting (scope §2.5) groups on this rather than on `url`, so the
   * reduction happens on the device — the API stores what it is given.
   */
  domain?: string | null;
  category?: string | null;
  startedAt: string;
  endedAt?: string | null;
}

export interface IdleEventInput {
  clientEventId: string;
  idleStartAt: string;
  idleEndAt?: string | null;
}

/**
 * One break the employee declared, as opposed to idle time inferred from the OS.
 *
 * Both are subtracted from active time, so a declared break and an inferred idle
 * stretch must never cover the same seconds — the agent closes idle at the break.
 */
export interface BreakEventInput {
  clientEventId: string;
  breakStartAt: string;
  breakEndAt?: string | null;
}

export interface ScreenshotMetadataInput {
  clientEventId: string;
  capturedAt: string;
  blurred?: boolean;
  /** Without it the timeline cannot place a shot inside the session it belongs to. */
  workSessionId?: number | null;
}

/**
 * Either shape `POST /api/screenshots` returns.
 *
 * A replayed `clientEventId` yields `{ duplicate: true }` and no id. Treating that
 * as a failure would re-upload the same megabytes forever.
 */
export type ScreenshotUploadResult = { screenshotId: number } | { duplicate: true };

/** Agents batch events and flush periodically, so ingestion is always a list. */
export interface ActivityBatch {
  deviceId: string;
  workSessionId?: number | null;
  activity?: ActivityEventInput[];
  idle?: IdleEventInput[];
  breaks?: BreakEventInput[];
}

export interface ActivityBatchResult {
  acceptedActivity: number;
  acceptedIdle: number;
  acceptedBreaks: number;
  /** Rows skipped because their clientEventId was already stored. */
  duplicates: number;
}

export interface HeartbeatInput {
  deviceId: string;
  /** Present when the agent currently has a session open. */
  workSessionId?: number | null;
}

/**
 * Battery, network and screen-active time — collected data, not liveness. Unlike
 * `HeartbeatInput`, this goes through the same consent gate as activity and
 * screenshots, because it is an observation about the device rather than a signal
 * that the agent is still alive.
 */
export interface TelemetryInput {
  batteryLevel?: number | null;
  batteryCharging?: boolean | null;
  networkType?: NetworkType | null;
  storageFreeMb?: number | null;
  screenActiveSeconds?: number | null;
}

/** An aggregated slice of a person's day, combining activity, idle and screenshots. */
export interface TimelineEntry {
  profileId: string;
  deviceId: string;
  periodStart: string;
  periodEnd: string;
  activeSeconds: number;
  idleSeconds: number;
  topApp: string | null;
  screenshotId: number | null;
}

export interface ProductivitySummary {
  profileId: string;
  periodStart: string;
  periodEnd: string;
  activeSeconds: number;
  idleSeconds: number;
  /** activeSeconds / (activeSeconds + idleSeconds), 0 when nothing was recorded. */
  productivityRatio: number;
  topApps: AppUsage[];
}

export interface AppUsage {
  appName: string;
  category: string | null;
  seconds: number;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}
