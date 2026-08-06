const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createWhatsAppReadinessWatchdog,
    inspectWhatsAppReadiness,
    normalizePercent
} = require('../whatsapp-readiness');

const quietLogger = { warn() {} };

test('normalizes WhatsApp loading percentages without accepting invalid values', () => {
    assert.equal(normalizePercent(100), 100);
    assert.equal(normalizePercent('99'), 99);
    assert.equal(normalizePercent('invalid'), null);
});

test('reports an unavailable Puppeteer page without throwing', async () => {
    assert.deepEqual(await inspectWhatsAppReadiness({}), {
        pageAvailable: false,
        documentReadyState: null,
        socketState: null,
        hasSynced: false,
        callbackAvailable: false,
        wwebjsInjected: false
    });
});

test('authentication arms read-only diagnostics without synthesizing ready', async () => {
    let probes = 0;
    const watchdog = createWhatsAppReadinessWatchdog({
        isReady: () => false,
        inspect: async () => ({ pageAvailable: true, hasSynced: true, wwebjsInjected: true }),
        onProbe: () => { probes += 1; },
        setTimer: () => 1,
        clearTimer: () => {},
        logger: quietLogger
    });

    watchdog.noteAuthenticated();
    await watchdog.checkNow();

    assert.equal(probes, 1);
    assert.equal(watchdog.getState().armed, true);
});

test('95-to-100-percent loading arms the watchdog', () => {
    const watchdog = createWhatsAppReadinessWatchdog({
        setTimer: () => 1,
        clearTimer: () => {},
        logger: quietLogger
    });

    watchdog.noteLoading(94, 'WhatsApp');
    assert.equal(watchdog.getState().armed, false);
    watchdog.noteLoading('100', 'WhatsApp');
    assert.equal(watchdog.getState().armed, true);
});

test('repeated authenticated events preserve the original deadline', async () => {
    let clock = 5000;
    let stalled;
    let stallCallback;
    const watchdog = createWhatsAppReadinessWatchdog({
        isReady: () => false,
        onStalled: async details => { stalled = details; },
        now: () => clock,
        setTimer: callback => { stallCallback ||= callback; return 1; },
        clearTimer: () => {},
        logger: quietLogger
    });

    watchdog.noteAuthenticated();
    clock = 80000;
    watchdog.noteAuthenticated();
    clock = 125000;
    await stallCallback();

    assert.equal(stalled.reason, 'ready_timeout');
    assert.equal(stalled.elapsedMs, 120000);
    assert.equal(watchdog.getState().stallReported, true);
});

test('ready stop prevents a false restart', async () => {
    let stalledCalls = 0;
    let stallCallback;
    const watchdog = createWhatsAppReadinessWatchdog({
        isReady: () => false,
        onStalled: async () => { stalledCalls += 1; },
        setTimer: callback => { stallCallback ||= callback; return 1; },
        clearTimer: () => {},
        logger: quietLogger
    });

    watchdog.noteAuthenticated();
    watchdog.stop();
    await stallCallback();

    assert.equal(stalledCalls, 0);
    assert.equal(watchdog.getState().stopped, true);
});

test('reset makes the watchdog reusable after an initialization retry', () => {
    const watchdog = createWhatsAppReadinessWatchdog({
        setTimer: () => 1,
        clearTimer: () => {},
        logger: quietLogger
    });

    watchdog.noteAuthenticated();
    watchdog.stop();
    watchdog.reset();
    watchdog.noteAuthenticated();

    assert.equal(watchdog.getState().armed, true);
    assert.equal(watchdog.getState().stopped, false);
});
