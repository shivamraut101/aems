/**
 * Wire contracts between the agents, the Fastify API, and the dashboard.
 *
 * These are not table rows. Agents report intervals they observed; the API decides
 * what becomes a row. Keeping the two apart means a schema change does not silently
 * alter what an already-deployed agent is allowed to send.
 */

import type { ConsentMethod, DevicePlatform } from "./database.types.js";

/** Sent once when an agent first runs on a machine. */
export interface DeviceEnrollmentRequest {
  platform: DevicePlatform;
  label: string;
  osVersion: string;
  agentVersion: string;
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
  category?: string | null;
  startedAt: string;
  endedAt?: string | null;
}

export interface IdleEventInput {
  clientEventId: string;
  idleStartAt: string;
  idleEndAt?: string | null;
}

export interface ScreenshotMetadataInput {
  clientEventId: string;
  capturedAt: string;
  blurred?: boolean;
}

/** Agents batch events and flush periodically, so ingestion is always a list. */
export interface ActivityBatch {
  deviceId: string;
  workSessionId?: number | null;
  activity?: ActivityEventInput[];
  idle?: IdleEventInput[];
}

export interface ActivityBatchResult {
  acceptedActivity: number;
  acceptedIdle: number;
  /** Rows skipped because their clientEventId was already stored. */
  duplicates: number;
}

export interface HeartbeatInput {
  deviceId: string;
  /** Present when the agent currently has a session open. */
  workSessionId?: number | null;
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
