package com.ayush.smsbudgetcompanion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/**
 * Never uploads broadcast extras. It only asks WorkManager to query the inbox and run the local
 * filter, which keeps the same privacy boundary for live and periodic scans.
 */
class IncomingSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        if (!SecureConfigStore(context).hasConsent()) return
        SmsSyncScheduler.enqueueImmediate(context)
    }
}
