package com.ayush.smsbudgetcompanion

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLHandshakeException

data class UploadResult(
    val successful: Boolean,
    val retryable: Boolean,
    val responseCode: Int? = null,
)

class HmacUploadClient {
    fun upload(endpoint: String, sharedSecret: String, jsonBody: String): UploadResult {
        val timestamp = System.currentTimeMillis().toString()
        val nonce = createNonce()
        val signature = sign(sharedSecret, timestamp, nonce, jsonBody)
        var connection: HttpsURLConnection? = null
        return try {
            connection = URI(endpoint).toURL().openConnection() as? HttpsURLConnection
                ?: return UploadResult(successful = false, retryable = false)
            connection.apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MILLIS
                readTimeout = READ_TIMEOUT_MILLIS
                instanceFollowRedirects = false
                doOutput = true
                setFixedLengthStreamingMode(jsonBody.toByteArray(Charsets.UTF_8).size)
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("User-Agent", "SmsBudgetCompanion/1.0")
                setRequestProperty("x-budget-timestamp", timestamp)
                setRequestProperty("x-budget-nonce", nonce)
                setRequestProperty("x-budget-signature", signature)
            }
            connection.outputStream.use { stream ->
                stream.write(jsonBody.toByteArray(Charsets.UTF_8))
            }
            val responseCode = connection.responseCode
            runCatching {
                val stream = if (responseCode >= 400) connection.errorStream else connection.inputStream
                stream?.use { input ->
                    val buffer = ByteArray(1_024)
                    while (input.read(buffer) != -1) {
                        // Deliberately discard response content; it could contain server details.
                    }
                }
            }
            UploadResult(
                successful = responseCode in 200..299,
                retryable = responseCode == HttpURLConnection.HTTP_CLIENT_TIMEOUT ||
                    responseCode == 425 ||
                    responseCode == 429 ||
                    responseCode >= 500,
                responseCode = responseCode,
            )
        } catch (_: SSLHandshakeException) {
            UploadResult(successful = false, retryable = false)
        } catch (_: IOException) {
            UploadResult(successful = false, retryable = true)
        } catch (_: RuntimeException) {
            UploadResult(successful = false, retryable = false)
        } finally {
            connection?.disconnect()
        }
    }

    internal fun sign(
        sharedSecret: String,
        timestamp: String,
        nonce: String,
        jsonBody: String,
    ): String {
        val canonical = "$timestamp.$nonce.$jsonBody"
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(sharedSecret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(canonical.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    private fun createNonce(): String {
        val bytes = ByteArray(18).also(SECURE_RANDOM::nextBytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    companion object {
        private const val CONNECT_TIMEOUT_MILLIS = 15_000
        private const val READ_TIMEOUT_MILLIS = 30_000
        private val SECURE_RANDOM = SecureRandom()
    }
}
