package com.ayush.smsbudgetcompanion

import android.content.ContentResolver
import android.provider.BaseColumns
import android.provider.Telephony

class SmsRepository(private val contentResolver: ContentResolver) {
    fun readInboxSince(fromInclusiveMillis: Long, untilInclusiveMillis: Long): List<SmsRecord> {
        val projection = arrayOf(
            BaseColumns._ID,
            Telephony.Sms.ADDRESS,
            Telephony.Sms.DATE,
            Telephony.Sms.BODY,
        )
        val selection = "${Telephony.Sms.DATE} >= ? AND ${Telephony.Sms.DATE} <= ?"
        val selectionArgs = arrayOf(
            fromInclusiveMillis.toString(),
            untilInclusiveMillis.toString(),
        )

        val cursor = contentResolver.query(
                Telephony.Sms.Inbox.CONTENT_URI,
                projection,
                selection,
                selectionArgs,
                "${Telephony.Sms.DATE} ASC",
            ) ?: throw IllegalStateException("Android returned no SMS inbox cursor")

        return buildList {
            cursor.use {
                val idColumn = cursor.getColumnIndexOrThrow(BaseColumns._ID)
                val senderColumn = cursor.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
                val dateColumn = cursor.getColumnIndexOrThrow(Telephony.Sms.DATE)
                val bodyColumn = cursor.getColumnIndexOrThrow(Telephony.Sms.BODY)

                while (cursor.moveToNext()) {
                    val body = cursor.getString(bodyColumn)?.trim().orEmpty()
                    add(
                        SmsRecord(
                            localId = cursor.getLong(idColumn),
                            sender = cursor.getString(senderColumn).orEmpty(),
                            receivedAtMillis = cursor.getLong(dateColumn),
                            body = body,
                        ),
                    )
                }
            }
        }
    }
}
