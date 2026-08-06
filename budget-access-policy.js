const BUDGET_REPORT_DELIVERY_OPTIONS = Object.freeze({ allowPublicLink: false });

function getConfiguredBudgetChatId(personalChatId) {
    const value = String(personalChatId || '').trim();
    if (!/^\d+@(?:c\.us|lid)$/i.test(value)) return null;
    return value;
}

function sameDirectWhatsAppIdentity(first, second) {
    const firstId = getConfiguredBudgetChatId(first);
    const secondId = getConfiguredBudgetChatId(second);
    if (!firstId || !secondId) return false;
    return firstId.split('@', 1)[0] === secondId.split('@', 1)[0];
}

function assertBudgetChatConfiguration({ personalChatId, cookChatId = null } = {}) {
    const configuredChatId = getConfiguredBudgetChatId(personalChatId);
    if (!configuredChatId) {
        const error = new Error('Budget features are disabled until PERSONAL_CHAT_ID is set to a valid @c.us or @lid direct chat.');
        error.code = 'BUDGET_PERSONAL_CHAT_REQUIRED';
        throw error;
    }
    if (cookChatId && sameDirectWhatsAppIdentity(cookChatId, configuredChatId)) {
        const error = new Error('PERSONAL_CHAT_ID and COOK_CHAT_ID must not identify the same direct chat.');
        error.code = 'BUDGET_CHAT_CONFIGURATION_CONFLICT';
        throw error;
    }
    return configuredChatId;
}

/**
 * Resolve an on-demand budget destination only after the incoming conversation
 * has independently matched the explicitly configured PERSONAL_CHAT_ID.
 * There is intentionally no detected-self fallback for financial data.
 */
function resolveBudgetRequestDestination({ isConfiguredPersonalChat, personalChatId } = {}) {
    if (isConfiguredPersonalChat !== true) return null;
    return getConfiguredBudgetChatId(personalChatId);
}

/**
 * Final sink guard for every budget message/document. A caller cannot redirect
 * financial output to the cook chat, an arbitrary DM, or a group ID.
 */
function assertBudgetDeliveryChatId({ personalChatId, requestedChatId = null } = {}) {
    const configuredChatId = assertBudgetChatConfiguration({ personalChatId });
    if (requestedChatId && !sameDirectWhatsAppIdentity(requestedChatId, configuredChatId)) {
        const error = new Error('Budget output was blocked because the requested destination is not PERSONAL_CHAT_ID.');
        error.code = 'BUDGET_CHAT_FORBIDDEN';
        throw error;
    }
    return configuredChatId;
}

function redactBudgetAuditBody(body, { fromMe = false } = {}) {
    const value = String(body || '').replace(/\s+/g, ' ').trim();
    if (!fromMe) return value.slice(0, 500);
    if (/\*(?:Monthly Budget Report(?:\s+[^*]+)?|Budget report status|Scheduled budget (?:report|catch-up)(?: failed)?)\*/i.test(value)) {
        return '[REDACTED: private budget response]';
    }
    return value.slice(0, 500);
}

module.exports = {
    BUDGET_REPORT_DELIVERY_OPTIONS,
    assertBudgetChatConfiguration,
    assertBudgetDeliveryChatId,
    getConfiguredBudgetChatId,
    redactBudgetAuditBody,
    resolveBudgetRequestDestination,
    sameDirectWhatsAppIdentity
};
