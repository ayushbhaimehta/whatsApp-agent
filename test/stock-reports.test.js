const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTickerRequest, parseStockReportRequest, stockHealth } = require('../stock-reports');

test('extracts deliberate stock requests', () => {
    assert.equal(extractTickerRequest('run analysis for AMD'), 'AMD');
    assert.equal(extractTickerRequest('give me a report on MSFT'), 'MSFT');
    assert.equal(extractTickerRequest('stock report tsla'), 'TSLA');
    assert.equal(extractTickerRequest('analyse ticker brk-b'), 'BRK-B');
});

test('does not steal nutrition or ambiguous daily-report messages', () => {
    assert.equal(extractTickerRequest('daily report'), null);
    assert.equal(extractTickerRequest('give me a daily report'), null);
    assert.equal(extractTickerRequest('log 2 rotis'), null);
    const budgetCorrection = "In this budget report I don't want ayush transfers amount added to final net spend";
    assert.equal(extractTickerRequest(budgetCorrection), null);
    assert.equal(parseStockReportRequest(budgetCorrection), null);
});

test('routes generic stock-report language to the complete configured batch', () => {
    for (const request of [
        'stock report',
        'Stock report of the day',
        "today's stock report",
        'give me the overall stock report',
        'run reports for all stocks',
        'complete stock report list'
    ]) {
        assert.deepEqual(parseStockReportRequest(request), { scope: 'all', ticker: null });
    }
    assert.equal(extractTickerRequest('Stock report of the day'), null);
});

test('keeps an explicit single ticker as a single-report request', () => {
    assert.deepEqual(parseStockReportRequest('stock report AMD'), { scope: 'ticker', ticker: 'AMD' });
    assert.deepEqual(parseStockReportRequest('give me a report on MSFT'), { scope: 'ticker', ticker: 'MSFT' });
    assert.deepEqual(parseStockReportRequest('stock report of the day for NVDA'), { scope: 'ticker', ticker: 'NVDA' });
});

test('never treats generated stock captions or status words as new ticker requests', () => {
    for (const response of [
        '📦 *Complete stock reports ready*\n\n14 completed, 0 failed.',
        'ðŸ“¦ *Complete stock reports ready*\n\n14 completed, 0 failed.',
        '📈 *Stock report status*\n\nQueued AMD.',
        '📈 *Stock report failed: STATUS*\n\nNo report generated.',
        '📦 *Scheduled stock reports ready*\n\nBatch complete.'
    ]) {
        assert.equal(extractTickerRequest(response), null);
        assert.equal(parseStockReportRequest(response), null);
    }
});

test('finds a usable Python 3 report engine', () => {
    const health = stockHealth();
    assert.match(health.python, /python|py/i);
    assert.match(health.script, /gemini-code\.py$/i);
});
