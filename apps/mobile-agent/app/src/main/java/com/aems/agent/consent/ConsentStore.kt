package com.aems.agent.consent

import android.content.Context

/** Local record of whether this device's user has accepted the monitoring notice. */
class ConsentStore(context: Context) {
    private val prefs = context.getSharedPreferences("aems_consent", Context.MODE_PRIVATE)

    fun hasConsented(): Boolean = prefs.contains(KEY_CONSENTED_AT)

    fun recordConsent() {
        prefs.edit().putLong(KEY_CONSENTED_AT, System.currentTimeMillis()).apply()
    }

    companion object {
        private const val KEY_CONSENTED_AT = "consented_at"
    }
}
