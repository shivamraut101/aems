import * as Battery from "expo-battery";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";

import type { ActivityEventInput, InstalledApplication, NetworkType } from "@aems/types";
import { AemsApiError } from "@aems/sdk";

import { client } from "./api";
import { hasEnded, isOnBreak, loadDay } from "./day";
import { clearPending, enqueue, loadPending, pendingCount } from "./queue";
import { closeForgottenBreak, ensureWorkSession } from "./session";
import { samplePoint } from "./location";
import { clearDeviceCredentials, loadSyncContext, LAST_SYNC_KEY, markRevoked } from "./state";
import { uuidFrom } from "./uuid";
import AemsUsage from "../modules/aems-usage";

export type SyncOutcome = "synced" | "revoked" | "no-device";

const LAST_ACTIVITY_SYNC_KEY = "aems.lastActivitySyncAt";
/** First-ever sync on a freshly consented device looks back this far, not further. */
const DEFAULT_LOOKBACK_MS = 30 * 60 * 1000;
/** Ceiling on how far a rewound watermark may drag the query window back. */
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

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
    await revoke();
    return "revoked";
  }

  if (!consented) {
    // Enrolled but not yet consented: heartbeat keeps the device visible as online
    // on the dashboard, but nothing past it may run — the API rejects it anyway,
    // and an agent that tried would be observing before permission was given.
    return "synced";
  }

  // A break the employee forgot to end is closed here rather than on a timer, because
  // a sleeping phone runs no timers but does reach this line when it wakes. How long is
  // "forgotten" is the admin's, published on the policy this device enrolled under.
  await closeForgottenBreak(credentials.policy.maxOpenBreakSeconds);

  const day = await ensureWorkSession(await loadDay(), credentials.deviceId);

  await attempt(() => syncTelemetry());

  // Observation stops for a declared break and for a finished day, matching the
  // desktop collector — but the queue is still drained, so anything already recorded
  // still reaches the server.
  const observing = !isOnBreak(day) && !hasEnded(day);
  if (observing) {
    await attempt(() => collectActivity(credentials.deviceId));
    // Gated on `observing` for the same reason app usage is, and it matters more here:
    // a declared break is when someone steps out, and recording where they went is
    // precisely the collection they were told stops. §3.5 is about where the company's
    // devices are during work, not about where their holder is at lunch.
    await attempt(() => collectLocation(credentials.deviceId));
  }

  const flushed = await attempt(() => flushPending(credentials.deviceId, day.workSessionId));
  if (flushed === "revoked") {
    await revoke();
    return "revoked";
  }

  await SecureStore.setItemAsync(LAST_SYNC_KEY, new Date().toISOString());
  return "synced";
}

/**
 * A revoked device keeps the fact locally so the UI can say what happened.
 *
 * Clearing the credentials on its own is what made revocation look like a bug: the
 * employee was dropped onto the sign-in screen with nothing to explain it.
 */
async function revoke(): Promise<void> {
  await markRevoked();
  await clearDeviceCredentials();
}

/** How many observed events are waiting to be accepted — surfaced on the status screen. */
export async function pendingEventCount(): Promise<number> {
  return pendingCount(await loadPending());
}

/**
 * Sends everything the journal holds, and clears it only on confirmation.
 *
 * Ordering matters: the events are already on disk by the time this runs, so a crash
 * mid-request loses nothing, and a duplicate send is rejected server-side by
 * `clientEventId`.
 */
async function flushPending(deviceId: string, workSessionId: number | null): Promise<void> {
  const pending = await loadPending();
  if (pendingCount(pending) === 0) return;

  await client.ingestActivity({
    deviceId,
    workSessionId,
    activity: pending.activity,
    breaks: pending.breaks,
    locations: pending.locations,
  });

  await clearPending();
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
async function collectActivity(deviceId: string): Promise<void> {
  const startMs = await loadLastActivitySyncMs();
  const endMs = Date.now();
  if (endMs <= startMs) return;

  const { sessions, openSessionStartMs } = await AemsUsage.queryUsage(startMs, endMs);

  if (sessions.length > 0) {
    const activity: ActivityEventInput[] = sessions.map((session) => ({
      // Derived from the session's own identity, so re-reading a window after a crash
      // produces the id already stored rather than a second copy of the same session.
      clientEventId: uuidFrom(`${deviceId}:${session.packageName}:${session.startedAtMs}`),
      appName: session.appLabel,
      startedAt: new Date(session.startedAtMs).toISOString(),
      endedAt: new Date(session.endedAtMs).toISOString(),
    }));

    await enqueue({ activity });

    // Inventory is a snapshot of what is installed, not an observation that can be
    // lost — it is re-sent in full every cycle, so it does not belong in the queue.
    // Deduplicated by package: an app opened six times is six sessions but one entry.
    const applications: InstalledApplication[] = [
      ...new Map(
        sessions.map((session) => [
          session.packageName,
          { name: session.appLabel, identifier: session.packageName },
        ]),
      ).values(),
    ];
    await attempt(() => client.reportApplications({ applications }));
  }

  // Rewind to a session still running rather than advancing past it. The watermark is
  // "everything before here has been accounted for", and an app the employee still has
  // open has not been: it is reported when it closes, as one session with its true
  // start. Advancing to `endMs` would cut it at the sync boundary and count a single
  // opening once per cycle it survived.
  //
  // Advancing as soon as the events are journalled is safe, and is the point of having
  // a journal: durability used to depend on leaving this window in place, which covered
  // a failed request and nothing else — not a crash, and not a break event, which
  // `UsageStatsManager` cannot be re-asked for.
  await SecureStore.setItemAsync(LAST_ACTIVITY_SYNC_KEY, String(openSessionStartMs ?? endMs));
}

/**
 * One position fix per cycle, journalled like everything else.
 *
 * It goes through the queue rather than straight to the API so an offline phone — the
 * exact case §3 describes, a field employee out of coverage — still has its trail when
 * it reconnects, instead of a gap for precisely the period the feature exists to cover.
 */
async function collectLocation(deviceId: string): Promise<void> {
  const point = await samplePoint(deviceId);
  if (point === null) return;

  await enqueue({ locations: [point] });
}

async function loadLastActivitySyncMs(): Promise<number> {
  const floor = Date.now() - MAX_LOOKBACK_MS;

  const stored = await SecureStore.getItemAsync(LAST_ACTIVITY_SYNC_KEY);
  if (stored !== null) {
    const parsed = Number(stored);
    // Clamped because the watermark deliberately rewinds to an open session, and an app
    // left in the foreground for days (a kiosk, a stuck launcher, a phone that never
    // sleeps) would otherwise pin it there and grow the query without bound. Android
    // keeps roughly a week of events, so a window older than this cannot be answered
    // in full anyway.
    if (Number.isFinite(parsed)) return Math.max(parsed, floor);
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
