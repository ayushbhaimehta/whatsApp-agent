const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    MAX_MESSAGES_PER_REQUEST,
    isLikelyTransactionSms,
    isPersonalSmsSender,
    sanitizeSmsBody,
    minimizeTransactionSmsBody,
    computeSignature,
    computeSmsTransactionFingerprint,
    verifySignedRequest,
    normalizeIncomingSms,
    createSmsIngestionServer,
    decryptStoredSmsRecord,
    getCompleteSmsScanCoverage
} = require('../sms-ingestion');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function monthWindow(monthKey) {
    const [year, month] = monthKey.split('-').map(Number);
    return {
        monthKey,
        startMs: Date.UTC(year, month - 1, 1) - IST_OFFSET_MS,
        endMs: Date.UTC(year, month, 1) - IST_OFFSET_MS
    };
}

let nonceCounter = 0;
function postJson({ address, secret, value, contentType = 'application/json', timestamp = Date.now() }) {
    const payload = Buffer.from(JSON.stringify(value));
    const nonce = `test_nonce_${timestamp}_${++nonceCounter}`;
    const signature = computeSignature(secret, timestamp, nonce, payload);
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1',
            port: address.port,
            path: '/v1/sms/transactions',
            method: 'POST',
            headers: {
                'content-type': contentType,
                'content-length': payload.length,
                'x-budget-timestamp': timestamp,
                'x-budget-nonce': nonce,
                'x-budget-signature': signature
            }
        }, result => {
            const chunks = [];
            result.on('data', chunk => chunks.push(chunk));
            result.on('end', () => resolve({
                status: result.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
            }));
        });
        request.on('error', reject);
        request.end(payload);
    });
}

test('filters OTP and personal/promotional messages on the server as defense in depth', () => {
    assert.equal(isLikelyTransactionSms('OTP 123456 for transaction of INR 500'), false);
    assert.equal(isLikelyTransactionSms('Your OTP for an INR 500 transaction is 123456'), false);
    assert.equal(isLikelyTransactionSms('Get cashback of INR 500 when you shop today'), false);
    assert.equal(isLikelyTransactionSms('INR 500 debited from A/c XX1234 at ZEPTO', 'AX-HDFCBK'), true);
    assert.equal(isLikelyTransactionSms('UPI payment of INR 500 to Fresh Foods was successful', 'VM-ICICI'), true);
    assert.equal(isLikelyTransactionSms('hello, are we meeting today?'), false);
    assert.equal(isLikelyTransactionSms('Please pay INR 500 to the electricity account'), false);
    assert.equal(isLikelyTransactionSms('UPI collect request for INR 500 is pending'), false);
    assert.equal(isLikelyTransactionSms('Available balance is INR 50,000 in your account'), false);
    assert.equal(isLikelyTransactionSms('Statement generated for INR 50,000'), false);
    assert.equal(isLikelyTransactionSms('Credit card bill payment of INR 5,000 was received successfully'), false);
    assert.equal(isLikelyTransactionSms('INR 5,000 transferred to your own account'), false);
    assert.equal(isLikelyTransactionSms('I paid INR 500 for dinner', '+91 98765 43210'), false);
    assert.equal(isLikelyTransactionSms('I paid INR 500 for dinner', '[phone]'), false);
    assert.equal(isLikelyTransactionSms('INR 500 debited at ZEPTO', ''), false);
    assert.equal(isLikelyTransactionSms('INR 500 debited at ZEPTO', 'Unknown'), false);
    assert.equal(isLikelyTransactionSms('I paid INR 500 for dinner, send me your half', 'FRIEND'), false);
    assert.equal(isLikelyTransactionSms('We sent INR 500 cashback for being a valued customer', 'PAYAPP'), false);
    assert.equal(isLikelyTransactionSms('We paid INR 500 cashback to selected customers', 'PAYAPP'), false);
    assert.equal(isPersonalSmsSender('+91 98765 43210'), true);
    assert.equal(isPersonalSmsSender('[phone]'), true);
    assert.equal(isPersonalSmsSender('AX-HDFCBK'), false);
});

test('redacts secrets and long references before storage', () => {
    const sanitized = sanitizeSmsBody('OTP is 123456. Ref 1234 5678 9012. Paid INR 10 to ayush.name@okaxis, phone +91 98765 43210.');
    assert.doesNotMatch(sanitized, /123456|1234 5678 9012|ayush\.name@okaxis|98765 43210/);
});

test('minimizes accepted transaction text before encrypted storage', () => {
    const minimized = minimizeTransactionSmsBody(
        'INR 500 debited at ZEPTO using card XX123456. Avl Bal INR 50,000. ' +
        'Never share your OTP. Get cashback on your next order.'
    );
    assert.match(minimized, /INR 500 debited at ZEPTO/i);
    assert.doesNotMatch(minimized, /XX123456|50,000|OTP|cashback/i);
    assert.ok(minimized.length <= 750);

    const record = normalizeIncomingSms({
        id: 'tail-test',
        occurred_at: '2026-07-20T10:00:00Z',
        sender: 'AX-HDFCBK',
        body: 'INR 500 debited at ZEPTO. Avl Bal INR 50,000. Never share your OTP.'
    }, 'test-device');
    assert.ok(record, 'a settled bank alert must survive minimization and revalidation');
    assert.equal(record.body, 'INR 500 debited at ZEPTO');
});

test('uses the same stable SMS identity after a companion reinstall', () => {
    const message = {
        id: 'android-row-42',
        occurred_at: '2026-08-04T10:15:00.000Z',
        sender: 'AX-HDFCBK',
        body: 'INR 500 debited at ZEPTO. Avl Bal INR 50,000.'
    };
    const firstInstall = normalizeIncomingSms(message, 'device-before-reinstall');
    const secondInstall = normalizeIncomingSms(message, 'device-after-reinstall');
    assert.ok(firstInstall);
    assert.equal(firstInstall.id, secondInstall.id);
    assert.equal(firstInstall.fingerprint, secondInstall.fingerprint);
    assert.equal(firstInstall.fingerprint, computeSmsTransactionFingerprint(firstInstall));
});

test('rejects a previously stored SMS when it is resent by another companion installation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-cross-install-'));
    const storePath = path.join(directory, 'store.jsonl');
    const secret = 'cross-install-dedupe-secret-at-least-32-characters';
    const message = {
        id: 'row-7',
        occurred_at: '2026-08-04T10:15:00.000Z',
        sender: 'AX-HDFCBK',
        body: 'INR 500 debited at ZEPTO'
    };
    let service = createSmsIngestionServer({ secret, storePath, host: '127.0.0.1', port: 0 });
    try {
        let address = await service.listen();
        const first = await postJson({
            address,
            secret,
            value: { deviceId: 'first-install', messages: [message] }
        });
        assert.equal(first.body.accepted, 1);
        await service.close();

        service = createSmsIngestionServer({ secret, storePath, host: '127.0.0.1', port: 0 });
        address = await service.listen();
        const repeated = await postJson({
            address,
            secret,
            value: { deviceId: 'second-install', messages: [message] }
        });
        assert.equal(repeated.body.accepted, 0);
        assert.equal(repeated.body.duplicates, 1);
        assert.equal(fs.readFileSync(storePath, 'utf8').trim().split(/\r?\n/).length, 1);
    } finally {
        await service.close().catch(() => undefined);
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('verifies timestamped HMAC requests and rejects stale timestamps', () => {
    const secret = 'a-secure-test-secret-that-is-long-enough';
    const body = Buffer.from('{"messages":[]}');
    const timestamp = Date.now();
    const nonce = 'unique_nonce_12345';
    const signature = computeSignature(secret, timestamp, nonce, body);
    assert.equal(verifySignedRequest({ secret, timestamp, nonce, signature, rawBody: body, now: timestamp }), true);
    assert.equal(verifySignedRequest({ secret, timestamp, nonce, signature, rawBody: body, now: timestamp + 10 * 60 * 1000 }), false);
});

test('requires JSON and rejects oversized SMS batches', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-limits-'));
    const storePath = path.join(directory, 'store.jsonl');
    const secret = 'limits-test-secret-that-is-at-least-32-characters';
    const service = createSmsIngestionServer({ secret, storePath, host: '127.0.0.1', port: 0 });
    const address = await service.listen();
    try {
        const wrongType = await postJson({ address, secret, value: { messages: [] }, contentType: 'text/plain' });
        assert.equal(wrongType.status, 415);
        const tooMany = await postJson({
            address,
            secret,
            value: { messages: Array.from({ length: MAX_MESSAGES_PER_REQUEST + 1 }, (_, id) => ({ id })) }
        });
        assert.equal(tooMany.status, 413);
        assert.equal(tooMany.body.maximum, MAX_MESSAGES_PER_REQUEST);
    } finally {
        await service.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('legacy v1 ingestion encrypts candidates but does not satisfy full-scan coverage', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-ingest-'));
    const storePath = path.join(directory, 'store.jsonl');
    const scanStatePath = path.join(directory, 'scan-state.json');
    const secret = 'another-secure-test-secret-long-enough';
    const service = createSmsIngestionServer({ secret, storePath, scanStatePath, host: '127.0.0.1', port: 0 });
    const address = await service.listen();
    const payload = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        device_id: 'test-device',
        messages: [
            { id: '1', occurred_at: '2026-07-20T10:00:00Z', sender: 'HDFCBK', body: 'INR 500 debited at ZEPTO' },
            { id: '2', occurred_at: '2026-07-20T10:01:00Z', sender: 'FRIEND', body: 'See you at 5' },
            { id: '3', occurred_at: '2026-07-20T10:02:00Z', sender: '+919876543210', body: 'I paid INR 500 for dinner' },
            { id: '4', occurred_at: '2026-07-20T10:03:00Z', sender: 'HDFCBK', body: 'OTP 123456 for transaction of INR 500' },
            { id: '5', occurred_at: '2026-07-20T10:04:00Z', sender: 'ZEPTON', body: 'Get INR 500 cashback when you shop now' },
            { id: '6', occurred_at: '2026-07-20T10:05:00Z', sender: 'HDFCBK', body: 'Available balance is INR 50,000' },
            { id: '7', occurred_at: '2026-07-20T10:06:00Z', sender: 'HDFCCB', body: 'Statement generated. Minimum amount due INR 500' },
            { id: '8', occurred_at: '2026-07-20T10:07:00Z', sender: '[phone]', body: 'I paid INR 500 for dinner' }
        ]
    }));
    const timestamp = Date.now();
    const nonce = 'integration_nonce_123';
    const signature = computeSignature(secret, timestamp, nonce, payload);
    const response = await new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1',
            port: address.port,
            path: '/v1/sms/transactions',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': payload.length,
                'x-budget-timestamp': timestamp,
                'x-budget-nonce': nonce,
                'x-budget-signature': signature
            }
        }, result => {
            const chunks = [];
            result.on('data', chunk => chunks.push(chunk));
            result.on('end', () => resolve({ status: result.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        });
        request.on('error', reject);
        request.end(payload);
    });
    await service.close();
    try {
        assert.equal(response.status, 200);
        assert.equal(response.body.accepted, 1);
        assert.equal(response.body.filtered, 7);
        const envelope = JSON.parse(fs.readFileSync(storePath, 'utf8').trim());
        assert.equal(envelope.v, 1);
        const stored = decryptStoredSmsRecord(envelope, secret);
        assert.equal(stored.body, 'INR 500 debited at ZEPTO');
        assert.equal(stored.privacyVersion, 2);
        assert.doesNotMatch(fs.readFileSync(storePath, 'utf8'), /ZEPTO/);
        assert.deepEqual(
            getCompleteSmsScanCoverage({
                scanStatePath,
                window: monthWindow('2026-07'),
                now: new Date('2026-07-20T10:05:00.000Z')
            }),
            { complete: false, reason: 'missing_scan_state', scan: null }
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('records schema-v2 completed zero-candidate scan as full current-month coverage', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-scan-zero-'));
    const storePath = path.join(directory, 'store.jsonl');
    const scanStatePath = path.join(directory, 'scan-state.json');
    const secret = 'zero-candidate-scan-secret-at-least-32-characters';
    const window = monthWindow('2026-07');
    const throughMs = new Date('2026-07-30T08:00:00.000Z').getTime();
    const service = createSmsIngestionServer({
        secret,
        storePath,
        scanStatePath,
        host: '127.0.0.1',
        port: 0,
        now: () => throughMs
    });
    const address = await service.listen();
    try {
        const response = await postJson({
            address,
            secret,
            timestamp: throughMs,
            value: {
                schemaVersion: 2,
                deviceId: 'test-phone-zero',
                messages: [],
                scan: {
                    id: 'scan_zero_20260730',
                    monthKey: '2026-07',
                    from: window.startMs,
                    through: throughMs,
                    inboxMessageCount: 247,
                    transactionCandidateCount: 0,
                    complete: true
                }
            }
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.accepted, 0);
        assert.equal(response.body.scan_recorded, true);
        assert.equal(fs.existsSync(storePath), false, 'a zero-candidate scan should not create an SMS body store');

        const coverage = getCompleteSmsScanCoverage({
            scanStatePath,
            window,
            now: new Date(throughMs),
            maxAgeMs: 12 * 60 * 60 * 1000
        });
        assert.equal(coverage.complete, true);
        assert.equal(coverage.reason, 'complete');
        assert.equal(coverage.scan.inboxMessageCount, 247);
        assert.equal(coverage.scan.transactionCandidateCount, 0);
    } finally {
        await service.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
