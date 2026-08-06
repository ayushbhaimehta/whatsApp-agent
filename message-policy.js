const GEMINI_MODEL_NAME = 'gemini-3.6-flash';
const GEMINI_FALLBACK_MODEL_NAMES = ['gemini-3.5-flash-lite'];

const PURCHASE_LANGUAGE = /\b(?:buy|bring|purchase|order|get|pickup|pick\s+up|kharid|khareed|laana|lana|le\s+aana)\b/i;

function isAgentGeneratedMessageBody(body) {
    const firstLine = String(body || '').split(/\r?\n/, 1)[0];
    return /\*(?:Personalized Meal Suggestions|Meals Logged|Added to Shopping List|Added to Google Tasks|Daily Summary|Stock report (?:status|ready(?::[^*]+)?|failed(?::[^*]+)?)|Scheduled stock reports(?: ready| failed)?|Complete stock reports(?: ready| failed)?|Monthly Budget Report(?:\s+—[^*]+)?|Budget report status|Scheduled budget (?:report|catch-up)(?: failed)?|Agent error|Voice-note error)\*/i
        .test(firstLine) || /\*Swiggy order history needs authorization\*/i.test(firstLine);
}

function getMessageCacheKey(msg) {
    if (!msg) return null;
    if (typeof msg.id === 'string' && msg.id) return msg.id;
    if (typeof msg.id?._serialized === 'string' && msg.id._serialized) return msg.id._serialized;
    if (typeof msg.id?.id === 'string' && msg.id.id) {
        const remote = msg.id.remote?._serialized || msg.id.remote || msg.from || msg.to || '';
        return `${remote}|${msg.id.fromMe ? '1' : '0'}|${msg.id.id}`;
    }
    // Never cache an absent ID. Caching undefined/null makes all later messages
    // look like duplicates on WhatsApp builds that changed the ID shape.
    return null;
}

function normalizeMediaMimeType(mimeType) {
    return String(mimeType || 'audio/ogg').split(';', 1)[0].trim().toLowerCase();
}

function isDailyNutritionSummaryRequest(text) {
    const normalized = String(text || '').trim().toLowerCase();
    return /\bmacro\s+(?:summary|summaries|totals?)\b/.test(normalized) ||
        /\b(?:daily|today(?:'s)?)\s+(?:nutrition|macro)\s+(?:report|summary|totals?)\b/.test(normalized) ||
        /\bnutrition\s+(?:report|summary)\b/.test(normalized) ||
        /\b(?:summari[sz]e|summary\s+of)\s+(?:my\s+)?(?:day|today)\b/.test(normalized) ||
        /\bwhat\s+did\s+i\s+eat\s+today\b/.test(normalized) ||
        normalized === 'daily report' || normalized === 'daily summary';
}

function parseMealSuggestionRequest(text, getDefaultMealType = () => 'Unknown') {
    const normalized = String(text || '').trim().toLowerCase();
    if (/\b(?:stock|ticker|equity|share|valuation)\b/.test(normalized)) return null;
    if (PURCHASE_LANGUAGE.test(normalized)) return null;

    const suggestionIntent = /\b(?:suggest|suggestion|recommend|recommendation|options?|ideas?)\b/.test(normalized) ||
        /\bwhat\s+(?:should|can)\s+i\s+eat\b/.test(normalized) ||
        /\b(?:kya\s+khau|khane\s+(?:me|mein)\s+kya)\b/.test(normalized);
    if (!suggestionIntent) return null;

    if (/\bbreakfast\b|\bsubah\b/.test(normalized)) return 'Breakfast';
    if (/\blunch\b|\bdopahar\b/.test(normalized)) return 'Lunch';
    if (/\bdinner\b|\braat\b/.test(normalized)) return 'Dinner';
    if (/\bsnacks?\b/.test(normalized)) return 'Snack';
    return getDefaultMealType();
}

function parseMonthlyBudgetRequest(text) {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) return null;
    if (/\b(?:budget|cheap|inexpensive|low[- ]cost)\s+(?:meal|food|lunch|dinner|breakfast|recipe)\b/.test(normalized)) return null;

    const categoryRuleRequest = looksLikeBudgetCategoryRuleRequest(normalized);
    const moneyTerms = '(?:budget|spend(?:ing)?|spent|expenses?|payments?|transactions?|money)';
    const monthTerms = '(?:monthly|this\\s+month|current\\s+month|for\\s+the\\s+month|mahine|maheene)';
    const looksLikeBudgetRequest = new RegExp(`\\b${monthTerms}\\b.{0,45}\\b${moneyTerms}\\b|\\b${moneyTerms}\\b.{0,45}\\b${monthTerms}\\b`, 'i').test(normalized) ||
        /\bbudget\s+(?:report|summary|breakdown)\b/.test(normalized) ||
        /\b(?:payment|spending|expense|transaction)\s+(?:breakdown|summary|report)\b/.test(normalized) ||
        /\bwhere\s+did\s+(?:all\s+)?my\s+money\s+go\b/.test(normalized) ||
        /\bis\s+mahine\s+ka\s+(?:budget|kharcha)\b/.test(normalized);
    if (!looksLikeBudgetRequest && !categoryRuleRequest) return null;

    const isoPeriod = normalized.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])\b/);
    if (isoPeriod) return {
        action: 'monthly_budget',
        period: `${isoPeriod[1]}-${isoPeriod[2].padStart(2, '0')}`,
        ...(categoryRuleRequest ? { requiresRuleInterpretation: true } : {})
    };

    const monthNames = {
        january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
        july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
    };
    for (const [name, month] of Object.entries(monthNames)) {
        const match = normalized.match(new RegExp(`\\b${name}\\b.{0,12}\\b(20\\d{2})\\b|\\b(20\\d{2})\\b.{0,12}\\b${name}\\b`));
        if (match) return {
            action: 'monthly_budget',
            period: `${match[1] || match[2]}-${month}`,
            ...(categoryRuleRequest ? { requiresRuleInterpretation: true } : {})
        };
    }
    return {
        action: 'monthly_budget',
        period: 'current_month',
        ...(categoryRuleRequest ? { requiresRuleInterpretation: true } : {})
    };
}

function looksLikeBudgetCategoryRuleRequest(text) {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) return false;
    const categoryLanguage = /\b(?:categor(?:y|ies|ise|ize|ised|ized|isation|ization)|classif(?:y|ied|ication)|group|move|put|bucket|recategor(?:ise|ize)|rename|label|mark|treat|call|create)\b/;
    const financialObject = /\b(?:budget|report|transactions?|payments?|expenses?|spending|merchants?|category|categories)\b/;
    const reportChange = /\b(?:regenerate|rebuild|redo|update|change)\b.{0,55}\b(?:budget|report|category|categories)\b|\b(?:budget|report|category|categories)\b.{0,55}\b(?:regenerate|rebuild|redo|update|change)\b/;
    const explicitCategoryMapping = /\b(?:categor(?:ise|ize)|classif(?:y|ied)|recategor(?:ise|ize))\b.{1,100}\b(?:as|under|into)\b/.test(normalized) ||
        /\b(?:move|put|group)\b.{0,45}\b(?:merchants?|restaurants?|cafes?|payments?|transactions?|transfers?)\b.{0,60}\b(?:under|into|as)\b/.test(normalized);
    const inlineBudgetAssignment = financialObject.test(normalized) &&
        /\b(?:all|every|these|those)\b.{0,80}\b(?:should|must)\s+(?:be|go)\b.{0,35}\b(?:in|into|under|to|as)\b/.test(normalized);
    return (categoryLanguage.test(normalized) && financialObject.test(normalized)) || reportChange.test(normalized) || explicitCategoryMapping || inlineBudgetAssignment;
}

function resolveBudgetCategoryOperation(text, proposedOperation) {
    const normalized = String(text || '').trim().toLowerCase();
    const proposed = String(proposedOperation || '').trim().toLowerCase();
    const explicitClear = /\breset\b.{0,60}\b(?:custom\s+)?(?:budget\s+)?(?:categories|category\s+rules?|rules?)\b/.test(normalized) ||
        /\b(?:clear|delete|remove)\b.{0,30}\ball\b.{0,45}\b(?:custom\s+)?(?:budget\s+)?(?:categories|category\s+rules?|rules?)\b/.test(normalized);
    const explicitReplace = /\b(?:replace|overwrite)\b.{0,35}\b(?:all|existing|previous|old)\b.{0,45}\b(?:custom\s+)?(?:budget\s+)?(?:categories|category\s+rules?|rules?)\b/.test(normalized);
    if (proposed === 'clear' && explicitClear) return 'clear';
    if (proposed === 'replace' && explicitReplace) return 'replace';
    return 'merge';
}

function resolveTextShortcut({ text, isPrivateChat, parseStockRequest, extractTicker, getDefaultMealType }) {
    if (!isPrivateChat) return null;
    if (isDailyNutritionSummaryRequest(text)) return { action: 'summarize_day' };

    const mealType = parseMealSuggestionRequest(text, getDefaultMealType);
    if (mealType) return { action: 'suggest_meal', mealType };

    const stockRequest = typeof parseStockRequest === 'function' ? parseStockRequest(text) : null;
    if (stockRequest) {
        return {
            action: 'stock_report',
            scope: stockRequest.scope,
            ticker: stockRequest.ticker || null
        };
    }

    const ticker = typeof extractTicker === 'function' ? extractTicker(text) : null;
    if (ticker) return { action: 'stock_report', scope: 'ticker', ticker };
    return null;
}

function resolveGeminiAction({ result, isCookChat, isPrivateChat, canAccessBudget = false, budgetInstructionText = '' }) {
    if (!isCookChat && !isPrivateChat) return { action: 'ignore' };
    const intent = result?.intent || 'none';
    if (intent === 'log_food' && Array.isArray(result.items) && result.items.length > 0) {
        return { action: 'log_food', items: result.items };
    }
    if (intent === 'add_reminder' && Array.isArray(result.items) && result.items.length > 0) {
        return { action: 'add_reminder', items: result.items };
    }
    if (intent === 'suggest_meal') {
        return isPrivateChat
            ? { action: 'suggest_meal', mealType: result.meal_type || 'Unknown' }
            : { action: 'ignore' };
    }
    if (intent === 'summarize_day') {
        return { action: isPrivateChat ? 'summarize_day' : 'ignore' };
    }
    if (intent === 'monthly_budget') {
        if (!canAccessBudget) return { action: 'ignore' };
        const action = { action: 'monthly_budget', period: result.period || 'current_month' };
        if (Array.isArray(result.budget_category_rules) && result.budget_category_rules.length > 0) {
            action.budgetCategoryRules = result.budget_category_rules;
        }
        const operation = resolveBudgetCategoryOperation(budgetInstructionText, result.budget_category_operation);
        if (operation !== 'merge') {
            action.budgetCategoryOperation = operation;
        }
        return action;
    }
    return { action: 'ignore' };
}

module.exports = {
    GEMINI_MODEL_NAME,
    GEMINI_FALLBACK_MODEL_NAMES,
    PURCHASE_LANGUAGE,
    isAgentGeneratedMessageBody,
    getMessageCacheKey,
    normalizeMediaMimeType,
    isDailyNutritionSummaryRequest,
    parseMealSuggestionRequest,
    parseMonthlyBudgetRequest,
    looksLikeBudgetCategoryRuleRequest,
    resolveBudgetCategoryOperation,
    resolveTextShortcut,
    resolveGeminiAction
};
