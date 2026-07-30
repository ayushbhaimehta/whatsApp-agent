package com.ayush.smsbudgetcompanion

import org.junit.Assert.assertEquals
import org.junit.Test

class HmacUploadClientTest {
    @Test
    fun `signature matches Node ingestion canonical format`() {
        val signature = HmacUploadClient().sign(
            sharedSecret = "01234567890123456789012345678901",
            timestamp = "1720000000000",
            nonce = "abcdefghijklmnop",
            jsonBody = "{\"ok\":true}",
        )
        assertEquals(
            "e5f1fff6cb2ab4e6526515b7fc0f7722a0770789a20d815589bc9d23cc83ea27",
            signature,
        )
    }
}
