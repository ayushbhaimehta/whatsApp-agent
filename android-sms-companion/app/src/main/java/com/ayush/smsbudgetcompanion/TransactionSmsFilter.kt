package com.ayush.smsbudgetcompanion

import java.security.MessageDigest

/**
 * Conservative, local-only filter. Raw non-candidate SMS messages never reach the network layer.
 */
object TransactionSmsFilter {
    private val authenticationCodeRegex = Regex(
        """(?:\b(?:otp|one[\s-]?time(?:\s+password)?|verification\s+code|security\s+code|login\s+code|authentication\s+code|sign[\s-]?in\s+code)\b\s*(?:is|:|-)?\s*\d{4,8}\b)|(?:\b\d{4,8}\b\s*(?:is|:|-)?\s*(?:your\s+)?(?:otp|one[\s-]?time\s+password|verification\s+code|security\s+code|login\s+code)\b)|(?:\b(?:use|enter|share|provide)\s+(?:the\s+)?(?:otp|code\s+)?\d{4,8}\b)|(?:\b(?:otp|verification\s+code|security\s+code)\b.{0,30}\b(?:is|:)\s*\d{4,8}\b)""",
        RegexOption.IGNORE_CASE,
    )
    private val inrAmountRegex = Regex(
        """(?:\x{20B9}\s*|\bINR\s*|\bRs\.?\s*)\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s*(?:INR|rupees?)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val settledTransactionRegex = Regex(
        """\b(debited|spent|paid|charged|purchases?|purchased|refunded|refund|reversal|withdrawn|transferred)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val transactionLanguageRegex = Regex(
        """\b(payment|txn|transaction|upi)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val failedOrPendingRegex = Regex(
        """\b(payment|transaction|txn|order)\b.{0,30}\b(failed|declined|cancelled|canceled|unsuccessful|pending|processing)\b|\b(failed|declined|cancelled|canceled|pending)\b.{0,30}\b(payment|transaction|txn|order)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val dueNoticeRegex = Regex(
        """\b(statement\s+generated|minimum\s+amount\s+due|payment\s+due|bill\s+due|due\s+date)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val selfTransferRegex = Regex(
        """\b(between\s+your\s+accounts?|to\s+(?:your\s+)?(?:own\s+account|self)|self[\s-]?transfer)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val cardBillPaymentRegex = Regex(
        """\bcredit\s+card\b.{0,60}\bpayment\b.{0,40}\b(received|successful|paid)\b|\bpayment\b.{0,50}\b(?:towards|for)\b.{0,20}\bcredit\s+card\b""",
        RegexOption.IGNORE_CASE,
    )
    private val balanceOnlyRegex = Regex(
        """\b(available|avl|current|closing)\s+(?:a/?c\s+)?bal(?:ance)?\b""",
        RegexOption.IGNORE_CASE,
    )
    private val promotionRegex = Regex(
        """\b(offer|coupon|promo\s*code|discount|sale|deal|shop\s+now|limited\s+time|flat\s+\d+%?\s+off|save\s+up\s+to|apply\s+now|pre[\s-]?approved|win|earn|cashback)\b""",
        RegexOption.IGNORE_CASE,
    )

    private val linkRegex = Regex("""https?://\S+""", RegexOption.IGNORE_CASE)
    private val emailRegex = Regex(
        """\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b""",
        RegexOption.IGNORE_CASE,
    )
    private val upiIdRegex = Regex(
        """\b[A-Z0-9._-]{2,}@[A-Z][A-Z0-9.-]{1,30}\b""",
        RegexOption.IGNORE_CASE,
    )
    private val explicitSecretRegex = Regex(
        """\b(otp|pin|cvv)\s*(?:is|:|-)?\s*\d{3,8}\b""",
        RegexOption.IGNORE_CASE,
    )
    private val accountOrCardReferenceRegex = Regex(
        """\b(?:a/?c|account|card)\s*(?:(?:no\.?|number|ending(?:\s+in)?)\s*)?(?:[:#-]\s*)?[X*\d][X*\d\s-]{3,30}\b""",
        RegexOption.IGNORE_CASE,
    )
    private val transactionReferenceRegex = Regex(
        """\b(?:rrn|utr|upi\s*(?:ref|reference)|txn(?:\s*(?:id|no\.?|number))?|transaction\s*(?:id|no\.?|number|reference)|reference|ref)\s*(?:no\.?|number|id)?\s*[:#-]?\s*(?=[A-Z0-9-]{6,40}\b)(?=[A-Z0-9-]*\d)[A-Z0-9-]+\b""",
        RegexOption.IGNORE_CASE,
    )
    private val phoneRegex = Regex("""(?<!\d)\+?\d(?:[\s-]?\d){9,14}(?!\d)""")
    private val longNumberRegex = Regex("""(?<!\d)(?:\d[\s-]?){8,}(?!\d)""")
    private val whitespaceRegex = Regex("""\s+""")

    @Suppress("UNUSED_PARAMETER")
    fun isTransactionCandidate(sender: String?, body: String): Boolean {
        val text = body.trim()
        if (text.isEmpty()) return false
        if (authenticationCodeRegex.containsMatchIn(text)) return false
        if (failedOrPendingRegex.containsMatchIn(text) && !text.contains("refund", ignoreCase = true)) {
            return false
        }
        if (dueNoticeRegex.containsMatchIn(text)) return false
        if (selfTransferRegex.containsMatchIn(text)) return false
        if (cardBillPaymentRegex.containsMatchIn(text)) return false

        // Order statuses and vague transaction notices cannot contribute a reliable budget amount.
        if (!inrAmountRegex.containsMatchIn(text)) return false

        val hasSettledTransaction = settledTransactionRegex.containsMatchIn(text)
        if (balanceOnlyRegex.containsMatchIn(text) && !hasSettledTransaction) return false
        if (promotionRegex.containsMatchIn(text) && !hasSettledTransaction) return false

        return hasSettledTransaction || transactionLanguageRegex.containsMatchIn(text)
    }

    fun toTransactionSms(record: SmsRecord): TransactionSms {
        val stableMaterial = listOf(
            record.sender,
            record.receivedAtMillis.toString(),
            record.body,
        ).joinToString("\u0000")
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(stableMaterial.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        return TransactionSms(
            id = digest,
            sender = sanitizeSender(record.sender),
            receivedAtMillis = record.receivedAtMillis,
            body = sanitizeBody(record.body).take(MAX_BODY_LENGTH),
        )
    }

    internal fun sanitizeSender(sender: String): String {
        val trimmed = sender.trim()
        if (phoneRegex.matches(trimmed)) return "[phone]"
        return trimmed.replace(Regex("""[^A-Za-z0-9+_-]"""), "").take(MAX_SENDER_LENGTH)
            .ifBlank { "Unknown" }
    }

    internal fun sanitizeBody(body: String): String = body
        .replace(linkRegex, "[link]")
        .replace(emailRegex, "[email]")
        .replace(upiIdRegex, "[upi id]")
        .replace(explicitSecretRegex, "[secret removed]")
        .replace(accountOrCardReferenceRegex, "[payment reference]")
        .replace(transactionReferenceRegex, "[payment reference]")
        .replace(phoneRegex, "[phone]")
        .replace(longNumberRegex, "[reference]")
        .replace(whitespaceRegex, " ")
        .trim()

    private const val MAX_BODY_LENGTH = 2_000
    private const val MAX_SENDER_LENGTH = 40
}

