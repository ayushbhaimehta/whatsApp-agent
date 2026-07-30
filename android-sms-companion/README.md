# SMS Budget Companion (Android)

This is a small, sideloadable Android companion for the WhatsApp budget agent. On every sync it reads the **entire SMS inbox for the current month in Asia/Kolkata**, filters messages locally, and sends only likely settled transactions containing an INR amount to the agent's private HTTPS ingestion endpoint. OTP/authentication messages, promotions, balance and due notices, failed/pending payments, self-transfers, credit-card bill payment confirmations, order-status-only messages, and ordinary personal messages are discarded before payload construction.

It does not scrape another app's private storage and it does not upload the full SMS inbox. After all transaction batches succeed, it sends an empty, count-only completion checkpoint so the desktop agent can verify that the full current-month inbox scan completed. No non-transaction SMS body is included in that checkpoint.

## Data flow

```text
Incoming SMS / six-hour WorkManager scan
                  |
          current-month inbox query
                  |
      settled INR transaction filter
                  |
 UPI ID / phone / account / card / reference redaction
                  |
  schema-v2 batches of at most 100 candidates
                  |
 HTTPS POST + timestamp + nonce + HMAC-SHA256
                  |
  signed empty full-scan completion checkpoint
                  |
     /v1/sms/transactions on the agent
```

The incoming-SMS broadcast only enqueues work. It never sends broadcast extras over the network. Every run starts again at midnight IST on the first day of the current month, so completeness does not depend on an incremental cursor. The fixed scan ID and window tie all batches and the final checkpoint to one scan; deterministic message IDs let the server safely deduplicate full rescans and retries.

## Build and install

A verified debug build is available at [`dist/SMS-Budget-Companion-debug.apk`](./dist/SMS-Budget-Companion-debug.apk). Copy it to the phone and open it to sideload, or install it over an authorized USB-debugging connection.

Requirements:

- Android Studio with Android SDK 35 installed
- JDK 17 (Android Studio's bundled JDK is suitable)
- An Android 8.0/API 26 or newer phone

Steps:

1. Open the `android-sms-companion` directory in Android Studio.
2. Let Gradle sync and run `app` on the connected phone, or use **Build > Build APK(s)** and sideload the debug APK.
3. Open **SMS Budget Companion** on the phone.
4. Read and select the disclosure checkbox.
5. Enter the public endpoint, including `/v1/sms/transactions`. It must be HTTPS, for example `https://budget.example.net/v1/sms/transactions`.
6. Enter the same 32-or-more-character value used by the desktop agent as `SMS_INGESTION_SECRET`.
7. Tap **Save secure configuration**, then **Grant SMS access**, then **Sync current month now**.

For command-line builds on a machine with the Android SDK configured:

```powershell
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug
```

The debug APK will be under `app/build/outputs/apk/debug/`.

## Desktop endpoint requirements

The phone cannot reach the desktop service's default `127.0.0.1` address. Expose the ingestion handler through an HTTPS reverse proxy/VPN/tunnel that you control, or configure the desktop listener with a valid TLS certificate. Do not expose the service as plain HTTP and do not put the shared secret in a URL.

Each candidate batch and the final completion checkpoint are signed independently:

```http
POST /v1/sms/transactions
Content-Type: application/json; charset=utf-8
x-budget-timestamp: 1720000000000
x-budget-nonce: URL_SAFE_RANDOM_VALUE
x-budget-signature: HEX_HMAC_SHA256
```

The signature input is the exact UTF-8 sequence:

```text
timestamp + "." + nonce + "." + raw_request_body
```

The secret is the literal UTF-8 value of `SMS_INGESTION_SECRET`. Candidate batches use this body shape:

```json
{
  "schemaVersion": 2,
  "source": "android-sms",
  "deviceId": "per-install UUID",
  "sentAt": 1720000000000,
  "messages": [
    {
      "id": "sha256 stable message id",
      "sender": "AX-HDFCBK",
      "occurredAt": 1720000000000,
      "body": "Your account was debited by INR 500 at ..."
    }
  ],
  "scan": {
    "id": "per-scan UUID",
    "monthKey": "2026-07",
    "from": 1782844200000,
    "through": 1785321000000,
    "inboxMessageCount": 245,
    "transactionCandidateCount": 37,
    "complete": false
  }
}
```

The same scan metadata is present in every batch. Only after all batches are accepted, the companion sends one more signed body with `"messages": []` and `"scan.complete": true`. This happens even when `transactionCandidateCount` is zero. The desktop budget report treats this completion checkpoint as mandatory evidence that the requested month's full SMS scan finished.

Redirect following is disabled so credentials cannot be forwarded to another host. The server should reject stale timestamps, reused nonces, invalid signatures, oversized bodies, and non-HTTPS public traffic.

## Privacy and security

- `READ_SMS` and `RECEIVE_SMS` are requested only after an in-app disclosure and explicit checkbox consent.
- The endpoint, shared secret, consent state, install ID, and last-completed scan timestamp are AES-256-GCM encrypted with a non-exportable Android Keystore key. The secret is not embedded in source code or the APK.
- Android backups and device-to-device transfer are disabled for encrypted preferences.
- Cleartext HTTP is disabled in the application and network security configuration.
- OTP/authentication codes are rejected locally even if they mention an amount or transaction.
- An actual INR amount plus transaction language is required. Order/delivery status without an amount is not budget evidence and is not uploaded.
- Balance-only and due notices, failed/pending payments, self-transfers, credit-card bill payment confirmations, and promotional messages are excluded to prevent false spending or double counting.
- Links, emails, UPI IDs, explicit PIN/CVV values, phone numbers (including spaced/international forms), and labelled/masked account, card, UTR, RRN, UPI/transaction references are redacted before upload. Phone-number senders are also redacted.
- Every sync reads all inbox messages from the start of the current month in Asia/Kolkata through the scan start time. Only locally filtered, redacted transaction candidates leave the phone.
- The final completion checkpoint contains scan identifiers, time bounds, and message counts only; it contains no personal SMS body.
- Unchecking consent cancels scheduled work. Also revoke SMS permissions from **Android Settings > Apps > SMS Budget Companion > Permissions** when retiring the app.
- Rooted devices, hostile accessibility services, or a compromised HTTPS endpoint can defeat these protections; use this only on devices and infrastructure you control.

### Google Play restriction

SMS permissions are hard-restricted by Google Play. A normal Play Store listing generally cannot request them unless the app qualifies for an approved core-function exception/default-handler role and completes the required permissions declaration. This project is intended for private sideloading. Do not publish it without reviewing the current [Google Play SMS and Call Log permissions policy](https://support.google.com/googleplay/android-developer/answer/10208820) and obtaining any required approval.

## Background behavior

- `IncomingSmsReceiver` schedules a scan when a new SMS arrives.
- WorkManager also performs a full current-month scan every six hours when a network is available, covering missed broadcasts and device restarts.
- A scan is marked successful on the phone only after every candidate batch and its empty completion checkpoint have been accepted. Retryable endpoint failures are retried by WorkManager.
- WorkManager timing is intentionally inexact and battery-aware. The monthly budget report itself is scheduled by the desktop agent on the 26th; this companion only keeps its financial-SMS data current.
- Some phone vendors aggressively suspend background work. If sync is delayed, allow background activity/unrestricted battery use for this app in the phone's system settings.

## Tests

`TransactionSmsFilterTest` covers debits, UPI payments, refunds, amount requirements, order-only rejection, OTP and verification rejection, promotions, failed/pending transactions, balances, due notices, card-bill confirmations, self-transfers, ordinary messages, and identifier redaction. `HmacUploadClientTest` pins the HMAC format to the Node ingestion implementation. `SmsPayloadBuilderTest` verifies schema version 2, full-scan metadata, IST month boundaries, the 100-message batch ceiling, and the mandatory empty completion checkpoint (including a zero-candidate scan).

The filter and HMAC tests can run without an Android SDK through the small JVM verification build:

```powershell
.\gradlew.bat -p jvm-verification test
```

Run `.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug` after installing Android SDK 35 to compile and test the complete application.
