package com.ayush.smsbudgetcompanion

import java.time.Instant
import java.time.ZoneId
import java.time.YearMonth

data class SmsRecord(
    val localId: Long,
    val sender: String,
    val receivedAtMillis: Long,
    val body: String,
)

data class TransactionSms(
    val id: String,
    val sender: String,
    val receivedAtMillis: Long,
    val body: String,
)

data class SmsScanWindow(
    val monthKey: String,
    val from: Long,
    val through: Long,
)

data class SmsScanMetadata(
    val id: String,
    val monthKey: String,
    val from: Long,
    val through: Long,
    val inboxMessageCount: Int,
    val transactionCandidateCount: Int,
    val complete: Boolean,
)

object SmsScanWindowFactory {
    private val INDIA_TIME_ZONE = ZoneId.of("Asia/Kolkata")

    /** Returns the complete current-month window in IST up to [throughMillis]. */
    fun currentIstMonth(throughMillis: Long): SmsScanWindow {
        require(throughMillis >= 0L) { "throughMillis must not be negative" }
        val throughInIndia = Instant.ofEpochMilli(throughMillis).atZone(INDIA_TIME_ZONE)
        val month = YearMonth.from(throughInIndia)
        val monthStart = month.atDay(1)
            .atStartOfDay(INDIA_TIME_ZONE)
            .toInstant()
            .toEpochMilli()
        return SmsScanWindow(
            monthKey = month.toString(),
            from = monthStart,
            through = throughMillis,
        )
    }
}
