package com.aems.agent

import android.app.AppOpsManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import com.aems.agent.consent.ConsentStore

/**
 * Consent gate: monitoring must not start until the employee explicitly accepts,
 * and the device must grant Usage Access before app-tracking events can be read.
 */
class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (ConsentStore(this).hasConsented() && hasUsageAccess()) {
            startMonitoringService()
            finish()
            return
        }

        setContentView(buildConsentView())
    }

    private fun buildConsentView(): LinearLayout {
        val padding = (24 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
        }

        layout.addView(TextView(this).apply { text = getString(R.string.consent_title); textSize = 20f })
        layout.addView(TextView(this).apply { text = getString(R.string.consent_body); textSize = 14f })

        layout.addView(
            Button(this).apply {
                text = getString(R.string.consent_accept)
                setOnClickListener { onConsentAccepted() }
            },
        )

        return layout
    }

    private fun onConsentAccepted() {
        ConsentStore(this).recordConsent()
        if (!hasUsageAccess()) {
            startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
            return
        }
        startMonitoringService()
        finish()
    }

    private fun hasUsageAccess(): Boolean {
        val appOps = getSystemService(APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), packageName)
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), packageName)
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    private fun startMonitoringService() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ActivityCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        MonitoringService.start(this)
    }
}
