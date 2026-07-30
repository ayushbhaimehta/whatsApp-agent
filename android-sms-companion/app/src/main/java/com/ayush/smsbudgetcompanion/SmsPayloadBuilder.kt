package com.ayush.smsbudgetcompanion

import org.json.JSONArray
import org.json.JSONObject

object SmsPayloadBuilder {
    fun build(
        installId: String,
        sentAtMillis: Long,
        messages: List<TransactionSms>,
        scan: SmsScanMetadata,
    ): String {
        require(installId.isNotBlank()) { "installId is required" }
        require(messages.size <= MAX_MESSAGE_BATCH_SIZE) {
            "A payload can contain at most $MAX_MESSAGE_BATCH_SIZE messages"
        }
        require(scan.id.matches(Regex("^[A-Za-z0-9_-]{12,128}$"))) {
            "scan.id is invalid"
        }
        require(scan.monthKey.matches(Regex("^\\d{4}-\\d{2}$"))) {
            "scan.monthKey must use YYYY-MM"
        }
        require(scan.from >= 0L && scan.through >= scan.from) { "scan window is invalid" }
        require(scan.inboxMessageCount >= 0) { "scan.inboxMessageCount is invalid" }
        require(
            scan.transactionCandidateCount in 0..scan.inboxMessageCount,
        ) { "scan.transactionCandidateCount is invalid" }
        require(messages.size <= scan.transactionCandidateCount) {
            "Payload messages exceed the scan candidate count"
        }
        require(!scan.complete || messages.isEmpty()) {
            "A complete scan checkpoint must have an empty messages array"
        }

        val messageArray = JSONArray()
        messages.forEach { message ->
            messageArray.put(
                JSONObject()
                    .put("id", message.id)
                    .put("sender", message.sender)
                    .put("occurredAt", message.receivedAtMillis)
                    .put("body", message.body),
            )
        }
        val scanObject = JSONObject()
            .put("id", scan.id)
            .put("monthKey", scan.monthKey)
            .put("from", scan.from)
            .put("through", scan.through)
            .put("inboxMessageCount", scan.inboxMessageCount)
            .put("transactionCandidateCount", scan.transactionCandidateCount)
            .put("complete", scan.complete)
        return JSONObject()
            .put("schemaVersion", 2)
            .put("source", "android-sms")
            .put("deviceId", installId)
            .put("sentAt", sentAtMillis)
            .put("messages", messageArray)
            .put("scan", scanObject)
            .toString()
    }

    const val MAX_MESSAGE_BATCH_SIZE = 100
}
