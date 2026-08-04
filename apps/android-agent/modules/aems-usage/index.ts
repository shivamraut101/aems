import { requireNativeModule } from "expo-modules-core";

/**
 * Bridge to the Kotlin usage-tracking module.
 *
 * App usage on Android comes from UsageStatsManager, which has no JavaScript
 * equivalent — it requires a special permission the user grants in system settings
 * and can only be read from native code. Everything that touches an Android API
 * lives on the Kotlin side; this file is only the type boundary.
 */

export interface AppUsageRecord {
  packageName: string;
  appLabel: string;
  totalTimeForegroundMs: number;
  firstTimeStamp: number;
  lastTimeStamp: number;
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
  queryUsage(startMs: number, endMs: number): Promise<AppUsageRecord[]>;
  getDeviceSnapshot(): Promise<DeviceSnapshot>;
  /** Starts the foreground service; its notification is the visible indicator. */
  startMonitoring(): void;
  stopMonitoring(): void;
}

export default requireNativeModule<AemsUsageModuleType>("AemsUsage");
