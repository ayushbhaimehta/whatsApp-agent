const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    getIstScheduleSnapshot,
    hasMonthlySchedulePassed,
    initializeBudgetScheduleState,
    claimScheduledBudgetRun,
    markScheduledBudgetRunComplete
} = require('../budget-schedule-state');

test('evaluates the monthly deadline in Asia/Kolkata', () => {
    assert.deepEqual(getIstScheduleSnapshot(new Date('2026-08-26T12:29:00Z')), {
        monthKey: '2026-08', day: 26, hour: 17, minute: 59
    });
    assert.equal(hasMonthlySchedulePassed(new Date('2026-08-26T12:29:00Z')), false);
    assert.equal(hasMonthlySchedulePassed(new Date('2026-08-26T12:30:00Z')), true);
});

test('does not unexpectedly send a catch-up report in the installation month', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-state-'));
    const statePath = path.join(directory, 'state.json');
    try {
        const now = new Date('2026-07-30T10:00:00Z');
        assert.equal(initializeBudgetScheduleState(statePath, now).created, true);
        assert.equal(claimScheduledBudgetRun({ statePath, now }).reason, 'initial_month_suppressed');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('claims a missed future-month run once and records completion', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-state-'));
    const statePath = path.join(directory, 'state.json');
    try {
        initializeBudgetScheduleState(statePath, new Date('2026-07-30T10:00:00Z'));
        const august = new Date('2026-08-27T10:00:00Z');
        assert.equal(claimScheduledBudgetRun({ statePath, now: august }).claimed, true);
        assert.equal(claimScheduledBudgetRun({ statePath, now: new Date(august.getTime() + 60_000) }).reason, 'retry_wait');
        markScheduledBudgetRunComplete(statePath, august);
        assert.equal(claimScheduledBudgetRun({ statePath, now: new Date(august.getTime() + 7 * 60 * 60 * 1000) }).reason, 'already_completed');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('permits a retry after a failed attempt cooldown', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-state-'));
    const statePath = path.join(directory, 'state.json');
    try {
        initializeBudgetScheduleState(statePath, new Date('2026-07-20T10:00:00Z'));
        const firstAttempt = new Date('2026-07-26T12:30:00Z');
        assert.equal(claimScheduledBudgetRun({ statePath, now: firstAttempt }).claimed, true);
        const retry = new Date(firstAttempt.getTime() + 6 * 60 * 60 * 1000);
        assert.equal(claimScheduledBudgetRun({ statePath, now: retry }).claimed, true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
