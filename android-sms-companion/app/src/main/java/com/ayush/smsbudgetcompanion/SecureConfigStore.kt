package com.ayush.smsbudgetcompanion

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.ByteBuffer
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Stores endpoint credentials with an AES-256-GCM key that never leaves Android Keystore.
 * Backups are disabled because a restored ciphertext cannot be decrypted by another device.
 */
class SecureConfigStore(context: Context) {
    private val preferences: SharedPreferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    fun getEndpoint(): String? = readEncrypted(KEY_ENDPOINT)

    fun setEndpoint(value: String) = writeEncrypted(KEY_ENDPOINT, value.trim())

    fun getSharedSecret(): String? = readEncrypted(KEY_SHARED_SECRET)

    fun setSharedSecret(value: String) = writeEncrypted(KEY_SHARED_SECRET, value)

    fun hasSharedSecret(): Boolean = !getSharedSecret().isNullOrBlank()

    fun hasConsent(): Boolean = readEncrypted(KEY_CONSENT) == "true"

    fun setConsent(value: Boolean) = writeEncrypted(KEY_CONSENT, value.toString())

    fun isConfigured(): Boolean = validateEndpoint(getEndpoint().orEmpty()) == null && hasSharedSecret()

    fun getLastSuccessfulSyncMillis(): Long = readEncrypted(KEY_LAST_SYNC)?.toLongOrNull() ?: 0L

    fun setLastSuccessfulSyncMillis(value: Long) = writeEncrypted(KEY_LAST_SYNC, value.toString())

    @Synchronized
    fun getOrCreateInstallId(): String {
        readEncrypted(KEY_INSTALL_ID)?.takeIf { it.isNotBlank() }?.let { return it }
        return UUID.randomUUID().toString().also { writeEncrypted(KEY_INSTALL_ID, it) }
    }

    @Synchronized
    private fun writeEncrypted(key: String, plaintext: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val iv = cipher.iv
        val packed = ByteBuffer.allocate(1 + iv.size + ciphertext.size)
            .put(iv.size.toByte())
            .put(iv)
            .put(ciphertext)
            .array()
        preferences.edit().putString(key, Base64.encodeToString(packed, Base64.NO_WRAP)).apply()
    }

    @Synchronized
    private fun readEncrypted(key: String): String? {
        val encoded = preferences.getString(key, null) ?: return null
        return runCatching {
            val packed = Base64.decode(encoded, Base64.NO_WRAP)
            val buffer = ByteBuffer.wrap(packed)
            val ivSize = buffer.get().toInt() and 0xff
            require(ivSize in 12..16 && buffer.remaining() > ivSize)
            val iv = ByteArray(ivSize).also { buffer.get(it) }
            val ciphertext = ByteArray(buffer.remaining()).also { buffer.get(it) }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        }.getOrNull()
    }

    private fun getOrCreateKey(): SecretKey = synchronized(KEY_CREATION_LOCK) {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey) ?: run {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).run {
                init(
                    KeyGenParameterSpec.Builder(
                        KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                    )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .setRandomizedEncryptionRequired(true)
                        .build(),
                )
                generateKey()
            }
        }
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "sms_budget_companion_config_v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val PREFERENCES_NAME = "secure_config_v1"
        private const val KEY_ENDPOINT = "endpoint"
        private const val KEY_SHARED_SECRET = "shared_secret"
        private const val KEY_LAST_SYNC = "last_sync"
        private const val KEY_INSTALL_ID = "install_id"
        private const val KEY_CONSENT = "consent"
        private val KEY_CREATION_LOCK = Any()

        /** Returns a user-facing error, or null when the endpoint is acceptable. */
        fun validateEndpoint(value: String): String? {
            if (value.isBlank()) return "An upload endpoint is required."
            val uri = runCatching { Uri.parse(value) }.getOrNull()
                ?: return "Enter a valid URL."
            if (!uri.scheme.equals("https", ignoreCase = true)) {
                return "Only HTTPS endpoints are allowed."
            }
            if (uri.host.isNullOrBlank()) return "The endpoint must include a host."
            if (uri.userInfo != null) return "Credentials must not be embedded in the URL."
            if (uri.query != null || uri.fragment != null) {
                return "Do not include query parameters or a URL fragment."
            }
            return null
        }
    }
}
