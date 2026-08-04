package com.aems.agent

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.aems.agent.api.ActivityEventRequest
import com.aems.agent.api.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

private const val CHANNEL_ID = "aems_monitoring"
private const val NOTIFICATION_ID = 1
private const val POLL_INTERVAL_MS = 60_000L

/**
 * Foreground service (required to poll UsageStatsManager reliably in the background).
 * The persistent notification doubles as the on-device compliance indicator that
 * monitoring is active, matching the desktop agent's tray icon.
 */
class MonitoringService : Service() {
    private val scope = CoroutineScope(Job())
    private var lastEventEndTime = System.currentTimeMillis()

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildNotification())
        scope.launch { pollLoop() }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun pollLoop() {
        val deviceId = deviceId() ?: return
        val userId = userId() ?: return
        val usageStatsManager = getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager

        while (true) {
            val now = System.currentTimeMillis()
            reportForegroundEvents(usageStatsManager, lastEventEndTime, now, userId, deviceId)
            lastEventEndTime = now
            delay(POLL_INTERVAL_MS)
        }
    }

    private suspend fun reportForegroundEvents(
        manager: UsageStatsManager,
        from: Long,
        to: Long,
        userId: String,
        deviceId: String,
    ) {
        val events = manager.queryEvents(from, to)
        val usageEvent = UsageEvents.Event()
        var lastPackage: String? = null
        var lastStartedAt: Long? = null

        while (events.hasNextEvent()) {
            events.getNextEvent(usageEvent)
            if (usageEvent.eventType != UsageEvents.Event.ACTIVITY_RESUMED &&
                usageEvent.eventType != UsageEvents.Event.ACTIVITY_PAUSED
            ) {
                continue
            }

            if (usageEvent.eventType == UsageEvents.Event.ACTIVITY_RESUMED) {
                lastPackage = usageEvent.packageName
                lastStartedAt = usageEvent.timeStamp
            } else if (usageEvent.eventType == UsageEvents.Event.ACTIVITY_PAUSED && lastPackage == usageEvent.packageName) {
                ApiClient.aems.logActivityEvent(
                    ActivityEventRequest(
                        userId = userId,
                        deviceId = deviceId,
                        appName = lastPackage ?: usageEvent.packageName,
                        startedAt = isoTimestamp(lastStartedAt ?: usageEvent.timeStamp),
                        endedAt = isoTimestamp(usageEvent.timeStamp),
                    ),
                )
                lastPackage = null
                lastStartedAt = null
            }
        }
    }

    private fun isoTimestamp(epochMillis: Long): String {
        val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        formatter.timeZone = TimeZone.getTimeZone("UTC")
        return formatter.format(Date(epochMillis))
    }

    private fun deviceId(): String? = getSharedPreferences("aems_device", MODE_PRIVATE).getString("device_id", null)

    private fun userId(): String? = getSharedPreferences("aems_device", MODE_PRIVATE).getString("user_id", null)

    private fun buildNotification(): android.app.Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "AEMS Monitoring", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.monitoring_notification_title))
            .setContentText(getString(R.string.monitoring_notification_text))
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setOngoing(true)
            .build()
    }

    companion object {
        fun start(context: Context) {
            context.startForegroundService(Intent(context, MonitoringService::class.java))
        }
    }
}
