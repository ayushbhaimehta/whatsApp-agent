const test = require('node:test');
const assert = require('node:assert/strict');
const {
    getGeminiErrorStatus,
    canTryAnotherGeminiModel,
    generateWithGeminiFallback,
    isGeminiHardQuotaExhaustion
} = require('../gemini-resilience');

const quietLogger = { info() {}, warn() {} };

test('recognizes Gemini capacity and quota errors as retryable', () => {
    assert.equal(getGeminiErrorStatus({ status: 503 }), 503);
    assert.equal(getGeminiErrorStatus(new Error('request failed with 429 RESOURCE_EXHAUSTED')), 429);
    assert.equal(canTryAnotherGeminiModel({ status: 503 }), true);
    assert.equal(canTryAnotherGeminiModel({ status: 429 }), true);
    assert.equal(canTryAnotherGeminiModel({ status: 400 }), false);
});

test('skips same-model retry for an explicitly exhausted daily quota', async () => {
    const calls = [];
    const dailyQuotaError = Object.assign(new Error('quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier'), { status: 429 });
    assert.equal(isGeminiHardQuotaExhaustion(dailyQuotaError), true);
    const result = await generateWithGeminiFallback({
        models: [
            { name: 'primary', model: { generateContent: async () => { calls.push('primary'); throw dailyQuotaError; } } },
            { name: 'fallback', model: { generateContent: async () => { calls.push('fallback'); return { ok: true }; } } }
        ],
        contents: ['test'],
        attemptsPerModel: 3,
        waitFn: async () => {},
        logger: { warn() {}, info() {} }
    });
    assert.equal(result.modelName, 'fallback');
    assert.deepEqual(calls, ['primary', 'fallback']);
});

test('retries an overloaded primary model and then uses the fallback', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = {
        async generateContent() {
            primaryCalls += 1;
            throw Object.assign(new Error('This model is currently experiencing high demand'), { status: 503 });
        }
    };
    const fallback = {
        async generateContent(contents) {
            fallbackCalls += 1;
            return { response: { text: () => `fallback:${contents[0]}` } };
        }
    };

    const result = await generateWithGeminiFallback({
        models: [
            { name: 'primary', model: primary },
            { name: 'fallback', model: fallback }
        ],
        contents: ['meal prompt'],
        waitFn: async () => {},
        logger: quietLogger
    });

    assert.equal(primaryCalls, 2);
    assert.equal(fallbackCalls, 1);
    assert.equal(result.modelName, 'fallback');
    assert.equal(result.response.response.text(), 'fallback:meal prompt');
});

test('does not hide invalid-request errors by trying unrelated models', async () => {
    let fallbackCalls = 0;
    const invalidRequest = Object.assign(new Error('Invalid prompt'), { status: 400 });

    await assert.rejects(
        generateWithGeminiFallback({
            models: [
                { name: 'primary', model: { generateContent: async () => { throw invalidRequest; } } },
                { name: 'fallback', model: { generateContent: async () => { fallbackCalls += 1; } } }
            ],
            contents: ['bad prompt'],
            waitFn: async () => {},
            logger: quietLogger
        }),
        invalidRequest
    );

    assert.equal(fallbackCalls, 0);
});
