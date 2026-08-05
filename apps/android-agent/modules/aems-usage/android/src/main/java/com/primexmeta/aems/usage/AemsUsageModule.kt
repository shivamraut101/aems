package com.primexmeta.aems.usage

import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.os.Process
import android.os.StatFs
import android.provider.Settings
import android.app.ActivityManager
import android.app.usage.UsageStatsManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * App usage, device inventory and the monitoring foreground service.
 *
 * UsageStatsManager is the only supported way to read per-app foreground time on
 * Android, and it is gated behind PACKAGE_USAGE_STATS — a permission the user must
 * grant by hand in system settings. There is no way to obtain it silently, which is
 * the behaviour we want: monitoring on a company phone should still be something the
 * employee actively enabled.
 */
class AemsUsageModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context unavailable" }

  override fun definition() = ModuleDefinition {
    Name("AemsUsage")

    Function("hasUsageAccess") {
      val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
      val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        appOps.unsafeCheckOpNoThrow(
          AppOpsManager.OPSTR_GET_USAGE_STATS,
          Process.myUid(),
          context.packageName,
        )
      } else {
        @Suppress("DEPRECATION")
        appOps.checkOpNoThrow(
          AppOpsManager.OPSTR_GET_USAGE_STATS,
          Process.myUid(),
          context.packageName,
        )
      }
      mode == AppOpsManager.MODE_ALLOWED
    }

    Function("requestUsageAccess") {
      val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    AsyncFunction("queryUsage") { startMs: Long, endMs: Long ->
      val manager = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
      val packageManager = context.packageManager

      manager
        .queryUsageStats(UsageStatsManager.INTERVAL_BEST, startMs, endMs)
        // Apps the user never opened still appear with zero foreground time; they
        // are noise, not evidence of activity.
        .filter { it.totalTimeInForeground > 0 }
        .map { stat ->
          val label = runCatching {
            packageManager
              .getApplicationLabel(packageManager.getApplicationInfo(stat.packageName, 0))
              .toString()
          }.getOrDefault(stat.packageName)

          mapOf(
            "packageName" to stat.packageName,
            "appLabel" to label,
            "totalTimeForegroundMs" to stat.totalTimeInForeground,
            "firstTimeStamp" to stat.firstTimeStamp,
            "lastTimeStamp" to stat.lastTimeStamp,
          )
        }
    }

    AsyncFunction("getDeviceSnapshot") {
      val activityManager =
        context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val memory = ActivityManager.MemoryInfo().also(activityManager::getMemoryInfo)
      val stat = StatFs(Environment.getDataDirectory().path)

      mapOf(
        "model" to Build.MODEL,
        "manufacturer" to Build.MANUFACTURER,
        "androidVersion" to Build.VERSION.RELEASE,
        "totalRamMb" to memory.totalMem / 1024 / 1024,
        "totalStorageMb" to stat.totalBytes / 1024 / 1024,
        "freeStorageMb" to stat.availableBytes / 1024 / 1024,
        "screenActiveSeconds" to ScreenTimeTracker.getTodaySeconds(context),
      )
    }

    Function("startMonitoring") {
      val intent = Intent(context, MonitoringService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    Function("stopMonitoring") {
      context.stopService(Intent(context, MonitoringService::class.java))
    }
  }
}
