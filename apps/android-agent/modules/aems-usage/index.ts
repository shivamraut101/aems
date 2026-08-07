import { requireNativeModule } from "expo-modules-core";

/**
 * Bridge to the Kotlin usage-tracking module.
 *
 * App usage on Android comes from UsageStatsManager, which has no JavaScript
 * equivalent — it requires a special permission the user grants in system settings
 * and can only be read from native code. Everything that touches an Android API
 * lives on the Kotlin side; this file is only the type boundary.
 */

/**
 * One stretch an app actually spent in the foreground, from Android's own event
 * stream — the unit both "how long" and "how many times" are derived from.
 */
export interface AppSession {
  packageName: string;
  appLabel: string;
  startedAtMs: number;
  endedAtMs: number;
}

export interface UsageWindow {
  /** Completed sessions only, in the order Android recorded them. */
  sessions: AppSession[];
  /**
   * When an app was still in the foreground as the window closed, the moment it was
   * opened — otherwise `null`.
   *
   * The caller is meant to rewind its watermark to this rather than to the window end,
   * so the session is read again next cycle and reported once, complete. Cutting it at
   * the boundary instead would report one opening as two.
   */
  openSessionStartMs: number | null;
}

export interface DeviceSnapshot {
  model: string;
  manufacturer: string;
  androidVersion: string;
  totalRamMb: number;
  totalStorageMb: number;
  freeStorageMb: number;
  screenActiveSeconds: number;
}

interface AemsUsageModuleType {
  /** True when the user has granted PACKAGE_USAGE_STATS in system settings. */
  hasUsageAccess(): boolean;
  /** Opens the system settings page where usage access is granted. */
  requestUsageAccess(): void;
  queryUsage(startMs: number, endMs: number): Promise<UsageWindow>;
  getDeviceSnapshot(): Promise<DeviceSnapshot>;
  /** Starts the foreground service; its notification is the visible indicator. */
  startMonitoring(): void;
  stopMonitoring(): void;
}

export default requireNativeModule<AemsUsageModuleType>("AemsUsage");
