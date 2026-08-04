import { powerMonitor } from "electron";
import activeWindow from "active-win";
import screenshot from "screenshot-desktop";
import { randomUUID } from "node:crypto";
import { store } from "./config.js";
import { apiClient } from "./api-client.js";

const POLL_INTERVAL_MS = 5_000;

let currentApp: string | null = null;
let currentEventStartedAt: string | null = null;
let isIdle = false;
let idleStartedAt: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let screenshotTimer: ReturnType<typeof setInterval> | null = null;

/** Application-focus polling + idle detection + periodic screenshots. */
export function startTracking() {
  pollTimer = setInterval(pollActiveWindow, POLL_INTERVAL_MS);

  const screenshotIntervalMs = store.get("screenshotIntervalSeconds") * 1000;
  screenshotTimer = setInterval(captureScreenshot, screenshotIntervalMs);
}

export function stopTracking() {
  if (pollTimer) clearInterval(pollTimer);
  if (screenshotTimer) clearInterval(screenshotTimer);
}

async function pollActiveWindow() {
  const deviceId = store.get("deviceId");
  const userId = store.get("userId");
  if (!deviceId || !userId) return;

  const idleThreshold = store.get("idleThresholdSeconds");
  const idleSeconds = powerMonitor.getSystemIdleTime();

  if (idleSeconds >= idleThreshold && !isIdle) {
    isIdle = true;
    idleStartedAt = new Date(Date.now() - idleSeconds * 1000).toISOString();
  } else if (idleSeconds < idleThreshold && isIdle) {
    isIdle = false;
    if (idleStartedAt) {
      await apiClient.logIdleEvent({
        userId,
        deviceId,
        idleStartAt: idleStartedAt,
        idleEndAt: new Date().toISOString(),
        durationSeconds: Math.round((Date.now() - new Date(idleStartedAt).getTime()) / 1000),
      });
    }
    idleStartedAt = null;
  }

  if (isIdle) return;

  const win = await activeWindow();
  const appName = win?.owner.name ?? "unknown";

  if (appName !== currentApp) {
    if (currentApp && currentEventStartedAt) {
      await apiClient.logActivityEvent({
        userId,
        deviceId,
        appName: currentApp,
        startedAt: currentEventStartedAt,
        endedAt: new Date().toISOString(),
      });
    }
    currentApp = appName;
    currentEventStartedAt = new Date().toISOString();
  }
}

async function captureScreenshot() {
  const deviceId = store.get("deviceId");
  const userId = store.get("userId");
  if (!deviceId || !userId || isIdle) return;

  // In production, request a signed upload URL from the API and PUT the
  // buffer directly to object storage; storageKey below stands in for that.
  await screenshot();
  const storageKey = `screenshots/${deviceId}/${randomUUID()}.jpg`;

  await apiClient.logScreenshot({ userId, deviceId, storageKey });
}
