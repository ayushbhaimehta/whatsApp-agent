const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    MAX_MESSAGES_PER_REQUEST,
    isLikelyTransactionSms,
    sanitizeSmsBody,
    computeSignature,
    verifySignedRequest,
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
    assert.equal(isLikelyTransactionSms('Get cashback of INR 500 when you shop today'), false);
    assert.equal(isLikelyTransactionSms('INR 500 debited from A/c XX1234 at ZEPTO'), true);
    assert.equal(isLikelyTransactionSms('hello, are we meeting today?'), false);
    assert.equal(isLikelyTransactionSms('Available balance is INR 50,000 in your account'), false);
    assert.equal(isLikelyTransactionSms('Credit card bill payment of INR 5,000 was received successfully'), false);
    assert.equal(isLikelyTransactionSms('INR 5,000 transferred to your own account'), false);
});

test('redacts secrets and long references before storage', () => {
    const sanitized = sanitizeSmsBody('OTP is 123456. Ref 1234 5678 9012. Paid INR 10 to ayush.name@okaxis, phone +91 98765 43210.');
    assert.doesNotMatch(sanitized, /123456|1234 5678 9012|ayush\.name@okaxis|98765 43210/);
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
            { id: '2', occurred_at: '2026-07-20T10:01:00Z', sender: 'FRIEND', body: 'See you at 5' }
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
        assert.equal(response.body.filtered, 1);
        const envelope = JSON.parse(fs.readFileSync(storePath, 'utf8').trim());
        assert.equal(envelope.v, 1);
        assert.equal(decryptStoredSmsRecord(envelope, secret).body, 'INR 500 debited at ZEPTO');
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
