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
import android.app.usage.UsageEvents
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

    /**
     * Real foreground sessions in a window — one entry per time the app was actually
     * open, with the timestamps Android recorded for it.
     *
     * This reads the *event stream* (`queryEvents`) rather than the aggregate
     * (`queryUsageStats`), which is how Digital Wellbeing arrives at its own numbers,
     * and it is not a refinement — the aggregate cannot answer the question asked here.
     * `queryUsageStats(INTERVAL_BEST, ...)` returns pre-rolled buckets that overlap the
     * requested range, so a 60-second sync window is answered with each app's total for
     * the whole *day*. Reporting that every cycle restated the day's total as if it were
     * a fresh minute of use, and a phone that had spent one hour in Chrome would have
     * sent that hour again on every sync until it read as hundreds.
     *
     * Aggregates also cannot say how many *times* an app was opened, because they have
     * already thrown the boundaries away. Walking RESUMED → PAUSED keeps them, so one
     * session is one row downstream and counting rows counts openings.
     *
     * Only *completed* sessions are returned. An app still in the foreground when the
     * window closes is reported through `openSessionStartMs` instead, so the caller can
     * rewind to it and emit that session once, whole, when it actually ends — rather
     * than cutting it at an arbitrary sync boundary and counting one opening twice.
     */
    AsyncFunction("queryUsage") { startMs: Long, endMs: Long ->
      val manager = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
      val packageManager = context.packageManager

      val labels = HashMap<String, String>()
      fun labelOf(packageName: String): String = labels.getOrPut(packageName) {
        runCatching {
          packageManager
            .getApplicationLabel(packageManager.getApplicationInfo(packageName, 0))
            .toString()
        }.getOrDefault(packageName)
      }

      // Insertion-ordered so the earliest still-open resume is found by scanning values.
      val openAt = LinkedHashMap<String, Long>()
      val sessions = mutableListOf<Map<String, Any>>()

      val events = manager.queryEvents(startMs, endMs)
      val event = UsageEvents.Event()

      while (events.hasNextEvent()) {
        events.getNextEvent(event)
        val packageName = event.packageName ?: continue

        when (event.eventType) {
          // ACTIVITY_RESUMED/ACTIVITY_PAUSED are the API 29 names for the constants
          // MOVE_TO_FOREGROUND/MOVE_TO_BACKGROUND carried since API 1 — same values,
          // and Kotlin inlines them, so referencing them is safe down to minSdk 24.
          UsageEvents.Event.ACTIVITY_RESUMED -> {
            // An app already counted as open must not restart its own session: several
            // activities inside one app each emit RESUMED, and treating the second as a
            // new opening would both split the session and inflate the count.
            if (!openAt.containsKey(packageName)) openAt[packageName] = event.timeStamp
          }

          // STOPPED usually follows PAUSED for the same activity; whichever lands first
          // closes the session and `remove` makes the other a no-op.
          UsageEvents.Event.ACTIVITY_PAUSED, UsageEvents.Event.ACTIVITY_STOPPED -> {
            val startedAt = openAt.remove(packageName) ?: continue
            if (event.timeStamp <= startedAt) continue

            sessions.add(
              mapOf(
                "packageName" to packageName,
                "appLabel" to labelOf(packageName),
                "startedAtMs" to startedAt,
                "endedAtMs" to event.timeStamp,
              ),
            )
          }
        }
      }

      mapOf<String, Any?>(
        "sessions" to sessions,
        "openSessionStartMs" to openAt.values.minOrNull(),
      )
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
      // Recorded before the start, so a crash between the two lines errs towards the
      // agent coming back after a reboot rather than staying silently off.
      MonitoringState.setActive(context, true)

      val intent = Intent(context, MonitoringService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    Function("stopMonitoring") {
      MonitoringState.setActive(context, false)
      context.stopService(Intent(context, MonitoringService::class.java))
    }
  }
}
