package com.ayush.smsbudgetcompanion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock

class SmsSyncWorker(
    appContext: Context,
    workerParams: WorkerParameters,
) : Worker(appContext, workerParams) {
    override fun doWork(): Result {
        if (!SYNC_LOCK.tryLock()) return Result.retry()
        return try {
            syncOnce()
        } finally {
            SYNC_LOCK.unlock()
        }
    }

    private fun syncOnce(): Result {
        if (
            ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.READ_SMS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return Result.success()
        }

        val configStore = SecureConfigStore(applicationContext)
        if (!configStore.hasConsent()) return Result.success()
        val endpoint = configStore.getEndpoint().orEmpty()
        val secret = configStore.getSharedSecret().orEmpty()
        if (SecureConfigStore.validateEndpoint(endpoint) != null || secret.isBlank()) {
            return Result.success()
        }

        val scanUpperBound = System.currentTimeMillis()
        val scanWindow = SmsScanWindowFactory.currentIstMonth(scanUpperBound)

        val records = try {
            SmsRepository(applicationContext.contentResolver).readInboxSince(
                scanWindow.from,
                scanWindow.through,
            )
        } catch (_: SecurityException) {
            return Result.failure()
        } catch (_: RuntimeException) {
            return Result.retry()
        }

        val candidates = records.asSequence()
            .filter { TransactionSmsFilter.isTransactionCandidate(it.sender, it.body) }
            .map(TransactionSmsFilter::toTransactionSms)
            .distinctBy(TransactionSms::id)
            .toList()

        if (isStopped || !configStore.hasConsent()) return Result.success()

        val installId = configStore.getOrCreateInstallId()
        val scanId = UUID.randomUUID().toString()
        val client = HmacUploadClient()
        val incompleteScan = SmsScanMetadata(
            id = scanId,
            monthKey = scanWindow.monthKey,
            from = scanWindow.from,
            through = scanWindow.through,
            inboxMessageCount = records.size,
            transactionCandidateCount = candidates.size,
            complete = false,
        )
        candidates.chunked(SmsPayloadBuilder.MAX_MESSAGE_BATCH_SIZE).forEach { batch ->
            if (isStopped || !configStore.hasConsent()) return Result.success()
            val payload = SmsPayloadBuilder.build(
                installId = installId,
                sentAtMillis = System.currentTimeMillis(),
                messages = batch,
                scan = incompleteScan,
            )
            val upload = client.upload(endpoint, secret, payload)
            if (!upload.successful) {
                return if (upload.retryable) Result.retry() else Result.failure()
            }
        }

        if (isStopped || !configStore.hasConsent()) return Result.success()
        val completionPayload = SmsPayloadBuilder.build(
            installId = installId,
            sentAtMillis = System.currentTimeMillis(),
            messages = emptyList(),
            scan = incompleteScan.copy(complete = true),
        )
        val completionUpload = client.upload(endpoint, secret, completionPayload)
        if (!completionUpload.successful) {
            return if (completionUpload.retryable) Result.retry() else Result.failure()
        }

        configStore.setLastSuccessfulSyncMillis(scanUpperBound)
        return Result.success()
    }

    companion object {
        private val SYNC_LOCK = ReentrantLock()
    }
}
