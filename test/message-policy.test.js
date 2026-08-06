const test = require('node:test');
const assert = require('node:assert/strict');
const {
    GEMINI_MODEL_NAME,
    GEMINI_FALLBACK_MODEL_NAMES,
    getMessageCacheKey,
    isAgentGeneratedMessageBody,
    normalizeMediaMimeType,
    resolveTextShortcut,
    resolveGeminiAction,
    parseMonthlyBudgetRequest
} = require('../message-policy');
const { extractTickerRequest, parseStockReportRequest } = require('../stock-reports');

const personalShortcut = text => resolveTextShortcut({
    text,
    isPrivateChat: true,
    parseStockRequest: parseStockReportRequest,
    getDefaultMealType: () => 'Dinner'
});

test('uses a current stable Gemini Flash model with a multimodal fallback', () => {
    assert.equal(GEMINI_MODEL_NAME, 'gemini-3.6-flash');
    assert.deepEqual(GEMINI_FALLBACK_MODEL_NAMES, ['gemini-3.5-flash-lite']);
});

test('does not collapse messages whose serialized ID is unavailable', () => {
    assert.equal(getMessageCacheKey({ id: undefined }), null);
    assert.equal(getMessageCacheKey({ id: {} }), null);
    assert.notEqual(
        getMessageCacheKey({ id: { id: 'first', fromMe: true }, to: 'self@lid' }),
        getMessageCacheKey({ id: { id: 'second', fromMe: true }, to: 'self@lid' })
    );
});

test('recognizes formatted agent replies regardless of emoji encoding', () => {
    assert.equal(isAgentGeneratedMessageBody('📦 *Complete stock reports ready*\n\n14 completed, 0 failed.'), true);
    assert.equal(isAgentGeneratedMessageBody('ðŸ“¦ *Complete stock reports ready*\n\n14 completed, 0 failed.'), true);
    assert.equal(isAgentGeneratedMessageBody('📈 *Stock report status*\n\nQueued AMD.'), true);
    assert.equal(isAgentGeneratedMessageBody('*Swiggy order history needs authorization*\n\nBudget reports will continue from SMS.'), true);
    assert.equal(isAgentGeneratedMessageBody('Stock report of the day'), false);
    assert.equal(isAgentGeneratedMessageBody('Macro summary'), false);
});

test('recognizes generated monthly budget replies so self-chat cannot loop', () => {
    assert.equal(isAgentGeneratedMessageBody('💰 *Monthly Budget Report — July 2026*\nNet spend'), true);
    assert.equal(isAgentGeneratedMessageBody('💰 *Budget report status*\nCollecting data'), true);
    assert.equal(isAgentGeneratedMessageBody('💰 *Scheduled budget report failed*\nTemporary error'), true);
});

test('normalizes WhatsApp Opus voice-note MIME types for Gemini', () => {
    assert.equal(normalizeMediaMimeType('audio/ogg; codecs=opus'), 'audio/ogg');
    assert.equal(normalizeMediaMimeType('audio/mp4'), 'audio/mp4');
});

test('routes personal-only shortcuts without Gemini classification', () => {
    assert.deepEqual(personalShortcut('Suggest lunch'), { action: 'suggest_meal', mealType: 'Lunch' });
    assert.deepEqual(personalShortcut('Suggest a meal for breakfast'), { action: 'suggest_meal', mealType: 'Breakfast' });
    assert.deepEqual(personalShortcut('macro summary'), { action: 'summarize_day' });
    assert.deepEqual(personalShortcut('stock report AMD'), { action: 'stock_report', scope: 'ticker', ticker: 'AMD' });
    assert.deepEqual(personalShortcut('stock report of the day'), { action: 'stock_report', scope: 'all', ticker: null });
});

test('does not route summaries, suggestions, or stocks as shortcuts in cook chat', () => {
    for (const text of ['Suggest lunch', 'macro summary', 'stock report AMD']) {
        assert.equal(resolveTextShortcut({
            text,
            isPrivateChat: false,
            extractTicker: extractTickerRequest,
            getDefaultMealType: () => 'Lunch'
        }), null);
    }
});

test('logs bare or prepared food from either configured chat after mocked Gemini analysis', () => {
    const result = {
        intent: 'log_food',
        items: [{ item: 'Poha', quantity: '2 servings (400 g)', meal_type: 'Breakfast' }]
    };
    assert.equal(resolveGeminiAction({ result, isCookChat: true, isPrivateChat: false }).action, 'log_food');
    assert.equal(resolveGeminiAction({ result, isCookChat: false, isPrivateChat: true }).action, 'log_food');
});

test('routes mocked text and voice purchase intent to Google Tasks from either chat', () => {
    const result = { intent: 'add_reminder', items: [{ item: 'milk' }, { item: 'eggs' }] };
    assert.equal(resolveGeminiAction({ result, isCookChat: true, isPrivateChat: false }).action, 'add_reminder');
    assert.equal(resolveGeminiAction({ result, isCookChat: false, isPrivateChat: true }).action, 'add_reminder');
});

test('accepts mocked voice-note food extraction from both configured chats', () => {
    const voiceGeminiResult = {
        intent: 'log_food',
        items: [{ item: 'Paneer', quantity: '1 serving (100 g)', meal_type: 'Lunch' }]
    };
    assert.equal(resolveGeminiAction({ result: voiceGeminiResult, isCookChat: true, isPrivateChat: false }).action, 'log_food');
    assert.equal(resolveGeminiAction({ result: voiceGeminiResult, isCookChat: false, isPrivateChat: true }).action, 'log_food');
});

test('keeps Gemini summary and suggestion intents private-chat-only', () => {
    const summary = { intent: 'summarize_day', items: [] };
    const suggestion = { intent: 'suggest_meal', meal_type: 'Dinner', items: [] };
    assert.equal(resolveGeminiAction({ result: summary, isCookChat: true, isPrivateChat: false }).action, 'ignore');
    assert.equal(resolveGeminiAction({ result: summary, isCookChat: false, isPrivateChat: true }).action, 'summarize_day');
    assert.equal(resolveGeminiAction({ result: suggestion, isCookChat: true, isPrivateChat: false }).action, 'ignore');
    assert.equal(resolveGeminiAction({ result: suggestion, isCookChat: false, isPrivateChat: true }).action, 'suggest_meal');
});

test('keeps Gemini monthly budget intent private-chat-only and preserves period', () => {
    const budget = { intent: 'monthly_budget', period: '2026-07', items: [] };
    assert.deepEqual(resolveGeminiAction({
        result: budget,
        isCookChat: false,
        isPrivateChat: true,
        canAccessBudget: true
    }), {
        action: 'monthly_budget',
        period: '2026-07'
    });
    assert.equal(resolveGeminiAction({
        result: budget,
        isCookChat: false,
        isPrivateChat: true,
        canAccessBudget: false
    }).action, 'ignore');
    assert.equal(resolveGeminiAction({ result: budget, isCookChat: true, isPrivateChat: false }).action, 'ignore');
});

test('provides a narrow monthly-budget fallback only after Gemini is unavailable', () => {
    assert.deepEqual(parseMonthlyBudgetRequest('Where did my money go this month?'), {
        action: 'monthly_budget', period: 'current_month'
    });
    assert.deepEqual(parseMonthlyBudgetRequest('Give me the expense report for July 2026'), {
        action: 'monthly_budget', period: '2026-07'
    });
    assert.equal(parseMonthlyBudgetRequest('Suggest a budget meal for dinner'), null);
    assert.equal(parseMonthlyBudgetRequest('Paneer and rice'), null);
});

test('ignores every intent outside the two configured chats', () => {
    const result = { intent: 'log_food', items: [{ item: 'Poha' }] };
    assert.equal(resolveGeminiAction({ result, isCookChat: false, isPrivateChat: false }).action, 'ignore');
});
