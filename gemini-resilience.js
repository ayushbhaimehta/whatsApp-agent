function getGeminiErrorStatus(error) {
    const directStatus = Number(error?.status);
    if (Number.isFinite(directStatus) && directStatus > 0) return directStatus;

    const message = String(error?.message || error || '');
    const match = message.match(/(?:^|\D)(4\d{2}|5\d{2})(?:\D|$)/);
    return match ? Number(match[1]) : null;
}

function canTryAnotherGeminiModel(error) {
    const status = getGeminiErrorStatus(error);
    if ([404, 408, 409, 429, 500, 502, 503, 504].includes(status)) return true;

    return /high demand|temporar(?:y|ily)|unavailable|overload|timeout|timed out|network|fetch failed|model.+not found/i
        .test(String(error?.message || error || ''));
}

function isGeminiHardQuotaExhaustion(error) {
    return /(?:requestsperday|perdayperproject|daily (?:request )?(?:quota|limit)|quotaId[^\n]*PerDay)/i
        .test(String(error?.message || error || ''));
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function generateWithGeminiFallback({
    models,
    contents,
    operation = 'Gemini request',
    attemptsPerModel = 2,
    initialDelayMs = 1000,
    waitFn = wait,
    logger = console
}) {
    if (!Array.isArray(models) || models.length === 0) {
        throw new Error(`${operation} has no configured Gemini models.`);
    }

    let lastError;
    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
        const entry = models[modelIndex];
        const model = entry?.model || entry;
        const modelName = entry?.name || `model-${modelIndex + 1}`;

        for (let attempt = 1; attempt <= attemptsPerModel; attempt += 1) {
            try {
                const response = await model.generateContent(contents);
                if (modelIndex > 0 || attempt > 1) {
                    logger.info(`Gemini ${operation} succeeded with ${modelName} on attempt ${attempt}.`);
                }
                return { response, modelName };
            } catch (error) {
                lastError = error;
                const eligibleForFailover = canTryAnotherGeminiModel(error);
                const canRetryCurrent = eligibleForFailover && !isGeminiHardQuotaExhaustion(error) && attempt < attemptsPerModel;
                const canUseFallback = eligibleForFailover && modelIndex < models.length - 1;

                logger.warn(
                    `Gemini ${operation} failed with ${modelName} ` +
                    `(attempt ${attempt}/${attemptsPerModel}, status ${getGeminiErrorStatus(error) || 'unknown'}): ` +
                    `${error?.message || error}`
                );

                if (canRetryCurrent) {
                    await waitFn(initialDelayMs * (2 ** (attempt - 1)));
                    continue;
                }
                if (canUseFallback) break;
                throw error;
            }
        }
    }

    throw lastError || new Error(`${operation} failed without a Gemini response.`);
}

module.exports = {
    getGeminiErrorStatus,
    canTryAnotherGeminiModel,
    isGeminiHardQuotaExhaustion,
    generateWithGeminiFallback
};
