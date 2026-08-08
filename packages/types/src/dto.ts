/**
 * Wire contracts between the agents, the Fastify API, and the dashboard.
 *
 * These are not table rows. Agents report intervals they observed; the API decides
 * what becomes a row. Keeping the two apart means a schema change does not silently
 * alter what an already-deployed agent is allowed to send.
 */

import type {
  ConsentMethod,
  DataTypeId,
  DevicePlatform,
  NetworkType,
  ReportFormat,
  ReportStatus,
} from "./database.types.js";

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
  /**
   * What this machine may collect — the platform's capability minus whatever the
   * enrolment code denied. Optional, and absent means "everything the platform
   * supports", the same rule as a missing `device_collection_settings` row: an agent
   * built before this field existed must not read its absence as "collect nothing".
   *
   * Deliberately not a field on `AgentPolicy`: a policy is company-scoped and its
   * `version` is compared against the consented version, so hanging a per-device value
   * off it would make that comparison mean two different things.
   */
  collection?: DataTypeId[];
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
  /**
   * The data types the screen actually listed, and therefore what was agreed to.
   *
   * Optional because an agent that predates per-type consent submits without it, and
   * the row it writes keeps `granted_types` NULL — "the platform default of the day",
   * which is precisely what those signatures meant.
   */
  grantedTypes?: DataTypeId[];
}

/**
 * The heartbeat's answer, widened from `{ ok: true }`.
 *
 * This is how a change of scope reaches a running agent, and it is a widened heartbeat
 * rather than a new endpoint because heartbeat already runs every 60 seconds, already
 * re-reads the device row, and is already the consent-exempt channel revocation travels
 * on. A second poll for two string arrays buys nothing.
 *
 * Every field past `ok` is optional so an agent that ignores them — the Android one
 * does — keeps working unchanged.
 */
export interface HeartbeatResponse {
  ok: true;
  /** The company policy in force, for comparison against the consented version. */
  policyVersion?: string;
  /** What the server is enforcing right now: granted ∩ allowed. */
  collection?: DataTypeId[];
  /**
   * Types an admin switched on that the employee has not yet agreed to. Non-empty means
   * the agent should route back to the consent screen; it must not collect them first.
   */
  pendingTypes?: DataTypeId[];
}

/**
 * One row of a device's collection scope, as the dashboard reads it.
 *
 * Only types with an explicit decision appear — everything else is permitted by
 * absence. `changedByName` is null when the person who made the change has left; the
 * decision outlives them, which is why the attribution is on the settings row rather
 * than looked up from the audit log.
 */
export interface DeviceCollectionSetting {
  dataType: DataTypeId;
  enabled: boolean;
  changedByName: string | null;
  changedAt: string;
}

/** Manager-only. Absent keys are left alone rather than reset to permitted. */
export interface DeviceCollectionUpdate {
  types: Partial<Record<DataTypeId, boolean>>;
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

/**
 * One position fix — `docs/scope.md` §3.5, Android only.
 *
 * `accuracyM` is carried rather than dropped because a fix is a claim with an error
 * bar, and a 2km cell-tower estimate rendered identically to a 5m GPS lock is the
 * kind of "evidence" that gets someone accused of being somewhere they were not.
 */
export interface LocationPointInput {
  clientEventId: string;
  recordedAt: string;
  latitude: number;
  longitude: number;
  /** Metres of horizontal uncertainty, or null when the platform did not say. */
  accuracyM?: number | null;
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
  /**
   * Rides the same batch as everything else so it passes the same consent gate and the
   * same idempotency check. A separate endpoint would have been a second door into the
   * most sensitive table in the product, with its own copy of both.
   */
  locations?: LocationPointInput[];
}

export interface ActivityBatchResult {
  acceptedActivity: number;
  acceptedIdle: number;
  acceptedBreaks: number;
  acceptedLocations: number;
  /** Rows skipped because their clientEventId was already stored. */
  duplicates: number;
  /**
   * Rows the server refused because the device may not collect that type.
   *
   * Reported separately rather than folded into `duplicates`, which would tell an agent
   * its data had already been stored when in fact it was dropped. Optional so an older
   * API's response still parses; absent means nothing was refused.
   */
  refusedActivity?: number;
  refusedIdle?: number;
  refusedLocations?: number;
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

/**
 * An aggregated slice of a person's day, combining activity, idle and screenshots.
 *
 * @deprecated Superseded by {@link DayTimeline}. This shape cannot express scope §2.7
 * at all: it has no break or offline column, it keeps one app and one screenshot id
 * per slot, and being a pure span type it cannot represent a *moment* — "09:00 Login",
 * "10:00 Screenshot" — which is what §2.7's specification is a list of. Kept only so
 * the surfaces still reading it keep compiling; new code reads `DayTimeline`.
 */
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

/**
 * One capture, resolved for display.
 *
 * URLs are signed in the API handler in a single batch call — the bucket is private,
 * so a raw `storage_path` is unrenderable, and signing per row from the browser would
 * be an N+1 against Storage. Either URL may be null if signing failed; the UI shows
 * the block with a "capture unavailable" cell rather than a broken image.
 */
export interface TimelineScreenshot {
  id: number;
  capturedAt: string;
  /** Full-resolution image. */
  url: string | null;
  /** 280px thumbnail when one exists, otherwise the full image. */
  thumbnailUrl: string | null;
  blurred: boolean;
  workSessionId: number | null;
}

/**
 * One cell of the fixed grid.
 *
 * The grid is the unit the ribbon, the screenshot review and the app list all key on.
 * Three views agreeing is a property of there being one grid, not three — so the slot
 * boundaries are anchored to wall-clock multiples of `slotSeconds`, never to an
 * arbitrary `from` the caller happened to pass.
 *
 * `activeSeconds + idleSeconds + breakSeconds + offlineSeconds` is exactly the slot's
 * length in seconds. Offline is the residue rather than an independent measurement,
 * which is what makes that identity hold.
 */
export interface TimelineSlot {
  start: string;
  end: string;
  activeSeconds: number;
  idleSeconds: number;
  /** Declared breaks. Disjoint from idle — the agent closes idle when a break opens. */
  breakSeconds: number;
  /** Slot time no device reported on: clocked out, asleep, or the agent was down. */
  offlineSeconds: number;
  /** active / (active + idle + break). Null when the slot has no tracked time at all. */
  activityRatio: number | null;
  topApps: AppUsage[];
  screenshots: TimelineScreenshot[];
}

export type TimelineSpanKind = "app" | "switching" | "idle" | "break" | "offline";

/**
 * A reduced, renderable stretch of the day.
 *
 * `spans` tiles the whole window: contiguous, non-overlapping, no holes — so the
 * ribbon is one `<rect>` per element with no gap arithmetic in the component. Break
 * beats idle beats app beats offline, because an idle stretch happens *while* a window
 * is focused and rendering the app underneath it would claim work that did not happen.
 */
export interface TimelineSpan {
  start: string;
  end: string;
  kind: TimelineSpanKind;
  /** Null for every kind but "app". */
  appName: string | null;
  /** Kept only when every merged fragment agreed on it; a merged title is residue. */
  windowTitle: string | null;
  category: string | null;
  /**
   * Seconds actually covered.
   *
   * Equal to `end - start` for every kind except "switching", where the cluster spans
   * a wider bracket than the fragments inside it. Totals must read this, never the
   * bracket.
   */
  seconds: number;
  /** Distinct applications folded in. 1 for a plain app span. */
  appCount: number;
  /** Busiest apps inside the span, longest first. One entry for a plain app span. */
  topApps: AppUsage[];
}

export type TimelineMarkerKind =
  | "clock-in"
  | "clock-out"
  | "break-start"
  | "break-end"
  | "idle-start"
  | "active-again"
  | "screenshot";

/**
 * An instant on the day.
 *
 * Scope §2.7's specification is a list of moments — "09:00 Login", "10:00 Screenshot".
 * Spans render as the ribbon; markers render as the rail beside it. Without this type
 * the four event kinds the timeline component already declares are unreachable.
 */
export interface TimelineMarker {
  at: string;
  kind: TimelineMarkerKind;
  /** Ready-to-render copy. Positioning language, never "detected"/"caught". */
  label: string;
  /** Secondary line — app name, device label, or the length of what just ended. */
  detail: string | null;
  /** Set on "screenshot" markers so the rail can open the capture. */
  screenshotId: number | null;
}

/** Whole-window totals, so a header does not have to re-sum the grid. */
export interface TimelineTotals {
  activeSeconds: number;
  /**
   * `activeSeconds`, split by what the work was.
   *
   * The three sum to `activeSeconds` exactly. Active time was previously one number,
   * which forced every worked second into "productive or idle" — and
   * `docs/inspiration.md` argues at length that the honest third bucket is *neutral*:
   * the machine was in use and we cannot fairly call it productive either way.
   *
   * `neutral` is also where uncategorised activity lands, deliberately. An application
   * nobody has written a rule for is evidence of nothing, and a product positioned as
   * workforce intelligence must not count "we don't know" against a person — the same
   * reasoning as `UNCATEGORIZED_RESULT` in the analytics package.
   */
  productiveSeconds: number;
  neutralSeconds: number;
  unproductiveSeconds: number;
  idleSeconds: number;
  breakSeconds: number;
  offlineSeconds: number;
  /** active + idle + break. What scope §2.2 calls "total tracked time". */
  trackedSeconds: number;
  activityRatio: number | null;
}

/** Everything the employee day view needs, reduced server-side. */
export interface DayTimeline {
  profileId: string;
  periodStart: string;
  periodEnd: string;
  slotSeconds: number;
  slots: TimelineSlot[];
  spans: TimelineSpan[];
  markers: TimelineMarker[];
  totals: TimelineTotals;
  /** Busiest apps across the whole window. */
  topApps: AppUsage[];
  /**
   * A row cap was hit, so every number here is a floor rather than a total.
   *
   * Surfaced rather than swallowed: a total that silently omits half a day is worse
   * than one that admits it is partial.
   */
  truncated: boolean;
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
  /**
   * How many separate times the app came to the front.
   *
   * One per reported interval, which is one `activity_events` row. That is
   * deliberately the same arithmetic the Android app does for the employee's own
   * Activity screen — its `totalsFrom` counts sessions and notes that "each session is
   * one activity_events row, so counting rows there and counting sessions here cannot
   * drift apart". A manager and the person being measured have to see the same number.
   *
   * Optional so a caller reducing from something other than raw intervals can omit it
   * rather than report a zero, which would read as "never opened".
   */
  opens?: number;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** The `params` blob a queued run carries, as the dashboard writes and reads it. */
export interface ReportRunParams {
  scope?: string;
  profileIds?: string[];
  decimalDuration?: boolean;
}

/**
 * A row of `GET /api/reports`, which returns the `reports` table verbatim —
 * snake_case, unlike every other DTO here, because nothing remaps it.
 *
 * Declared once because two dashboard screens read this list (the Reports page's
 * export history and the employee Reports tab) against one shared TanStack Query
 * key. Two hand-written copies of a row shape behind a single cache entry is how a
 * column added on the server ends up rendering as `undefined` on one screen only.
 *
 * `kind` and `grouping` stay `string`: the set of report types lives in
 * `@aems/analytics`' registry, which depends on this package and so cannot be
 * imported from it. Narrow them at the point of use.
 */
export interface ReportRecord {
  id: number;
  company_id: string;
  profile_id: string | null;
  kind: string;
  period_start: string;
  period_end: string;
  status: ReportStatus;
  storage_path: string | null;
  created_at: string;
  updated_at: string;
  format: ReportFormat;
  grouping: string;
  params: ReportRunParams | null;
  requested_by: string | null;
  /** Null until the worker renders the run. */
  row_count: number | null;
  /** The reason a `failed` run failed, recorded on the row rather than only in a log. */
  failure_reason: string | null;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}
