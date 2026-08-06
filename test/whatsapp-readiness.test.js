const test = require('node:test');
const assert = require('node:assert/strict');
const {
    clearWhatsAppWebCache,
    createWhatsAppReadinessWatchdog,
    inspectWhatsAppReadiness,
    normalizePercent
} = require('../whatsapp-readiness');

const quietLogger = { warn() {} };

test('clears only the configured disposable WhatsApp web cache', () => {
    const calls = [];
    const cleared = clearWhatsAppWebCache('/data/whatsapp-web-cache', {
        rmSync: (target, options) => calls.push(['remove', target, options]),
        mkdirSync: (target, options) => calls.push(['create', target, options])
    });

    assert.equal(cleared, true);
    assert.deepEqual(calls, [
        ['remove', '/data/whatsapp-web-cache', { recursive: true, force: true }],
        ['create', '/data/whatsapp-web-cache', { recursive: true }]
    ]);
});

test('refuses to clear a cache when no exact path is configured', () => {
    let touched = false;
    const cleared = clearWhatsAppWebCache('  ', {
        rmSync: () => { touched = true; },
        mkdirSync: () => { touched = true; }
    });

    assert.equal(cleared, false);
    assert.equal(touched, false);
});

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
        wwebjsInjected: false,
        webVersion: null
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

test('runs a bounded full reinjection when the synchronized event layer is absent', async () => {
    let recoveries = 0;
    const watchdog = createWhatsAppReadinessWatchdog({
        isReady: () => false,
        inspect: async () => ({
            pageAvailable: true,
            documentReadyState: 'complete',
            socketState: 'CONNECTED',
            hasSynced: true,
            wwebjsInjected: false
        }),
        recover: async () => { recoveries += 1; },
        maxRecoveryAttempts: 1,
        setTimer: () => 1,
        clearTimer: () => {},
        logger: quietLogger
    });

    watchdog.noteAuthenticated();
    await watchdog.checkNow();
    await watchdog.checkNow();

    assert.equal(recoveries, 1);
    assert.equal(watchdog.getState().recoveryAttempts, 1);
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
