import * as Battery from "expo-battery";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";

import type { ActivityEventInput, InstalledApplication, NetworkType } from "@aems/types";
import { AemsApiError } from "@aems/sdk";

import { client } from "./api";
import { clearDeviceCredentials, loadSyncContext, LAST_SYNC_KEY } from "./state";
import AemsUsage from "../modules/aems-usage";

export type SyncOutcome = "synced" | "revoked" | "no-device";

const LAST_ACTIVITY_SYNC_KEY = "aems.lastActivitySyncAt";
/** First-ever sync on a freshly consented device looks back this far, not further. */
const DEFAULT_LOOKBACK_MS = 30 * 60 * 1000;

/**
 * Runs one pass of heartbeat → telemetry → app usage, for both the foreground
 * interval and the background-fetch task (`background-task.ts`). Reads device
 * credentials from `SecureStore` itself rather than from React state, because the
 * background task runs with no mounted component.
 */
export async function runSyncCycle(): Promise<SyncOutcome> {
  const context = await loadSyncContext();
  if (context === null) return "no-device";

  const { credentials, consented } = context;
  client.setAuth({ kind: "device", token: credentials.deviceToken });

  // No consent gate on the server side either — this is the channel a revoked or
  // de-consented device finds out, so it must run even before consent is given.
  const heartbeat = await attempt(() => client.heartbeat({ deviceId: credentials.deviceId }));
  if (heartbeat === "revoked") {
    await clearDeviceCredentials();
    return "revoked";
  }

  if (!consented) {
    // Enrolled but not yet consented: heartbeat keeps the device visible as online
    // on the dashboard, but nothing past it may run — the API rejects it anyway,
    // and an agent that tried would be observing before permission was given.
    return "synced";
  }

  await attempt(() => syncTelemetry());
  const activity = await attempt(() => syncActivity(credentials.deviceId));
  if (activity === "revoked") {
    await clearDeviceCredentials();
    return "revoked";
  }

  await SecureStore.setItemAsync(LAST_SYNC_KEY, new Date().toISOString());
  return "synced";
}

async function syncTelemetry(): Promise<void> {
  const [batteryLevel, batteryState, networkState, snapshot] = await Promise.all([
    Battery.getBatteryLevelAsync(),
    Battery.getBatteryStateAsync(),
    Network.getNetworkStateAsync(),
    AemsUsage.getDeviceSnapshot(),
  ]);

  await client.reportTelemetry({
    // -1 is expo-battery's "unknown" — omit rather than report a bogus level.
    batteryLevel: batteryLevel >= 0 ? Math.round(batteryLevel * 100) : null,
    batteryCharging: batteryChargingFrom(batteryState),
    networkType: networkTypeFrom(networkState.type),
    storageFreeMb: snapshot.freeStorageMb,
    screenActiveSeconds: snapshot.screenActiveSeconds,
  });
}

function batteryChargingFrom(state: Battery.BatteryState): boolean | null {
  if (state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL) return true;
  if (state === Battery.BatteryState.UNPLUGGED) return false;
  return null;
}

/** Only the values our `NetworkType` enum actually has room for — anything else is omitted rather than guessed. */
function networkTypeFrom(type: Network.NetworkStateType | undefined): NetworkType | null {
  switch (type) {
    case Network.NetworkStateType.WIFI:
      return "wifi";
    case Network.NetworkStateType.CELLULAR:
      return "cellular";
    case Network.NetworkStateType.ETHERNET:
      return "ethernet";
    case Network.NetworkStateType.NONE:
      return "offline";
    default:
      return null;
  }
}

/**
 * App usage (scope §3.2) and installed-application inventory (scope §3.4), from one
 * `queryUsage()` call per cycle.
 *
 * `UsageStatsManager` reports aggregate per-app foreground totals for the queried
 * window, not discrete focus-switch intervals the way the desktop agent's tracker
 * does — Android's platform API has no equivalent without extra permissions. Each
 * app's total is reported as a single synthesized interval
 * (`startedAt = firstTimeStamp`, `endedAt = firstTimeStamp + totalTimeForegroundMs`)
 * so the derived duration matches what Android actually measured. This is an
 * approximation, documented rather than silently passed off as a true interval —
 * the same honesty-over-precision trade-off as the desktop agent's Windows
 * website-tracking limitation.
 *
 * The query window advances from the last successful sync rather than using a fixed
 * look-back, so totals are only ever reported once: `queryUsage` returns an
 * aggregate for whatever range it's asked about, and re-querying an overlapping
 * range would either double-report a stat or, since a growing total shares the
 * previous cycle's `clientEventId`, get silently deduplicated by the ingestion
 * endpoint's idempotency check and undercount the day.
 */
async function syncActivity(deviceId: string): Promise<"ok" | "revoked"> {
  const startMs = await loadLastActivitySyncMs();
  const endMs = Date.now();
  if (endMs <= startMs) return "ok";

  const stats = await AemsUsage.queryUsage(startMs, endMs);

  if (stats.length === 0) {
    await SecureStore.setItemAsync(LAST_ACTIVITY_SYNC_KEY, String(endMs));
    return "ok";
  }

  const applications: InstalledApplication[] = stats.map((stat) => ({
    name: stat.appLabel,
    identifier: stat.packageName,
  }));

  const activity: ActivityEventInput[] = stats.map((stat) => ({
    // Stable across a retry of *this* cycle (same window), which is all the
    // stability this needs — the next cycle queries a disjoint window and so
    // naturally produces different ids.
    clientEventId: `${deviceId}:${stat.packageName}:${startMs}`,
    appName: stat.appLabel,
    startedAt: new Date(stat.firstTimeStamp).toISOString(),
    endedAt: new Date(stat.firstTimeStamp + stat.totalTimeForegroundMs).toISOString(),
  }));

  const applicationsOutcome = await attempt(() => client.reportApplications({ applications }));
  if (applicationsOutcome === "revoked") return "revoked";

  const activityOutcome = await attempt(() => client.ingestActivity({ deviceId, activity }));
  if (activityOutcome === "revoked") return "revoked";

  // Only advance past this window once both reports were at least attempted
  // without a revocation — a dropped or retryable failure leaves the window
  // in place so the next cycle covers the same usage again rather than losing it.
  await SecureStore.setItemAsync(LAST_ACTIVITY_SYNC_KEY, String(endMs));
  return "ok";
}

async function loadLastActivitySyncMs(): Promise<number> {
  const stored = await SecureStore.getItemAsync(LAST_ACTIVITY_SYNC_KEY);
  if (stored !== null) {
    const parsed = Number(stored);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now() - DEFAULT_LOOKBACK_MS;
}

/**
 * Runs one step of a cycle, classifying its failure the same way the desktop
 * agent's `SyncQueue.classifyError` does (`apps/desktop-agent/src/main/sync.ts`):
 * a revoked/expired credential needs re-enrolment and must stop the cycle, but a
 * network fault or a rejected batch is left for the next cycle to retry rather
 * than aborting everything after it.
 */
async function attempt(fn: () => Promise<unknown>): Promise<"ok" | "revoked" | "failed"> {
  try {
    await fn();
    return "ok";
  } catch (error) {
    return classifyError(error) === "revoked" ? "revoked" : "failed";
  }
}

function classifyError(error: unknown): "revoked" | "transient" {
  const { statusCode, code } = apiErrorFields(error);

  if (code === "device_revoked" || code === "monitoring_disabled") return "revoked";
  // A rejected token is not a bad batch: the signature is invalid, the devices row
  // is gone, or local state disagrees with the token. No amount of resending fixes it.
  if (statusCode === 401) return "revoked";

  return "transient";
}

function apiErrorFields(error: unknown): { statusCode: number | null; code: string | null } {
  if (error instanceof AemsApiError) return { statusCode: error.statusCode, code: error.code };
  return { statusCode: null, code: null };
}
