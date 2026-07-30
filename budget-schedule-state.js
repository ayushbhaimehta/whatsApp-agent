const fs = require('fs');
const path = require('path');

const TIME_ZONE = 'Asia/Kolkata';
const DEFAULT_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

function getIstScheduleSnapshot(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return {
        monthKey: `${values.year}-${values.month}`,
        day: Number(values.day),
        hour: Number(values.hour),
        minute: Number(values.minute)
    };
}

function hasMonthlySchedulePassed(now = new Date(), { day = 26, hour = 18, minute = 0 } = {}) {
    const current = getIstScheduleSnapshot(now);
    if (current.day !== day) return current.day > day;
    if (current.hour !== hour) return current.hour > hour;
    return current.minute >= minute;
}

function readBudgetScheduleState(statePath) {
    if (!statePath || !fs.existsSync(statePath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function writeBudgetScheduleState(statePath, state) {
    if (!statePath) throw new Error('Budget schedule state path is required.');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
    try {
        fs.renameSync(temporaryPath, statePath);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    }
}

function initializeBudgetScheduleState(statePath, now = new Date(), { allowInitialCatchUp = false } = {}) {
    const existing = readBudgetScheduleState(statePath);
    if (existing !== null) return { created: false, state: existing };
    const snapshot = getIstScheduleSnapshot(now);
    const state = {
        version: 1,
        initializedAt: now.toISOString(),
        initializedMonth: snapshot.monthKey,
        skipCatchUpMonth: !allowInitialCatchUp && hasMonthlySchedulePassed(now) ? snapshot.monthKey : null
    };
    writeBudgetScheduleState(statePath, state);
    return { created: true, state };
}

function claimScheduledBudgetRun({
    statePath,
    now = new Date(),
    retryAfterMs = DEFAULT_RETRY_AFTER_MS
}) {
    const snapshot = getIstScheduleSnapshot(now);
    const state = readBudgetScheduleState(statePath) || {};
    if (!hasMonthlySchedulePassed(now)) return { claimed: false, reason: 'before_schedule', monthKey: snapshot.monthKey };
    if (state.skipCatchUpMonth === snapshot.monthKey) {
        return { claimed: false, reason: 'initial_month_suppressed', monthKey: snapshot.monthKey };
    }
    if (state.lastCompletedMonth === snapshot.monthKey) {
        return { claimed: false, reason: 'already_completed', monthKey: snapshot.monthKey };
    }
    const attemptedAt = state.lastAttemptedMonth === snapshot.monthKey
        ? new Date(state.lastAttemptedAt || 0).getTime()
        : 0;
    if (Number.isFinite(attemptedAt) && attemptedAt > 0 && now.getTime() - attemptedAt < retryAfterMs) {
        return { claimed: false, reason: 'retry_wait', monthKey: snapshot.monthKey };
    }

    const nextState = {
        ...state,
        version: 1,
        lastAttemptedMonth: snapshot.monthKey,
        lastAttemptedAt: now.toISOString()
    };
    writeBudgetScheduleState(statePath, nextState);
    return { claimed: true, reason: 'claimed', monthKey: snapshot.monthKey };
}

function markScheduledBudgetRunComplete(statePath, now = new Date(), monthKey = null) {
    const snapshot = getIstScheduleSnapshot(now);
    const state = readBudgetScheduleState(statePath) || {};
    const nextState = {
        ...state,
        version: 1,
        lastCompletedMonth: monthKey || snapshot.monthKey,
        lastCompletedAt: now.toISOString()
    };
    writeBudgetScheduleState(statePath, nextState);
    return nextState;
}

module.exports = {
    DEFAULT_RETRY_AFTER_MS,
    getIstScheduleSnapshot,
    hasMonthlySchedulePassed,
    readBudgetScheduleState,
    writeBudgetScheduleState,
    initializeBudgetScheduleState,
    claimScheduledBudgetRun,
    markScheduledBudgetRunComplete
};
