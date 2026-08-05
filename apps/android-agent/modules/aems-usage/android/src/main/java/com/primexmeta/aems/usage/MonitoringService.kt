package com.primexmeta.aems.usage

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import java.util.concurrent.TimeUnit

/**
 * Foreground service that keeps monitoring alive.
 *
 * Its notification is not incidental — it is the visible indicator the compliance
 * rules require, and Android's own foreground-service contract makes it
 * undismissable. Monitoring on this device is therefore never silent, which is the
 * point: a foreground service that could hide its notification would be spyware.
 *
 * It also owns screen-active-time tracking. A `BroadcastReceiver` for
 * `ACTION_SCREEN_ON`/`ACTION_SCREEN_OFF` only fires while something is listening for
 * it, and this service is the one thing guaranteed to be running whenever monitoring
 * is active — so the accumulator lives here rather than in a component the OS is
 * free to tear down.
 */
class MonitoringService : Service() {
  private val screenReceiver = ScreenStateReceiver()

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startForeground(NOTIFICATION_ID, buildNotification())

    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_ON)
      addAction(Intent.ACTION_SCREEN_OFF)
    }
    registerReceiver(screenReceiver, filter)

    // The screen may already be on when the service starts — without this, the
    // current on-screen stretch is invisible until the next SCREEN_ON broadcast.
    val powerManager = getSystemService(POWER_SERVICE) as android.os.PowerManager
    if (powerManager.isInteractive) {
      ScreenTimeTracker.markScreenOn(this)
    }

    // Restart if Android kills us for memory, so tracking survives pressure.
    return START_STICKY
  }

  override fun onDestroy() {
    // A screen-on stretch in progress must be flushed, or the service dying mid-shift
    // silently drops however long the screen had already been on.
    ScreenTimeTracker.markScreenOff(this)
    runCatching { unregisterReceiver(screenReceiver) }
    super.onDestroy()
  }

  private fun buildNotification(): Notification {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Work monitoring",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Shown whenever work activity is being recorded on this device."
        setShowBadge(false)
      }

      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }

    return builder
      .setContentTitle("Work monitoring active")
      .setContentText("Your employer is recording app usage on this company device.")
      .setSmallIcon(android.R.drawable.ic_menu_info_details)
      .setOngoing(true)
      .build()
  }

  private class ScreenStateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      when (intent.action) {
        Intent.ACTION_SCREEN_ON -> ScreenTimeTracker.markScreenOn(context)
        Intent.ACTION_SCREEN_OFF -> ScreenTimeTracker.markScreenOff(context)
      }
    }
  }

  private companion object {
    const val CHANNEL_ID = "aems_monitoring"
    const val NOTIFICATION_ID = 4711
  }
}

/**
 * Accumulates today's screen-on seconds in `SharedPreferences`, so the count survives
 * the service being killed and restarted by the OS.
 *
 * "Today" resets on the first read or screen-state change after local midnight. A
 * screen-on stretch that itself spans midnight is credited to the day it ended on
 * rather than split across the boundary — telemetry, not a timesheet, and the same
 * best-effort spirit as the app-usage-to-activity-event mapping elsewhere in this
 * agent.
 */
object ScreenTimeTracker {
  private const val PREFS_NAME = "aems_screen_time"
  private const val KEY_ACCUMULATED_SECONDS = "accumulated_seconds"
  private const val KEY_DAY_EPOCH = "day_epoch"
  private const val KEY_SCREEN_ON_SINCE_ELAPSED = "screen_on_since_elapsed"

  fun markScreenOn(context: Context) {
    val prefs = prefs(context)
    resetIfNewDay(prefs)
    prefs.edit().putLong(KEY_SCREEN_ON_SINCE_ELAPSED, SystemClock.elapsedRealtime()).apply()
  }

  fun markScreenOff(context: Context) {
    val prefs = prefs(context)
    resetIfNewDay(prefs)
    val since = prefs.getLong(KEY_SCREEN_ON_SINCE_ELAPSED, 0L)
    if (since > 0L) {
      val elapsedSeconds = TimeUnit.MILLISECONDS.toSeconds(SystemClock.elapsedRealtime() - since)
      val total = prefs.getLong(KEY_ACCUMULATED_SECONDS, 0L) + elapsedSeconds
      prefs.edit()
        .putLong(KEY_ACCUMULATED_SECONDS, total)
        .putLong(KEY_SCREEN_ON_SINCE_ELAPSED, 0L)
        .apply()
    }
  }

  /** Today's screen-on seconds so far, including the in-progress stretch if the screen is on now. */
  fun getTodaySeconds(context: Context): Long {
    val prefs = prefs(context)
    resetIfNewDay(prefs)
    val stored = prefs.getLong(KEY_ACCUMULATED_SECONDS, 0L)
    val since = prefs.getLong(KEY_SCREEN_ON_SINCE_ELAPSED, 0L)
    val inProgress = if (since > 0L) {
      TimeUnit.MILLISECONDS.toSeconds(SystemClock.elapsedRealtime() - since)
    } else {
      0L
    }
    return stored + inProgress
  }

  private fun resetIfNewDay(prefs: android.content.SharedPreferences) {
    val today = TimeUnit.MILLISECONDS.toDays(System.currentTimeMillis())
    val storedDay = prefs.getLong(KEY_DAY_EPOCH, today)
    if (storedDay != today) {
      prefs.edit()
        .putLong(KEY_ACCUMULATED_SECONDS, 0L)
        .putLong(KEY_DAY_EPOCH, today)
        .apply()
    } else if (!prefs.contains(KEY_DAY_EPOCH)) {
      prefs.edit().putLong(KEY_DAY_EPOCH, today).apply()
    }
  }

  private fun prefs(context: Context) =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
}
