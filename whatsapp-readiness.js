'use strict';

const fs = require('fs');

/**
 * Remove only whatsapp-web.js' disposable HTML/module cache. The linked-device
 * credentials live in a different directory and must never be removed as part
 * of readiness recovery.
 */
function clearWhatsAppWebCache(cachePath, { rmSync = fs.rmSync, mkdirSync = fs.mkdirSync } = {}) {
    const normalizedPath = String(cachePath || '').trim();
    if (!normalizedPath) return false;
    rmSync(normalizedPath, { recursive: true, force: true });
    mkdirSync(normalizedPath, { recursive: true });
    return true;
}

/**
 * Read-only diagnostics for the period between WhatsApp authentication and the
 * real whatsapp-web.js `ready` event. Do not synthesize `ready`: doing so can
 * leave message listeners only partially attached.
 */
async function inspectWhatsAppReadiness(client) {
    const page = client?.pupPage;
    if (!page || typeof page.evaluate !== 'function') {
        return {
            pageAvailable: false,
            documentReadyState: null,
            socketState: null,
            hasSynced: false,
            callbackAvailable: false,
            wwebjsInjected: false,
            webVersion: null
        };
    }

    return page.evaluate(() => {
        const result = {
            pageAvailable: true,
            documentReadyState: document.readyState || null,
            socketState: null,
            hasSynced: false,
            callbackAvailable: typeof window.onAppStateHasSyncedEvent === 'function',
            wwebjsInjected: typeof window.WWebJS !== 'undefined',
            webVersion: window.Debug?.VERSION || null
        };

        try {
            const socket = typeof window.require === 'function'
                ? window.require('WAWebSocketModel')?.Socket
                : null;
            result.socketState = socket?.state || null;
            result.hasSynced = Boolean(socket?.hasSynced);
        } catch (_) {
            // WhatsApp may still be loading its internal module registry.
        }

        return result;
    });
}

function normalizePercent(percent) {
    const parsed = Number(percent);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Bound an authenticated-but-not-ready startup. The pinned whatsapp-web.js
 * dependency owns synchronization and listener injection. This watchdog can
 * request its full, restart-safe injection after the page becomes stable; it
 * never emits or fabricates a ready event itself.
 */
function createWhatsAppReadinessWatchdog({
    client,
    isReady = () => false,
    inspect = () => inspectWhatsAppReadiness(client),
    recover = async () => false,
    onStalled = async () => {},
    onProbe = () => {},
    logger = console,
    probeIntervalMs = 15000,
    stallTimeoutMs = 120000,
    maxRecoveryAttempts = 2,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout
} = {}) {
    let probeTimer = null;
    let stallTimer = null;
    let firstSignalAt = null;
    let lastSignal = null;
    let lastSnapshot = null;
    let checking = false;
    let recoveryAttempts = 0;
    let stopped = false;
    let stallReported = false;

    function clearTimers() {
        if (probeTimer !== null) clearTimer(probeTimer);
        if (stallTimer !== null) clearTimer(stallTimer);
        probeTimer = null;
        stallTimer = null;
    }

    function scheduleProbe() {
        if (stopped || stallReported || isReady() || probeTimer !== null) return;
        probeTimer = setTimer(() => {
            probeTimer = null;
            void checkNow();
        }, probeIntervalMs);
    }

    async function reportStall() {
        if (stopped || stallReported || isReady()) return;
        stallReported = true;
        clearTimers();
        await onStalled({
            reason: 'ready_timeout',
            elapsedMs: firstSignalAt === null ? 0 : Math.max(0, now() - firstSignalAt),
            lastSignal,
            snapshot: lastSnapshot,
            recoveryAttempts
        });
    }

    function arm(source, details = {}) {
        if (stopped || stallReported || isReady()) return;
        const signalTime = now();
        if (firstSignalAt === null) {
            firstSignalAt = signalTime;
            stallTimer = setTimer(() => void reportStall(), stallTimeoutMs);
        }
        lastSignal = { source, details, at: signalTime };
        scheduleProbe();
    }

    async function checkNow() {
        if (checking || stopped || stallReported || isReady() || firstSignalAt === null) return;
        checking = true;
        try {
            try {
                lastSnapshot = await inspect();
                onProbe(lastSnapshot);
            } catch (error) {
                logger.warn?.('Could not inspect WhatsApp synchronization state:', error?.message || error);
            }
            if (
                !isReady()
                && lastSnapshot?.pageAvailable
                && lastSnapshot.documentReadyState === 'complete'
                && lastSnapshot.hasSynced
                && !lastSnapshot.wwebjsInjected
                && recoveryAttempts < maxRecoveryAttempts
            ) {
                recoveryAttempts += 1;
                logger.warn?.(
                    `WhatsApp Web is synchronized but its event layer is missing; ` +
                    `running full reinjection ${recoveryAttempts}/${maxRecoveryAttempts}.`
                );
                try {
                    await recover({ attempt: recoveryAttempts, snapshot: lastSnapshot });
                } catch (error) {
                    logger.error?.('WhatsApp Web reinjection failed:', error?.stack || error?.message || error);
                }
            }
            if (!isReady()) scheduleProbe();
        } finally {
            checking = false;
        }
    }

    function noteAuthenticated() {
        arm('authenticated');
    }

    function noteLoading(percent, message = '') {
        const normalizedPercent = normalizePercent(percent);
        if (normalizedPercent !== null && normalizedPercent >= 95) {
            arm('loading_screen', { percent: normalizedPercent, message });
        }
    }

    function stop() {
        clearTimers();
        stopped = true;
    }

    function reset() {
        clearTimers();
        firstSignalAt = null;
        lastSignal = null;
        lastSnapshot = null;
        checking = false;
        recoveryAttempts = 0;
        stopped = false;
        stallReported = false;
    }

    function getState() {
        return {
            armed: firstSignalAt !== null,
            checking,
            stopped,
            stallReported,
            firstSignalAt,
            lastSignal,
            lastSnapshot,
            recoveryAttempts,
            probeScheduled: probeTimer !== null,
            stallScheduled: stallTimer !== null
        };
    }

    return {
        noteAuthenticated,
        noteLoading,
        checkNow,
        stop,
        reset,
        getState
    };
}

module.exports = {
    clearWhatsAppWebCache,
    createWhatsAppReadinessWatchdog,
    inspectWhatsAppReadiness,
    normalizePercent
};
