package com.primexmeta.aems.usage

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * Foreground service that keeps monitoring alive.
 *
 * Its notification is not incidental — it is the visible indicator the compliance
 * rules require, and Android's own foreground-service contract makes it
 * undismissable. Monitoring on this device is therefore never silent, which is the
 * point: a foreground service that could hide its notification would be spyware.
 */
class MonitoringService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startForeground(NOTIFICATION_ID, buildNotification())
    // Restart if Android kills us for memory, so tracking survives pressure.
    return START_STICKY
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

  private companion object {
    const val CHANNEL_ID = "aems_monitoring"
    const val NOTIFICATION_ID = 4711
  }
}
