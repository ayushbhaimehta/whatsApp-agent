const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_SCAN_FRESHNESS_MS = 12 * 60 * 60 * 1000;
const MAX_MESSAGES_PER_REQUEST = 100;
const IST_OFFSET_MS = 330 * 60 * 1000;

const INR_AMOUNT_PATTERN = /(?:₹\s*|INR\s*|Rs\.?\s*)[0-9][0-9,]*(?:\.\d{1,2})?|[0-9][0-9,]*(?:\.\d{1,2})?\s*(?:INR|rupees?)\b/i;
const AUTHENTICATION_SECRET_PATTERN = /(?:\b(?:otp|one[ -]?time(?:\s+password)?|verification\s+code|security\s+code|login\s+code|authentication\s+code|sign[ -]?in\s+code)\b\s*(?:is|:|-)?\s*\d{3,8}\b)|(?:\b\d{3,8}\b\s*(?:is|:|-)?\s*(?:your\s+)?(?:otp|one[ -]?time\s+password|verification\s+code|security\s+code|login\s+code)\b)|(?:\b(?:use|enter|share|provide)\s+(?:the\s+)?(?:otp|code\s+)?\d{3,8}\b)|(?:\b(?:otp|verification\s+code|security\s+code)\b[\s\S]{0,30}\b(?:is|:)\s*\d{3,8}\b)/i;
const SETTLED_TRANSACTION_PATTERN = /\b(?:debited|spent|paid|charged|purchased|refunded|refund|reversal|withdrawn|transferred)\b/i;
const EXPLICIT_SENT_TRANSFER_PATTERN = /\bsent\b[\s\S]{0,160}\bfrom\b[\s\S]{0,160}\bto\b/i;
const COMPLETED_PAYMENT_PATTERN = /(?:\b(?:payment|transaction|txn|upi)\b[\s\S]{0,80}\b(?:successful|succeeded|completed)\b)|(?:\b(?:successful|succeeded|completed)\b[\s\S]{0,80}\b(?:payment|transaction|txn|upi)\b)/i;
const NON_SETTLED_TRANSACTION_PATTERN = /(?:\b(?:payment|transaction|txn|upi|order|mandate|autopay)\b[\s\S]{0,50}\b(?:failed|declined|cancelled|canceled|unsuccessful|pending|processing|scheduled|requested|request)\b)|(?:\b(?:failed|declined|cancelled|canceled|unsuccessful|pending|processing|scheduled|requested|request)\b[\s\S]{0,50}\b(?:payment|transaction|txn|upi|order|mandate|autopay)\b)|(?:\b(?:please|kindly)\s+(?:pay|send|transfer)\b)|(?:\b(?:pay|send|transfer)\s+now\b)/i;
const PERSONAL_CONVERSATION_PATTERN = /(?:\b(?:i|we)\s+(?:paid|spent|sent|transferred|charged)\b)|(?:\b(?:can|could|would)\s+you\s+(?:pay|send|transfer)\b)|(?:\b(?:send\s+me|your\s+half|split\s+(?:it|this|the\s+bill)|you\s+owe|i\s+owe)\b)/i;
const PHONE_LIKE_SENDER_PATTERN = /^\+?[\d\s().-]{7,20}$/;

function hasSettledTransactionEvidence(body) {
    const text = String(body || '');
    return INR_AMOUNT_PATTERN.test(text) &&
        (SETTLED_TRANSACTION_PATTERN.test(text) ||
            COMPLETED_PAYMENT_PATTERN.test(text) ||
            EXPLICIT_SENT_TRANSFER_PATTERN.test(text));
}

function isPersonalSmsSender(sender) {
    const value = String(sender || '').trim();
    // Fail closed when sender provenance is unavailable. Normal bank and UPI
    // alerts use an alphanumeric sender ID; a blank sender cannot safely be
    // distinguished from a personal SMS.
    if (!value) return true;
    if (/^(?:\[phone\]|unknown|null|private|anonymous)$/i.test(value)) return true;
    if (PHONE_LIKE_SENDER_PATTERN.test(value)) return true;
    const digits = value.replace(/\D/g, '');
    return digits.length >= 10 && digits.length / value.length >= 0.65;
}

function isLikelyTransactionSms(body, sender = '') {
    const text = String(body || '').trim();
    if (!text || isPersonalSmsSender(sender)) return false;
    if (AUTHENTICATION_SECRET_PATTERN.test(text)) return false;
    if (PERSONAL_CONVERSATION_PATTERN.test(text)) return false;
    if (NON_SETTLED_TRANSACTION_PATTERN.test(text) && !/\brefund(?:ed)?\b/i.test(text)) return false;
    if (/\b(?:statement generated|minimum amount due|payment due|bill due|due date)\b/i.test(text)) return false;
    if (/\b(?:between your accounts?|to (?:your )?(?:own account|self))\b/i.test(text)) return false;
    if (/\bcredit card\b[\s\S]{0,50}\bpayment\b[\s\S]{0,30}\b(?:received|successful)\b/i.test(text)) return false;
    const hasSettledTransaction = hasSettledTransactionEvidence(text);
    if (/\b(?:available|avl|current|closing)\s+(?:a\/?c\s+)?bal(?:ance)?\b/i.test(text) && !hasSettledTransaction) return false;
    const hasPromotionLanguage = /\b(?:offer|sale|discount|deal|shop now|limited time|apply now|pre-approved|win|earn|cashback)\b/i.test(text);
    if (hasPromotionLanguage && !hasSettledTransaction) return false;
    const hasClearEventDespitePromotion = /\b(?:debited|spent|charged|purchased|refunded|refund|reversal|withdrawn|transferred|paid\s+(?:to|at|for))\b/i.test(text) ||
        COMPLETED_PAYMENT_PATTERN.test(text);
    if (hasPromotionLanguage && !hasClearEventDespitePromotion) return false;
    // Generic words such as "payment", "UPI", or "transaction" are not
    // enough: only a completed INR debit/refund can cross this boundary.
    return hasSettledTransaction;
}

function sanitizeSmsBody(body) {
    return String(body || '')
        .replace(/https?:\/\/\S+/gi, '[link]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .replace(/\b[A-Z0-9._-]{2,}@[A-Z][A-Z0-9.-]{1,30}\b/gi, '[upi id]')
        .replace(/(?<!\d)(?:\+?91[\s-]?)?[6-9](?:[\s-]?\d){9}(?!\d)/g, '[phone]')
        .replace(/\b(?:otp|pin|cvv)\s*(?:is|:|-)?\s*\d{3,8}\b/gi, '[secret removed]')
        .replace(/\b(?:a\/?c|account|card|rrn|utr|upi\s*(?:ref|reference)?|txn|transaction|reference|ref)\s*(?:no\.?|number|id)?\s*[:#-]?\s*[X*\d][X*\d\s-]{5,30}\b/gi, '[payment reference]')
        .replace(/\b(?:\d[\s-]?){8,}\b/g, '[reference]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000);
}

function minimizeTransactionSmsBody(body) {
    return sanitizeSmsBody(body)
        .replace(/(?:[.;]\s*)?\b(?:available|avl|current|closing)\s+(?:a\/?c\s+)?bal(?:ance)?\b[\s\S]*$/i, '')
        .replace(/(?:[.;]\s*)?\b(?:if\s+(?:this\s+was\s+)?not\s+you|not\s+you\??|report\s+(?:this|fraud)|call\s+(?:the\s+)?bank|never\s+share\s+(?:your\s+)?(?:otp|pin|cvv))\b[\s\S]*$/i, '')
        .replace(/(?:[.;]\s*)?\b(?:get|earn|claim|enjoy)\b[\s\S]{0,80}\b(?:cashback|offer|discount|reward)\b[\s\S]*$/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 750);
}

function computeSignature(secret, timestamp, nonce, rawBody) {
    return crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${nonce}.`)
        .update(rawBody)
        .digest('hex');
}

function deriveStorageKey(secret) {
    return crypto.createHash('sha256').update(`sms-budget-store:${secret}`).digest();
}

function encryptStoredSmsRecord(record, secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveStorageKey(secret), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    return {
        v: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64')
    };
}

function decryptStoredSmsRecord(envelope, secret) {
    if (!envelope || envelope.v !== 1) return envelope;
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        deriveStorageKey(secret),
        Buffer.from(envelope.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final()
    ]).toString('utf8');
    return JSON.parse(plaintext);
}

function monthWindowFromKey(monthKey) {
    const match = String(monthKey || '').match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return {
        startMs: Date.UTC(year, month - 1, 1) - IST_OFFSET_MS,
        endMs: Date.UTC(year, month, 1) - IST_OFFSET_MS
    };
}

function normalizeScanMetadata(payload, currentTime = Date.now()) {
    const scan = payload?.scan;
    if (!scan) return null;
    if (Number(payload.schemaVersion) < 2) throw new Error('scan metadata requires schemaVersion 2 or newer');
    const id = String(scan.id || scan.scanId || '').trim();
    const monthKey = String(scan.monthKey || scan.month_key || '').trim();
    const window = monthWindowFromKey(monthKey);
    const fromMs = Number(scan.from ?? scan.fromMs ?? scan.from_ms);
    const throughMs = Number(scan.through ?? scan.throughMs ?? scan.through_ms);
    const inboxMessageCount = Number(scan.inboxMessageCount ?? scan.inbox_message_count);
    const transactionCandidateCount = Number(scan.transactionCandidateCount ?? scan.transaction_candidate_count);
    const complete = scan.complete === true;

    if (!/^[A-Za-z0-9_-]{12,128}$/.test(id)) throw new Error('scan.id is invalid');
    if (!window) throw new Error('scan.monthKey must use YYYY-MM');
    if (!Number.isFinite(fromMs) || Math.abs(fromMs - window.startMs) > 60 * 1000) {
        throw new Error('scan.from must be the start of scan.monthKey in Asia/Kolkata');
    }
    if (!Number.isFinite(throughMs) || throughMs < fromMs || throughMs > currentTime + DEFAULT_CLOCK_SKEW_MS) {
        throw new Error('scan.through is invalid');
    }
    if (!Number.isInteger(inboxMessageCount) || inboxMessageCount < 0 || inboxMessageCount > 1000000) {
        throw new Error('scan.inboxMessageCount is invalid');
    }
    if (!Number.isInteger(transactionCandidateCount) || transactionCandidateCount < 0 || transactionCandidateCount > inboxMessageCount) {
        throw new Error('scan.transactionCandidateCount is invalid');
    }
    return { id, monthKey, fromMs, throughMs, inboxMessageCount, transactionCandidateCount, complete };
}

function loadSmsScanState(scanStatePath) {
    if (!scanStatePath || !fs.existsSync(scanStatePath)) return { version: 1, scans: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(scanStatePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { version: 1, scans: {} };
        return { version: 1, scans: parsed.scans && typeof parsed.scans === 'object' ? parsed.scans : {} };
    } catch (_) {
        return { version: 1, scans: {} };
    }
}

function writeSmsScanState(scanStatePath, state) {
    fs.mkdirSync(path.dirname(scanStatePath), { recursive: true });
    const temporaryPath = `${scanStatePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
        fs.renameSync(temporaryPath, scanStatePath);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    }
}

function recordCompleteSmsScan({ scanStatePath, deviceId, scan, completedAt = new Date() }) {
    if (!scanStatePath || !scan?.complete) return false;
    const state = loadSmsScanState(scanStatePath);
    const deviceIdHash = crypto.createHash('sha256').update(String(deviceId || 'android')).digest('hex').slice(0, 24);
    const key = `${deviceIdHash}:${scan.monthKey}`;
    state.scans[key] = {
        deviceIdHash,
        monthKey: scan.monthKey,
        scanIdHash: crypto.createHash('sha256').update(scan.id).digest('hex').slice(0, 24),
        fromMs: scan.fromMs,
        throughMs: scan.throughMs,
        inboxMessageCount: scan.inboxMessageCount,
        transactionCandidateCount: scan.transactionCandidateCount,
        completedAt: completedAt.toISOString()
    };
    const retained = Object.entries(state.scans)
        .sort((left, right) => new Date(right[1]?.completedAt || 0) - new Date(left[1]?.completedAt || 0))
        .slice(0, 24);
    state.scans = Object.fromEntries(retained);
    writeSmsScanState(scanStatePath, state);
    return true;
}

function getCompleteSmsScanCoverage({
    scanStatePath,
    window,
    now = new Date(),
    maxAgeMs = DEFAULT_SCAN_FRESHNESS_MS
}) {
    if (!scanStatePath || !fs.existsSync(scanStatePath)) {
        return { complete: false, reason: 'missing_scan_state', scan: null };
    }
    const state = loadSmsScanState(scanStatePath);
    const scans = Object.values(state.scans || {}).filter(scan => scan?.monthKey === window.monthKey);
    if (scans.length === 0) return { complete: false, reason: 'month_not_scanned', scan: null };
    const fullScans = scans.filter(scan => Number(scan.fromMs) <= window.startMs + 60 * 1000);
    if (fullScans.length === 0) return { complete: false, reason: 'scan_did_not_start_at_month_boundary', scan: null };
    const targetThroughMs = Math.min(now.getTime(), window.endMs);
    const sufficientlyCurrent = fullScans
        .filter(scan => Number(scan.throughMs) >= targetThroughMs - maxAgeMs)
        .sort((left, right) => Number(right.throughMs) - Number(left.throughMs));
    if (sufficientlyCurrent.length === 0) {
        const latest = [...fullScans].sort((left, right) => Number(right.throughMs) - Number(left.throughMs))[0];
        return { complete: false, reason: 'scan_is_stale', scan: latest || null };
    }
    return { complete: true, reason: 'complete', scan: sufficientlyCurrent[0] };
}

function safeEqual(left, right) {
    try {
        const leftBuffer = Buffer.from(String(left || ''), 'hex');
        const rightBuffer = Buffer.from(String(right || ''), 'hex');
        return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
    } catch (_) {
        return false;
    }
}

function verifySignedRequest({ secret, timestamp, nonce, signature, rawBody, now = Date.now(), maxClockSkewMs = DEFAULT_CLOCK_SKEW_MS }) {
    const numericTimestamp = Number(timestamp);
    if (!secret || !Number.isFinite(numericTimestamp) || Math.abs(now - numericTimestamp) > maxClockSkewMs) return false;
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(String(nonce || ''))) return false;
    const expected = computeSignature(secret, timestamp, nonce, rawBody);
    return safeEqual(expected, signature);
}

function computeSmsTransactionFingerprint({ sender, occurredAt, occurred_at: occurredAtSnake, timestamp, body } = {}) {
    const normalizedOccurredAt = new Date(occurredAt || occurredAtSnake || timestamp);
    if (!Number.isFinite(normalizedOccurredAt.getTime())) return null;
    const normalizedSender = String(sender || 'Unknown')
        .trim()
        .replace(/[^A-Za-z0-9+_-]/g, '')
        .slice(0, 40)
        .toUpperCase() || 'UNKNOWN';
    const normalizedBody = minimizeTransactionSmsBody(body);
    if (!normalizedBody) return null;
    return crypto.createHash('sha256')
        .update(`sms-transaction-v1\0${normalizedSender}\0${normalizedOccurredAt.toISOString()}\0${normalizedBody}`)
        .digest('hex');
}

function loadKnownRecords(storePath, secret) {
    const ids = new Set();
    const fingerprints = new Set();
    if (!fs.existsSync(storePath)) return { ids, fingerprints };
    for (const line of fs.readFileSync(storePath, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        try {
            const record = decryptStoredSmsRecord(JSON.parse(line), secret);
            if (record.id) ids.add(record.id);
            const fingerprint = record.fingerprint || computeSmsTransactionFingerprint(record);
            if (fingerprint) fingerprints.add(fingerprint);
        } catch (_) {
            // Malformed historical lines are ignored and surfaced by the report reader.
        }
    }
    return { ids, fingerprints };
}

function normalizeIncomingSms(message, deviceId) {
    const rawSender = String(message?.sender || 'Unknown').trim();
    if (!isLikelyTransactionSms(message?.body, rawSender)) return null;
    const body = minimizeTransactionSmsBody(message?.body);
    if (!body || !isLikelyTransactionSms(body, rawSender)) return null;
    const occurredAt = new Date(message?.occurred_at || message?.occurredAt || message?.timestamp);
    if (!Number.isFinite(occurredAt.getTime())) return null;
    const sender = rawSender.replace(/[^A-Za-z0-9+_-]/g, '').slice(0, 40) || 'Unknown';
    const fingerprint = computeSmsTransactionFingerprint({ sender, occurredAt, body });
    if (!fingerprint) return null;
    return {
        // The companion's device ID changes after a reinstall. Identity must be
        // based on the immutable alert itself so a full-month rescan cannot add
        // the same transaction a second time under a new installation ID.
        id: fingerprint.slice(0, 32),
        fingerprint,
        occurredAt: occurredAt.toISOString(),
        sender,
        body,
        receivedAt: new Date().toISOString(),
        privacyVersion: 2
    };
}

function sendJson(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    response.end(body);
}

function createSmsIngestionServer({
    secret,
    storePath,
    scanStatePath = `${storePath}.scan-state.json`,
    host = '127.0.0.1',
    port = 8787,
    tlsKeyPath = null,
    tlsCertPath = null,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    now = () => Date.now()
}) {
    if (!secret || String(secret).length < 32) throw new Error('SMS ingestion secret must contain at least 32 characters.');
    if (!storePath) throw new Error('SMS ingestion storePath is required.');

    const absoluteStorePath = path.resolve(storePath);
    fs.mkdirSync(path.dirname(absoluteStorePath), { recursive: true });
    const knownRecords = loadKnownRecords(absoluteStorePath, secret);
    const recentNonces = new Map();

    const handler = (request, response) => {
        if (request.method === 'GET' && request.url === '/health') {
            sendJson(response, 200, { ok: true, service: 'sms-ingestion' });
            return;
        }
        if (request.method !== 'POST' || request.url !== '/v1/sms/transactions') {
            sendJson(response, 404, { ok: false, error: 'not_found' });
            return;
        }

        if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] || ''))) {
            sendJson(response, 415, { ok: false, error: 'content_type_must_be_application_json' });
            request.resume();
            return;
        }

        const chunks = [];
        let byteCount = 0;
        request.on('data', chunk => {
            byteCount += chunk.length;
            if (byteCount > maxBodyBytes) {
                sendJson(response, 413, { ok: false, error: 'payload_too_large' });
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (response.writableEnded) return;
            const rawBody = Buffer.concat(chunks);
            const timestamp = request.headers['x-budget-timestamp'];
            const nonce = request.headers['x-budget-nonce'];
            const signature = request.headers['x-budget-signature'];
            const currentTime = now();
            for (const [savedNonce, savedAt] of recentNonces) {
                if (currentTime - savedAt > DEFAULT_CLOCK_SKEW_MS) recentNonces.delete(savedNonce);
            }
            if (recentNonces.has(nonce) || !verifySignedRequest({ secret, timestamp, nonce, signature, rawBody, now: currentTime })) {
                sendJson(response, 401, { ok: false, error: 'invalid_signature' });
                return;
            }
            recentNonces.set(nonce, currentTime);

            let payload;
            try {
                payload = JSON.parse(rawBody.toString('utf8'));
            } catch (_) {
                sendJson(response, 400, { ok: false, error: 'invalid_json' });
                return;
            }
            const deviceId = String(payload.device_id || payload.deviceId || 'android').slice(0, 100);
            if (!Array.isArray(payload.messages)) {
                sendJson(response, 400, { ok: false, error: 'messages_must_be_an_array' });
                return;
            }
            if (payload.messages.length > MAX_MESSAGES_PER_REQUEST) {
                sendJson(response, 413, { ok: false, error: 'too_many_messages', maximum: MAX_MESSAGES_PER_REQUEST });
                return;
            }
            let scan = null;
            try {
                scan = normalizeScanMetadata(payload, currentTime);
            } catch (error) {
                sendJson(response, 400, { ok: false, error: 'invalid_scan_metadata', detail: error.message });
                return;
            }
            if (scan?.complete && payload.messages.length !== 0) {
                sendJson(response, 400, { ok: false, error: 'complete_scan_checkpoint_must_have_empty_messages' });
                return;
            }
            const messages = payload.messages;
            const accepted = [];
            const duplicateIds = [];
            let filtered = 0;
            for (const message of messages) {
                const record = normalizeIncomingSms(message, deviceId);
                if (!record) {
                    filtered += 1;
                    continue;
                }
                if (knownRecords.ids.has(record.id) || knownRecords.fingerprints.has(record.fingerprint)) {
                    duplicateIds.push(record.id);
                    continue;
                }
                knownRecords.ids.add(record.id);
                knownRecords.fingerprints.add(record.fingerprint);
                accepted.push(record);
            }
            if (accepted.length > 0) {
                fs.appendFileSync(
                    absoluteStorePath,
                    accepted.map(record => JSON.stringify(encryptStoredSmsRecord(record, secret))).join('\n') + '\n',
                    'utf8'
                );
            }
            const scanRecorded = scan?.complete
                ? recordCompleteSmsScan({ scanStatePath, deviceId, scan, completedAt: new Date(currentTime) })
                : false;
            sendJson(response, 200, {
                ok: true,
                accepted: accepted.length,
                accepted_ids: accepted.map(record => record.id),
                filtered,
                duplicates: duplicateIds.length,
                duplicate_ids: duplicateIds,
                scan_recorded: scanRecorded
            });
        });
        request.on('error', error => {
            if (!response.writableEnded) sendJson(response, 400, { ok: false, error: error.message || 'request_error' });
        });
    };

    let server;
    if (tlsKeyPath && tlsCertPath) {
        server = https.createServer({
            key: fs.readFileSync(tlsKeyPath),
            cert: fs.readFileSync(tlsCertPath)
        }, handler);
    } else {
        server = http.createServer(handler);
    }

    return {
        server,
        protocol: tlsKeyPath && tlsCertPath ? 'https' : 'http',
        listen: () => new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => {
                server.removeListener('error', reject);
                resolve(server.address());
            });
        }),
        close: () => new Promise(resolve => server.close(() => resolve()))
    };
}

module.exports = {
    MAX_MESSAGES_PER_REQUEST,
    DEFAULT_SCAN_FRESHNESS_MS,
    isLikelyTransactionSms,
    hasSettledTransactionEvidence,
    isPersonalSmsSender,
    sanitizeSmsBody,
    minimizeTransactionSmsBody,
    computeSignature,
    encryptStoredSmsRecord,
    decryptStoredSmsRecord,
    normalizeScanMetadata,
    loadSmsScanState,
    recordCompleteSmsScan,
    getCompleteSmsScanCoverage,
    verifySignedRequest,
    computeSmsTransactionFingerprint,
    normalizeIncomingSms,
    createSmsIngestionServer
};
