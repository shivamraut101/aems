package com.primexmeta.aems.usage

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Brings monitoring back after the phone restarts.
 *
 * Without this the agent stops at the first reboot and stays stopped until somebody
 * opens the app — which on a company phone can be days. The `RECEIVE_BOOT_COMPLETED`
 * permission was already declared for this; only the receiver was missing, so the
 * permission had been doing nothing at all.
 *
 * It restarts monitoring only when `MonitoringState` says it was running when the
 * device went down. A reboot is not consent, and this deliberately cannot grant
 * itself any: the flag is written by the app when collection legitimately starts, and
 * cleared when it stops, so a device that was revoked or de-consented before the
 * reboot comes back up quiet.
 *
 * `ACTION_MY_PACKAGE_REPLACED` is handled alongside boot because an app update stops
 * the service the same way a reboot does, and leaves the same silent gap.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action
    if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
      return
    }

    if (!MonitoringState.isActive(context)) return

    val serviceIntent = Intent(context, MonitoringService::class.java)
    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(serviceIntent)
      } else {
        context.startService(serviceIntent)
      }
    }
    // Swallowed on purpose. Android can refuse a background service start on some
    // OEM builds, and there is no user to tell at boot — the app starts monitoring
    // itself the next time it is opened, so a failure here degrades rather than breaks.
  }
}
