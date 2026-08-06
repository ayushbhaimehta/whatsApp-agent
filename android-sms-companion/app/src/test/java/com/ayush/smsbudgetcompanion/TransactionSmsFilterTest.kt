package com.ayush.smsbudgetcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TransactionSmsFilterTest {
    @Test
    fun `accepts debit alert with INR amount`() {
        assertTrue(
            TransactionSmsFilter.isTransactionCandidate(
                "AX-HDFCBK",
                "Your HDFC Bank A/C XX1234 was debited by Rs. 1,245.00 at SWIGGY.",
            ),
        )
    }

    @Test
    fun `accepts UPI payment with INR amount`() {
        assertTrue(
            TransactionSmsFilter.isTransactionCandidate(
                "VM-ICICI",
                "UPI payment of INR 500.00 to Fresh Foods was successful.",
            ),
        )
    }

    @Test
    fun `accepts refund alert`() {
        assertTrue(
            TransactionSmsFilter.isTransactionCandidate(
                "SBIINB",
                "INR 799 has been refunded to your SBI account.",
            ),
        )
    }

    @Test
    fun `rejects order status without amount`() {
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "ZEPTON",
                "Your Zepto order ZP123 has been delivered.",
            ),
        )
    }

    @Test
    fun `rejects transaction wording without INR amount`() {
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "HDFCBK",
                "Your account was debited at a merchant.",
            ),
        )
    }

    @Test
    fun `rejects OTP even when it references transaction amount`() {
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "HDFCBK",
                "OTP 123456 is your one-time password for a transaction of INR 800. Valid for 5 minutes.",
            ),
        )
    }

    @Test
    fun `does not mistake amount plus generic OTP warning for an OTP`() {
        assertTrue(
            TransactionSmsFilter.isTransactionCandidate(
                "HDFCBK",
                "Your account was debited by INR 1200 at a merchant. Never share your OTP.",
            ),
        )
    }

    @Test
    fun `rejects verification code`() {
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "PAYTM",
                "Use verification code 874921 to sign in. Do not share it.",
            ),
        )
    }

    @Test
    fun `rejects promotional discount`() {
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "ZEPTON",
                "Limited time offer: get Rs.500 off on Zepto. Shop now!",
            ),
        )
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "PAYAPP",
                "We sent INR 500 cashback because you are a valued customer.",
            ),
        )
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "PAYAPP",
                "We paid INR 500 cashback to selected customers.",
            ),
        )
    }

    @Test
    fun `rejects failed or pending payment`() {
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "AXISBK",
                "Your payment of INR 650 was declined at ZOMATO.",
            ),
        )
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "AXISBK",
                "Your UPI payment of INR 650 is pending.",
            ),
        )
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "AXISBK",
                "UPI collect request for INR 650 awaits your approval.",
            ),
        )
    }

    @Test
    fun `rejects generic payment wording without a settled event`() {
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "PAYAPP",
                "Please pay INR 650 now using UPI.",
            ),
        )
    }

    @Test
    fun `rejects balance-only notice`() {
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "SBIINB",
                "Your available account balance is INR 24,500.00.",
            ),
        )
    }

    @Test
    fun `rejects due notice`() {
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "HDFCCB",
                "Credit card bill due: INR 8,500. Due date 4 August.",
            ),
        )
    }

    @Test
    fun `rejects credit card bill payment confirmation to avoid double count`() {
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "HDFCCB",
                "Your credit card bill payment of INR 8,500 was received successfully.",
            ),
        )
    }

    @Test
    fun `rejects self transfer`() {
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "ICICIB",
                "INR 5,000 transferred between your accounts via UPI.",
            ),
        )
    }

    @Test
    fun `rejects ordinary personal message`() {
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "+919999999999",
                "I will reach home at 7, please keep dinner ready.",
            ),
        )
    }

    @Test
    fun `rejects settlement-like personal SMS from a phone number`() {
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "+919999999999",
                "I paid INR 500 for dinner, send me your half.",
            ),
        )
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "[phone]",
                "I paid INR 500 for dinner, send me your half.",
            ),
        )
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "FRIEND",
                "I paid INR 500 for dinner, send me your half.",
            ),
        )
        assertFalse(
            TransactionSmsFilter.isTransactionCandidate(
                "",
                "INR 500 paid to GREEN LEAF CAFE.",
            ),
        )
    }

    @Test
    fun `redacts sensitive identifiers before payload creation`() {
        val sanitized = TransactionSmsFilter.sanitizeBody(
            "Paid INR 100 from A/C XX-1234 to ayush@oksbi; UTR N123456789; " +
                "RRN: 987654321012; call +91 98765 43210; PIN: 4321; " +
                "visit https://bank.test/a?t=secret",
        )
        assertFalse(sanitized.contains("XX-1234"))
        assertFalse(sanitized.contains("ayush@oksbi"))
        assertFalse(sanitized.contains("N123456789"))
        assertFalse(sanitized.contains("987654321012"))
        assertFalse(sanitized.contains("98765 43210"))
        assertFalse(sanitized.contains("4321"))
        assertFalse(sanitized.contains("https://"))
        assertTrue(sanitized.contains("[payment reference]"))
        assertTrue(sanitized.contains("[upi id]"))
        assertTrue(sanitized.contains("[phone]"))
        assertTrue(sanitized.contains("[secret removed]"))
        assertTrue(sanitized.contains("[link]"))
    }

    @Test
    fun `redacts phone-number sender`() {
        assertEquals("[phone]", TransactionSmsFilter.sanitizeSender("+91 98765 43210"))
    }

    @Test
    fun `uploads only the minimized transaction clause`() {
        val minimized = TransactionSmsFilter.minimizeTransactionBody(
            "INR 500 debited at ZEPTO using card XX123456. Avl Bal INR 50,000. " +
                "Never share your OTP. Get cashback on your next order.",
        )
        assertTrue(minimized.contains("INR 500 debited at ZEPTO"))
        assertFalse(minimized.contains("XX123456"))
        assertFalse(minimized.contains("50,000"))
        assertFalse(minimized.contains("OTP"))
        assertFalse(minimized.contains("cashback"))

        val converted = TransactionSmsFilter.toTransactionSms(
            SmsRecord(
                localId = 1,
                sender = "AX-HDFCBK",
                receivedAtMillis = 1_786_000_000_000,
                body = "INR 500 debited at ZEPTO. Avl Bal INR 50,000. Never share your OTP.",
            ),
        )
        assertEquals("INR 500 debited at ZEPTO", converted?.body)
    }

    @Test
    fun `does not upload when minimization removes the only settled evidence`() {
        val record = SmsRecord(
            localId = 2,
            sender = "PAYAPP",
            receivedAtMillis = 1_786_000_000_000,
            body = "Account notice. Never share your OTP; INR 500 payment completed.",
        )
        assertTrue(TransactionSmsFilter.isTransactionCandidate(record.sender, record.body))
        assertEquals(null, TransactionSmsFilter.toTransactionSms(record))
    }
}
