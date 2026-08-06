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
        """\b(debited|spent|paid|charged|purchased|refunded|refund|reversal|withdrawn|transferred)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val explicitSentTransferRegex = Regex(
        """\bsent\b.{0,160}\bfrom\b.{0,160}\bto\b""",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
    )
    private val completedPaymentRegex = Regex(
        """(?:\b(payment|txn|transaction|upi)\b.{0,80}\b(successful|succeeded|completed)\b)|(?:\b(successful|succeeded|completed)\b.{0,80}\b(payment|txn|transaction|upi)\b)""",
        RegexOption.IGNORE_CASE,
    )
    private val failedOrPendingRegex = Regex(
        """\b(payment|transaction|txn|upi|order|mandate|autopay)\b.{0,50}\b(failed|declined|cancelled|canceled|unsuccessful|pending|processing|scheduled|requested|request)\b|\b(failed|declined|cancelled|canceled|unsuccessful|pending|processing|scheduled|requested|request)\b.{0,50}\b(payment|transaction|txn|upi|order|mandate|autopay)\b|\b(please|kindly)\s+(pay|send|transfer)\b|\b(pay|send|transfer)\s+now\b""",
        RegexOption.IGNORE_CASE,
    )
    private val personalConversationRegex = Regex(
        """(?:\b(i|we)\s+(paid|spent|sent|transferred|charged)\b)|(?:\b(can|could|would)\s+you\s+(pay|send|transfer)\b)|(?:\b(send\s+me|your\s+half|split\s+(it|this|the\s+bill)|you\s+owe|i\s+owe)\b)""",
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
    private val clearEventDespitePromotionRegex = Regex(
        """\b(debited|spent|charged|purchased|refunded|refund|reversal|withdrawn|transferred|paid\s+(to|at|for))\b""",
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
    private val phoneLikeSenderRegex = Regex("""^\+?[\d\s().-]{7,20}$""")
    private val balanceTailRegex = Regex(
        """(?:[.;]\s*)?\b(?:available|avl|current|closing)\s+(?:a/?c\s+)?bal(?:ance)?\b.*$""",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
    )
    private val securityTailRegex = Regex(
        """(?:[.;]\s*)?\b(?:if\s+(?:this\s+was\s+)?not\s+you|not\s+you\??|report\s+(?:this|fraud)|call\s+(?:the\s+)?bank|never\s+share\s+(?:your\s+)?(?:otp|pin|cvv))\b.*$""",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
    )
    private val marketingTailRegex = Regex(
        """(?:[.;]\s*)?\b(?:get|earn|claim|enjoy)\b.{0,80}\b(?:cashback|offer|discount|reward)\b.*$""",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
    )

    fun isTransactionCandidate(sender: String?, body: String): Boolean {
        val text = body.trim()
        if (text.isEmpty()) return false
        if (isPersonalSender(sender)) return false
        if (authenticationCodeRegex.containsMatchIn(text)) return false
        if (personalConversationRegex.containsMatchIn(text)) return false
        if (failedOrPendingRegex.containsMatchIn(text) && !text.contains("refund", ignoreCase = true)) {
            return false
        }
        if (dueNoticeRegex.containsMatchIn(text)) return false
        if (selfTransferRegex.containsMatchIn(text)) return false
        if (cardBillPaymentRegex.containsMatchIn(text)) return false

        // Order statuses and vague transaction notices cannot contribute a reliable budget amount.
        if (!inrAmountRegex.containsMatchIn(text)) return false

        val hasSettledTransaction = settledTransactionRegex.containsMatchIn(text) ||
            completedPaymentRegex.containsMatchIn(text) ||
            explicitSentTransferRegex.containsMatchIn(text)
        if (balanceOnlyRegex.containsMatchIn(text) && !hasSettledTransaction) return false
        if (promotionRegex.containsMatchIn(text) && !hasSettledTransaction) return false
        if (promotionRegex.containsMatchIn(text) &&
            !clearEventDespitePromotionRegex.containsMatchIn(text) &&
            !completedPaymentRegex.containsMatchIn(text)
        ) return false

        // Generic "payment", "UPI", or "transaction" wording is deliberately
        // insufficient. Only a completed INR debit/refund leaves the device.
        return hasSettledTransaction
    }

    fun toTransactionSms(record: SmsRecord): TransactionSms? {
        if (!isTransactionCandidate(record.sender, record.body)) return null
        val minimizedBody = minimizeTransactionBody(record.body).take(MAX_BODY_LENGTH)
        // Defense in depth on-device: removal of a balance/security/marketing
        // tail must not leave a non-transaction fragment eligible for upload.
        if (!isTransactionCandidate(record.sender, minimizedBody)) return null
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
            body = minimizedBody,
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

    internal fun minimizeTransactionBody(body: String): String = sanitizeBody(body)
        .replace(balanceTailRegex, "")
        .replace(securityTailRegex, "")
        .replace(marketingTailRegex, "")
        .replace(whitespaceRegex, " ")
        .trim()

    private fun isPersonalSender(sender: String?): Boolean {
        val value = sender?.trim().orEmpty()
        if (value.isEmpty()) return true
        if (value.equals("[phone]", ignoreCase = true) ||
            value.equals("unknown", ignoreCase = true) ||
            value.equals("private", ignoreCase = true) ||
            value.equals("anonymous", ignoreCase = true)
        ) return true
        if (phoneLikeSenderRegex.matches(value)) return true
        val digitCount = value.count(Char::isDigit)
        return digitCount >= 10 && digitCount.toDouble() / value.length >= 0.65
    }

    private const val MAX_BODY_LENGTH = 750
    private const val MAX_SENDER_LENGTH = 40
}
