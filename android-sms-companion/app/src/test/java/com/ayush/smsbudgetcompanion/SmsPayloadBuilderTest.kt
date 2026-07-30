package com.ayush.smsbudgetcompanion

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class SmsPayloadBuilderTest {
    @Test
    fun `builds schema version 2 candidate batch with complete scan metadata`() {
        val scan = sampleScan(complete = false)
        val payload = JSONObject(
            SmsPayloadBuilder.build(
                installId = "device-install-id",
                sentAtMillis = 1_722_000_000_000L,
                messages = listOf(sampleMessage()),
                scan = scan,
            ),
        )

        assertEquals(2, payload.getInt("schemaVersion"))
        assertEquals("android-sms", payload.getString("source"))
        assertEquals("device-install-id", payload.getString("deviceId"))
        assertEquals(1_722_000_000_000L, payload.getLong("sentAt"))

        val messages = payload.getJSONArray("messages")
        assertEquals(1, messages.length())
        assertEquals("message-id", messages.getJSONObject(0).getString("id"))

        val scanJson = payload.getJSONObject("scan")
        assertEquals(scan.id, scanJson.getString("id"))
        assertEquals("2026-07", scanJson.getString("monthKey"))
        assertEquals(scan.from, scanJson.getLong("from"))
        assertEquals(scan.through, scanJson.getLong("through"))
        assertEquals(25, scanJson.getInt("inboxMessageCount"))
        assertEquals(3, scanJson.getInt("transactionCandidateCount"))
        assertFalse(scanJson.getBoolean("complete"))
    }

    @Test
    fun `builds an empty completion checkpoint even when scan found no candidates`() {
        val scan = sampleScan(
            complete = true,
            inboxMessageCount = 17,
            transactionCandidateCount = 0,
        )
        val payload = JSONObject(
            SmsPayloadBuilder.build(
                installId = "device-install-id",
                sentAtMillis = scan.through,
                messages = emptyList(),
                scan = scan,
            ),
        )

        assertEquals(0, payload.getJSONArray("messages").length())
        assertTrue(payload.getJSONObject("scan").getBoolean("complete"))
        assertEquals(17, payload.getJSONObject("scan").getInt("inboxMessageCount"))
        assertEquals(0, payload.getJSONObject("scan").getInt("transactionCandidateCount"))
    }

    @Test
    fun `rejects more than one hundred messages in one payload`() {
        val messages = List(SmsPayloadBuilder.MAX_MESSAGE_BATCH_SIZE + 1) { index ->
            sampleMessage().copy(id = "message-$index")
        }
        assertThrows(IllegalArgumentException::class.java) {
            SmsPayloadBuilder.build(
                installId = "device-install-id",
                sentAtMillis = 1_722_000_000_000L,
                messages = messages,
                scan = sampleScan(
                    complete = false,
                    inboxMessageCount = messages.size,
                    transactionCandidateCount = messages.size,
                ),
            )
        }
    }

    @Test
    fun `rejects messages in a completion checkpoint`() {
        assertThrows(IllegalArgumentException::class.java) {
            SmsPayloadBuilder.build(
                installId = "device-install-id",
                sentAtMillis = 1_722_000_000_000L,
                messages = listOf(sampleMessage()),
                scan = sampleScan(complete = true),
            )
        }
    }

    @Test
    fun `current month window follows IST across a UTC month boundary`() {
        val through = Instant.parse("2026-07-31T19:00:00Z").toEpochMilli()
        val window = SmsScanWindowFactory.currentIstMonth(through)

        assertEquals("2026-08", window.monthKey)
        assertEquals(Instant.parse("2026-07-31T18:30:00Z").toEpochMilli(), window.from)
        assertEquals(through, window.through)
    }

    private fun sampleMessage() = TransactionSms(
        id = "message-id",
        sender = "AX-HDFCBK",
        receivedAtMillis = 1_721_000_000_000L,
        body = "Your account was debited by INR 500 at a merchant.",
    )

    private fun sampleScan(
        complete: Boolean,
        inboxMessageCount: Int = 25,
        transactionCandidateCount: Int = 3,
    ) = SmsScanMetadata(
        id = "12345678-1234-1234-1234-123456789012",
        monthKey = "2026-07",
        from = Instant.parse("2026-06-30T18:30:00Z").toEpochMilli(),
        through = Instant.parse("2026-07-29T10:30:00Z").toEpochMilli(),
        inboxMessageCount = inboxMessageCount,
        transactionCandidateCount = transactionCandidateCount,
        complete = complete,
    )
}
