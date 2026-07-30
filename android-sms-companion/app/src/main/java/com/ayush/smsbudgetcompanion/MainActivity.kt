package com.ayush.smsbudgetcompanion

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.checkbox.MaterialCheckBox
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class MainActivity : AppCompatActivity() {
    private lateinit var configStore: SecureConfigStore
    private lateinit var endpointInput: TextInputEditText
    private lateinit var endpointLayout: TextInputLayout
    private lateinit var secretInput: TextInputEditText
    private lateinit var secretLayout: TextInputLayout
    private lateinit var statusText: TextView
    private lateinit var consentCheckbox: MaterialCheckBox

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        refreshStatus()
        if (hasSmsPermissions()) {
            SmsSyncScheduler.enqueueImmediate(this)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        configStore = SecureConfigStore(this)
        endpointInput = findViewById(R.id.endpointInput)
        endpointLayout = findViewById(R.id.endpointLayout)
        secretInput = findViewById(R.id.secretInput)
        secretLayout = findViewById(R.id.secretLayout)
        statusText = findViewById(R.id.statusText)
        consentCheckbox = findViewById(R.id.consentCheckbox)

        endpointInput.setText(configStore.getEndpoint().orEmpty())
        consentCheckbox.isChecked = configStore.hasConsent()
        consentCheckbox.setOnCheckedChangeListener { _, checked ->
            configStore.setConsent(checked)
            if (checked) {
                SmsSyncScheduler.ensurePeriodic(this)
            } else {
                SmsSyncScheduler.cancelAll(this)
            }
            refreshStatus()
        }

        findViewById<MaterialButton>(R.id.saveButton).setOnClickListener {
            saveConfiguration()
        }
        findViewById<MaterialButton>(R.id.permissionButton).setOnClickListener {
            if (!consentCheckbox.isChecked) {
                statusText.text = "Read and accept the disclosure before granting SMS access."
                return@setOnClickListener
            }
            permissionLauncher.launch(SMS_PERMISSIONS)
        }
        findViewById<MaterialButton>(R.id.syncButton).setOnClickListener {
            if (!hasSmsPermissions()) {
                statusText.text = "Grant SMS access before syncing."
                return@setOnClickListener
            }
            if (!configStore.hasConsent()) {
                statusText.text = "Consent is required before scanning SMS."
                return@setOnClickListener
            }
            if (!configStore.isConfigured()) {
                statusText.text = "Save an HTTPS endpoint and shared secret before syncing."
                return@setOnClickListener
            }
            SmsSyncScheduler.enqueueImmediate(this)
            statusText.text = "Current-month SMS scan queued."
        }

        if (configStore.hasConsent()) SmsSyncScheduler.ensurePeriodic(this)
        refreshStatus()
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun saveConfiguration() {
        endpointLayout.error = null
        secretLayout.error = null

        val endpoint = endpointInput.text?.toString()?.trim().orEmpty()
        val newSecret = secretInput.text?.toString().orEmpty()
        val endpointError = SecureConfigStore.validateEndpoint(endpoint)
        if (endpointError != null) {
            endpointLayout.error = endpointError
            return
        }
        if (newSecret.isBlank() && !configStore.hasSharedSecret()) {
            secretLayout.error = "A shared secret is required."
            return
        }
        if (newSecret.isNotBlank() && newSecret.length < MIN_SECRET_LENGTH) {
            secretLayout.error = "Use at least $MIN_SECRET_LENGTH characters."
            return
        }

        val endpointChanged = endpoint != configStore.getEndpoint()
        val secretChanged = newSecret.isNotBlank()
        configStore.setEndpoint(endpoint)
        if (newSecret.isNotBlank()) {
            configStore.setSharedSecret(newSecret)
            secretInput.text?.clear()
        }
        if (endpointChanged || secretChanged) {
            configStore.setLastSuccessfulSyncMillis(0L)
        }
        if (configStore.hasConsent()) SmsSyncScheduler.ensurePeriodic(this)
        if (configStore.hasConsent() && hasSmsPermissions()) {
            SmsSyncScheduler.enqueueImmediate(this)
        }
        refreshStatus("Configuration encrypted and saved.")
    }

    private fun refreshStatus(prefix: String? = null) {
        if (!::configStore.isInitialized) return
        val configured = if (configStore.isConfigured()) "configured" else "not configured"
        val permission = if (hasSmsPermissions()) "granted" else "not granted"
        val consent = if (configStore.hasConsent()) "accepted" else "not accepted"
        val lastSync = configStore.getLastSuccessfulSyncMillis().takeIf { it > 0 }?.let {
            DateTimeFormatter.ofPattern("dd MMM yyyy, h:mm a")
                .withZone(ZoneId.systemDefault())
                .format(Instant.ofEpochMilli(it))
        } ?: "never"
        val details = "Consent: $consent\nEndpoint: $configured\nSMS access: $permission\nLast completed full scan: $lastSync"
        statusText.text = listOfNotNull(prefix, details).joinToString("\n\n")
    }

    private fun hasSmsPermissions(): Boolean = SMS_PERMISSIONS.all {
        ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }

    companion object {
        private const val MIN_SECRET_LENGTH = 32
        private val SMS_PERMISSIONS = arrayOf(
            Manifest.permission.READ_SMS,
            Manifest.permission.RECEIVE_SMS,
        )
    }
}
