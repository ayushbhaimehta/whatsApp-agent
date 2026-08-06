const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseMonthlyBudgetRequest,
    resolveGeminiAction,
    resolveTextShortcut
} = require('../message-policy');
const {
    BUDGET_REPORT_DELIVERY_OPTIONS,
    assertBudgetChatConfiguration,
    getConfiguredBudgetChatId,
    resolveBudgetRequestDestination,
    assertBudgetDeliveryChatId,
    redactBudgetAuditBody
} = require('../budget-access-policy');

const CHAT_SCOPES = {
    personal: { isCookChat: false, isPrivateChat: true },
    cook: { isCookChat: true, isPrivateChat: false },
    unrelated: { isCookChat: false, isPrivateChat: false }
};

function resolveBudgetFallbackForChat(text, scope) {
    // This mirrors the deliberately narrow fallback in the WhatsApp handler:
    // parsing a budget phrase is never enough to grant access to budget data.
    if (!scope.isPrivateChat) return { action: 'ignore' };
    return parseMonthlyBudgetRequest(text) || { action: 'ignore' };
}

test('Gemini-classified budget requests are authorized only in personal chat', () => {
    const result = {
        intent: 'monthly_budget',
        period: '2026-08',
        items: []
    };

    assert.deepEqual(resolveGeminiAction({
        result,
        ...CHAT_SCOPES.personal,
        canAccessBudget: true
    }), {
        action: 'monthly_budget',
        period: '2026-08'
    });
    assert.deepEqual(resolveGeminiAction({ result, ...CHAT_SCOPES.cook }), { action: 'ignore' });
    assert.deepEqual(resolveGeminiAction({ result, ...CHAT_SCOPES.unrelated }), { action: 'ignore' });
    assert.deepEqual(resolveGeminiAction({
        result,
        ...CHAT_SCOPES.personal,
        canAccessBudget: false
    }), { action: 'ignore' });
});

test('voice-equivalent Gemini budget intent cannot bypass the chat guardrail', () => {
    // Voice notes and text share resolveGeminiAction after Gemini transcription.
    const transcribedVoiceResult = {
        intent: 'monthly_budget',
        period: 'current_month',
        items: []
    };

    assert.equal(
        resolveGeminiAction({
            result: transcribedVoiceResult,
            ...CHAT_SCOPES.personal,
            canAccessBudget: true
        }).action,
        'monthly_budget'
    );
    assert.equal(
        resolveGeminiAction({
            result: transcribedVoiceResult,
            ...CHAT_SCOPES.personal,
            canAccessBudget: false
        }).action,
        'ignore'
    );
    assert.equal(
        resolveGeminiAction({ result: transcribedVoiceResult, ...CHAT_SCOPES.cook }).action,
        'ignore'
    );
    assert.equal(
        resolveGeminiAction({ result: transcribedVoiceResult, ...CHAT_SCOPES.unrelated }).action,
        'ignore'
    );
});

test('deterministic text fallback is also personal-chat-only', () => {
    const requests = [
        ['Budget for this month', 'current_month'],
        ['Show my expense report for August 2026', '2026-08'],
        ['Where did all my money go?', 'current_month']
    ];

    for (const [text, period] of requests) {
        assert.deepEqual(resolveBudgetFallbackForChat(text, CHAT_SCOPES.personal), {
            action: 'monthly_budget',
            period
        });
        assert.deepEqual(resolveBudgetFallbackForChat(text, CHAT_SCOPES.cook), { action: 'ignore' });
        assert.deepEqual(resolveBudgetFallbackForChat(text, CHAT_SCOPES.unrelated), { action: 'ignore' });
    }
});

test('budget is not exposed through the general personal-only shortcut router', () => {
    const parseStockRequest = () => null;
    const extractTicker = () => null;

    for (const isPrivateChat of [true, false]) {
        assert.equal(resolveTextShortcut({
            text: 'Give me my budget for this month',
            isPrivateChat,
            parseStockRequest,
            extractTicker,
            getDefaultMealType: () => 'Dinner'
        }), null);
    }
});

test('meal-price language cannot accidentally open a financial budget report', () => {
    for (const text of [
        'Suggest a budget meal for dinner',
        'Give me a cheap lunch idea',
        'Recommend an inexpensive breakfast recipe'
    ]) {
        assert.equal(parseMonthlyBudgetRequest(text), null);
        assert.notEqual(
            resolveGeminiAction({
                result: { intent: 'suggest_meal', meal_type: 'Dinner', items: [] },
                ...CHAT_SCOPES.personal
            }).action,
            'monthly_budget'
        );
    }
});

test('accepts only configured direct-message JIDs as a budget destination', () => {
    assert.equal(getConfiguredBudgetChatId('919000000001@c.us'), '919000000001@c.us');
    assert.equal(getConfiguredBudgetChatId('123456789012345@lid'), '123456789012345@lid');

    for (const unsafeId of [
        undefined,
        null,
        '',
        '919000000001',
        '120000000000001@g.us',
        'newsletter@newsletter',
        'not-a-whatsapp-id'
    ]) {
        assert.equal(getConfiguredBudgetChatId(unsafeId), null);
    }
});

test('an on-demand budget request resolves only after the origin matched PERSONAL_CHAT_ID', () => {
    const personalChatId = '919000000001@c.us';

    assert.equal(resolveBudgetRequestDestination({
        isConfiguredPersonalChat: true,
        personalChatId
    }), personalChatId);
    assert.equal(resolveBudgetRequestDestination({
        isConfiguredPersonalChat: false,
        personalChatId
    }), null);
    assert.equal(resolveBudgetRequestDestination({
        isConfiguredPersonalChat: true,
        personalChatId: '120000000000001@g.us'
    }), null);
});

test('the budget delivery boundary rejects an arbitrary or cook-chat destination', () => {
    const personalChatId = '919000000001@c.us';

    assert.equal(assertBudgetDeliveryChatId({
        personalChatId,
        requestedChatId: personalChatId
    }), personalChatId);
    assert.throws(() => assertBudgetDeliveryChatId({
        personalChatId,
        requestedChatId: '120000000000002@g.us'
    }), error => error.code === 'BUDGET_CHAT_FORBIDDEN');
    assert.throws(() => assertBudgetDeliveryChatId({
        personalChatId,
        requestedChatId: '919876543210@c.us'
    }), error => error.code === 'BUDGET_CHAT_FORBIDDEN');

    // WhatsApp may expose the same account as a phone JID or a linked-device
    // JID. Matching the numeric identity is safe; a different number is not.
    assert.equal(assertBudgetDeliveryChatId({
        personalChatId,
        requestedChatId: '919000000001@lid'
    }), personalChatId);
});

test('scheduled delivery requires the same explicit configured personal chat', () => {
    const personalChatId = '123456789012345@lid';

    assert.equal(assertBudgetDeliveryChatId({
        personalChatId,
        requestedChatId: personalChatId
    }), personalChatId);
    assert.throws(() => assertBudgetDeliveryChatId({
        personalChatId: '',
        requestedChatId: personalChatId
    }), error => error.code === 'BUDGET_PERSONAL_CHAT_REQUIRED');
    assert.throws(() => assertBudgetDeliveryChatId({
        personalChatId: '120000000000001@g.us',
        requestedChatId: '120000000000001@g.us'
    }), error => error.code === 'BUDGET_PERSONAL_CHAT_REQUIRED');
});

test('budget reports can be attached privately but never receive a public report link', () => {
    assert.equal(BUDGET_REPORT_DELIVERY_OPTIONS.allowPublicLink, false);
    assert.equal(Object.isFrozen(BUDGET_REPORT_DELIVERY_OPTIONS), true);
});

test('budget audit output is redacted while ordinary messages remain useful', () => {
    assert.equal(
        redactBudgetAuditBody('💰 *Monthly Budget Report — August 2026*\nNet spend: ₹42,000', { fromMe: true }),
        '[REDACTED: private budget response]'
    );
    assert.equal(
        redactBudgetAuditBody('💰 *Budget report status*\nCollecting transaction data', { fromMe: true }),
        '[REDACTED: private budget response]'
    );
    assert.equal(
        redactBudgetAuditBody('💰 *Scheduled budget report failed*\nPrivate provider detail', { fromMe: true }),
        '[REDACTED: private budget response]'
    );
    assert.equal(
        redactBudgetAuditBody('Make two servings of poha', { fromMe: true }),
        'Make two servings of poha'
    );
});

test('configuration rejects using the same direct identity for cook and personal access', () => {
    assert.equal(assertBudgetChatConfiguration({
        personalChatId: '919000000001@c.us',
        cookChatId: '120000000000002@g.us'
    }), '919000000001@c.us');

    assert.throws(() => assertBudgetChatConfiguration({
        personalChatId: '919000000001@c.us',
        cookChatId: '919000000001@lid'
    }), error => error.code === 'BUDGET_CHAT_CONFIGURATION_CONFLICT');
});
