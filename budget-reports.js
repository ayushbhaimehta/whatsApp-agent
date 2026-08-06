const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAgentDataDirectory, resolveRuntimePath } = require('./runtime-paths');
const {
    DEFAULT_SCAN_FRESHNESS_MS,
    decryptStoredSmsRecord,
    getCompleteSmsScanCoverage
} = require('./sms-ingestion');

const TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET_MINUTES = 330;
const BUDGET_CRON_EXPRESSION = '0 18 26 * *';
const DEFAULT_GMAIL_LIMIT = 250;

const CHANNEL_LABELS = {
    online_food: 'Online food',
    online_delivery: 'Online delivery',
    office_cafeteria: 'Office cafeteria',
    misc_food: 'Misc food',
    groceries: 'Groceries',
    utilities: 'Utilities',
    transport: 'Transport',
    travel: 'Travel',
    shopping: 'Shopping',
    health: 'Health',
    personal_care: 'Personal care',
    education: 'Education',
    donations: 'Donations',
    housing: 'Housing',
    subscriptions: 'Subscriptions',
    entertainment: 'Entertainment',
    services: 'Services',
    financial_services: 'Financial services',
    ayush_transfers: 'Ayush transfers',
    transfer: 'Transfers',
    forex: 'Forex',
    miscellaneous: 'Miscellaneous'
};

const ITEM_LABELS = {
    poha: 'Poha',
    essential_groceries: 'Essential grocery',
    online_delivery: 'Online delivery',
    online_food: 'Online food',
    supplements: 'Supplements',
    household: 'Household',
    personal_care: 'Personal care',
    medicine: 'Medicine',
    fees_taxes: 'Fees and taxes',
    other: 'Other'
};

const VALID_CHANNEL_CATEGORIES = new Set(Object.keys(CHANNEL_LABELS));
const GEMINI_MERCHANT_CATEGORIES = new Set([
    'online_food',
    'online_delivery',
    'misc_food',
    'groceries',
    'utilities',
    'transport',
    'travel',
    'shopping',
    'health',
    'personal_care',
    'education',
    'donations',
    'housing',
    'subscriptions',
    'entertainment',
    'services',
    'financial_services',
    'transfer',
    'miscellaneous'
]);
const VALID_ITEM_CATEGORIES = new Set(Object.keys(ITEM_LABELS));
const LEGACY_CHANNEL_CATEGORY_ALIASES = {
    quick_commerce: 'online_delivery',
    online_grocery: 'online_delivery',
    other: 'miscellaneous'
};
const LEGACY_ITEM_CATEGORY_ALIASES = {
    non_essential_food: 'online_delivery',
    restaurant_food: 'online_food'
};
const DUPLICATE_REASON_LABELS = {
    matching_order_reference: 'matching order reference',
    debit_bank_gateway_same_amount_within_30s: 'payment: exact amount, bank/gateway alerts within 30 seconds',
    debit_same_merchant_same_amount_within_90s: 'payment: exact amount and merchant within 90 seconds',
    refund_same_amount_merchant_within_5m: 'refund: exact amount and merchant within 5 minutes',
    cross_source_same_amount_merchant_within_4h: 'receipt/payment: exact amount and merchant within 4 hours',
    matching_record: 'matching record'
};
const FOREIGN_CURRENCY_CODES = new Set(`
AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD
CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP
GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW
KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN
NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP
SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW
UZS VED VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XDR XOF XPD XPF XPT XSU XTS XUA XXX YER
ZAR ZMW ZWL
`.trim().split(/\s+/));

const MERCHANT_RULES = [
    { pattern: /\bayush(?:\s+bhai)?\s+meht(?:a)?\b(?!ani)/i, merchant: 'Ayush Mehta', category: 'ayush_transfers' },
    { pattern: /\bflipkart\s*minutes?\b/i, merchant: 'Flipkart Minutes', category: 'online_delivery' },
    { pattern: /(?:swiggy\s*)?instamart/i, merchant: 'Swiggy Instamart', category: 'online_delivery' },
    { pattern: /\bzepto(?:\s*now)?\b/i, merchant: 'Zepto', category: 'online_delivery' },
    { pattern: /\bblinkit\b/i, merchant: 'Blinkit', category: 'online_delivery' },
    { pattern: /(?:www[.\s-]*)?big\s*basket(?:[.\s-]*com)?|innovative\s+retail\s+concept/i, merchant: 'BigBasket', category: 'online_delivery' },
    { pattern: /swiggy\s*food|\bswiggy\b/i, merchant: 'Swiggy', category: 'online_food' },
    { pattern: /\bzomato\b/i, merchant: 'Zomato', category: 'online_food' },
    { pattern: /\bownly\b/i, merchant: 'Ownly', category: 'online_food' },
    { pattern: /\beat\s*club\b|\beatclub\b/i, merchant: 'EatClub', category: 'online_food' },
    { pattern: /\bctrl\s*x\s*technolog(?:y|ies)\b|\bctrlxtechnolog(?:y|ies)p?\b/i, merchant: 'Ownly', category: 'online_food' },
    { pattern: /\b(?:the\s*)?smartq\d*\b/i, merchant: 'SmartQ', category: 'misc_food' },
    { pattern: /\bbottle\s*lab(?:\s+technologies)?\b/i, merchant: 'Bottle Lab', category: 'office_cafeteria' },
    { pattern: /\bsubko\s+cof+ee\b/i, merchant: 'Subko Coffee', category: 'misc_food' },
    { pattern: /\banthe\s+eatings?\b/i, merchant: 'Anthe Eatings', category: 'misc_food' },
    { pattern: /\banand\s+sweets?(?:\s+and\s+savou?rie?s?)?\b/i, merchant: 'Anand Sweets', category: 'misc_food' },
    { pattern: /\bshubh\s+sweets?(?:\s+savou?ri(?:e|es)?)?\b/i, merchant: 'Shubh Sweets', category: 'misc_food' },
    { pattern: /\bzuchiz\b/i, merchant: 'Zuchiz', category: 'misc_food' },
    { pattern: /\belite\s+mindset\b|\bsuper\s*you\b/i, merchant: 'SuperYou', category: 'health' },
    { pattern: /\bindian\s+motors?\b/i, merchant: 'Indian Motors', category: 'transport' },
    { pattern: /\bteach\s+to\s+lead\b|\bteach\s+for\s+india\b/i, merchant: 'Teach For India', category: 'donations' },
    { pattern: /\btata\s+payments?\b/i, merchant: 'Tata Payments', category: 'miscellaneous' },
    { pattern: /\bgozo\s+ventures?\b/i, merchant: 'Gozo Ventures', category: 'miscellaneous' },
    { pattern: /\barliga\s+ecoworld\s+business\b/i, merchant: 'Arliga Ecoworld Business', category: 'miscellaneous' },
    { pattern: /\buber\b|\bola\b|\brapido\b|\b(?:petrol|diesel|fuel)\b/i, merchant: null, category: 'transport' },
    { pattern: /\b(?:electricity|bescom|water bill|broadband|internet|airtel|jio|vi recharge)\b/i, merchant: null, category: 'utilities' },
    { pattern: /\b(?:pharmacy|pharmeasy|netmeds|apollo pharmacy|1mg|medibuddy)\b/i, merchant: null, category: 'health' },
    { pattern: /\b(?:amazon|flipkart|myntra|ajio)\b/i, merchant: null, category: 'shopping' }
];

const ITEM_RULES = [
    {
        category: 'poha',
        pattern: /\b(?:poha|aval|avalakki)\b/i
    },
    {
        category: 'supplements',
        pattern: /\b(?:isabgol|psyllium|protein\s*powder|whey(?:\s+protein)?|creatine|multivitamins?|vitamin\s+[a-z0-9]+|omega\s*-?\s*3|fish\s*oil|electrolytes?|bcaa|pre\s*workout)\b/i
    },
    {
        category: 'essential_groceries',
        pattern: /\b(?:wheat|atta|flour|rice|dal|dhal|pulses?|lentils?|chana|rajma|moong|masoor|toor|tur|urad|vegetables?|fruits?|tomato(?:es)?|onions?|potatoes?|spinach|palak|carrots?|beans?|peas?|capsicum|cucumber|cabbage|cauliflower|broccoli|okra|bhindi|brinjal|eggplant|lauki|bottle\s*gourd|paneer|milk|bread|butter|curd|dahi|yogurt|yoghurt|eggs?|oil|ghee|salt|sugar|spices?|masala|oats|sooji|rava)\b/i
    },
    {
        category: 'online_delivery',
        pattern: /\b(?:protein\s*bars?|diet\s*coke|coke\s*zero|zero[ -]?sugar\s*(?:coke|cola|soft\s*drink)|chips?|crisps?|namkeen|chocolates?|candy|sweets?|cookies?|biscuits?|soft\s*drinks?|cola|soda|ice\s*cream|desserts?)\b/i
    },
    {
        category: 'household',
        pattern: /\b(?:detergent|dishwash|floor\s*cleaner|toilet\s*cleaner|garbage\s*bags?|tissues?|foil|cleaning|laundry|mosquito)\b/i
    },
    {
        category: 'personal_care',
        pattern: /\b(?:shampoo|conditioner|soap|body\s*wash|toothpaste|toothbrush|deodorant|razor|sanitary|skincare|face\s*wash)\b/i
    },
    {
        category: 'medicine',
        pattern: /\b(?:tablet|capsule|syrup|medicine|paracetamol|antacid|ointment|bandage)\b/i
    },
    {
        category: 'fees_taxes',
        pattern: /\b(?:delivery\s*fee|handling\s*fee|platform\s*fee|service\s*fee|tax|gst|tip)\b/i
    }
];

function stableHash(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}

function integerFromEnv(value, fallback, { min = 1, max = 10000 } = {}) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function canonicalChannelCategory(value) {
    const category = String(value || '').trim().toLowerCase();
    return LEGACY_CHANNEL_CATEGORY_ALIASES[category] || category;
}

function canonicalItemCategory(value) {
    const category = String(value || '').trim().toLowerCase();
    return LEGACY_ITEM_CATEGORY_ALIASES[category] || category;
}

function isTransferCategory(value) {
    const category = canonicalChannelCategory(value);
    return category === 'transfer' || category === 'ayush_transfers';
}

const MERCHANT_BUSINESS_WORDS = new Set([
    'and', 'business', 'company', 'co', 'corporation', 'enterprises', 'enterprise',
    'foods', 'foundation', 'group', 'hotel', 'industries', 'limited', 'llp', 'mart',
    'motors', 'payments', 'private', 'pvt', 'restaurant', 'retail', 'services', 'shop',
    'solutions', 'store', 'technologies', 'technology', 'traders', 'trust', 'ventures'
]);

const MERCHANT_SEMANTIC_RULES = [
    { category: 'misc_food', pattern: /\b(?:bakery|bakers?|cafe|cafeteria|canteen|chaat|coffee|cof+ee|dhaba|eatings?|food|foods|kitchen|meals?|restaurant|snacks?|sweets?|savou?ri(?:e|es|y)?)\b/i },
    { category: 'groceries', pattern: /\b(?:dairy|fresh\s*mart|general\s*store|grocer(?:y|ies)?|kirana|provisions?|supermarket|vegetables?)\b/i },
    { category: 'health', pattern: /\b(?:clinic|dental|diagnostic|doctor|fitness|health|hospital|medical|medicare|nutrition|pharma(?:cy|ceuticals?)?|wellness)\b/i },
    { category: 'personal_care', pattern: /\b(?:barber|beauty|cosmetics?|grooming|salon|spa)\b/i },
    { category: 'utilities', pattern: /\b(?:broadband|electricity|energy|gas|internet|mobile|power|recharge|telecom|water)\b/i },
    { category: 'travel', pattern: /\b(?:airlines?|airways|booking|holidays?|hotel|resort|tourism|tours?|travel)\b/i },
    { category: 'transport', pattern: /\b(?:automobiles?|cabs?|fuel|garage|metro|motors?|parking|petrol|taxi|transit|transport)\b/i },
    { category: 'education', pattern: /\b(?:academy|coaching|college|course|education|institute|learning|school|training|tuition|university)\b/i },
    { category: 'donations', pattern: /\b(?:charit(?:y|able)|donation|foundation|ngo|relief\s+fund)\b/i },
    { category: 'housing', pattern: /\b(?:apartment|housing|maintenance|property|realty|rent|society)\b/i },
    { category: 'subscriptions', pattern: /\b(?:membership|subscription)\b/i },
    { category: 'entertainment', pattern: /\b(?:cinema|entertainment|gaming|movies?|theatre|tickets?)\b/i },
    { category: 'financial_services', pattern: /\b(?:bank|broker|finance|financial|insurance|investments?|lending|securities)\b/i },
    { category: 'shopping', pattern: /\b(?:apparel|clothing|department\s*store|electronics|fashion|footwear|jewellers?|retail|shopping)\b/i },
    { category: 'services', pattern: /\b(?:consulting|digital|software|solutions|technologies|technology)\b/i }
];

function looksLikePersonMerchantName(merchantName, currentCategory) {
    if (canonicalChannelCategory(currentCategory) !== 'transfer') return false;
    const candidate = cleanMerchantCandidate(merchantName);
    if (!candidate || /\d|[@&/]|\b(?:private|pvt|limited|ltd|llp)\b/i.test(candidate)) return false;
    const tokens = candidate.split(/[\s.'-]+/).filter(Boolean);
    if (tokens.length < 1 || tokens.length > 5) return false;
    if (!tokens.every(token => /^[A-Za-z]{1,30}$/.test(token))) return false;
    return !tokens.some(token => MERCHANT_BUSINESS_WORDS.has(token.toLowerCase()));
}

function classifyMerchantNameFallback(merchantName, currentCategory = 'miscellaneous') {
    const category = canonicalChannelCategory(currentCategory) || 'miscellaneous';
    const candidate = cleanMerchantCandidate(merchantName);
    if (!candidate || candidate === 'Unknown merchant') return 'miscellaneous';

    const deterministic = matchMerchantRule(candidate);
    if (deterministic) return deterministic.channelCategory;
    for (const rule of MERCHANT_SEMANTIC_RULES) {
        if (rule.pattern.test(candidate)) return rule.category;
    }
    if (looksLikePersonMerchantName(candidate, category)) return 'transfer';
    if (VALID_CHANNEL_CATEGORIES.has(category) && category !== 'transfer' && category !== 'miscellaneous') {
        return category;
    }
    return category === 'transfer' && looksLikePersonMerchantName(candidate, category)
        ? 'transfer'
        : 'miscellaneous';
}

function normalizePeriod(period, now = new Date()) {
    const explicit = String(period || '').trim().match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    if (explicit) return explicit[0];

    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit'
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}`;
}

function getMonthWindow(period = 'current_month', now = new Date()) {
    const monthKey = normalizePeriod(period, now);
    const [year, month] = monthKey.split('-').map(Number);
    const offsetMs = IST_OFFSET_MINUTES * 60 * 1000;
    const startMs = Date.UTC(year, month - 1, 1) - offsetMs;
    const endMs = Date.UTC(year, month, 1) - offsetMs;
    const label = new Intl.DateTimeFormat('en-IN', {
        timeZone: TIME_ZONE,
        month: 'long',
        year: 'numeric'
    }).format(new Date(startMs + 12 * 60 * 60 * 1000));
    return { monthKey, label, startMs, endMs, start: new Date(startMs), end: new Date(endMs) };
}

function parseNumericAmount(value) {
    const number = Number(String(value || '').replace(/,/g, '').trim());
    if (!Number.isFinite(number) || number <= 0 || number > 100000000) return null;
    return Math.round(number * 100);
}

function extractAmountPaise(text) {
    const source = String(text || '');
    const currencyAmount = '(?:₹\\s*|INR\\s*|Rs\\.?\\s*)([0-9][0-9,]*(?:\\.\\d{1,2})?)';
    const amountCurrency = '([0-9][0-9,]*(?:\\.\\d{1,2})?)\\s*(?:INR|rupees?)\\b';

    // Receipt bodies often contain a subtotal, discounts, fees and each
    // line-item amount. A directly labelled payable total must win over a
    // nearby line item.
    const preferredLabels = [
        'grand\\s*total',
        'amount\\s*paid',
        'total\\s*paid',
        'order\\s*total',
        'final\\s*amount',
        'transaction\\s*amount',
        'amount\\s*(?:debited|charged)',
        'payment\\s*(?:of|for)'
    ];
    for (const label of preferredLabels) {
        const beforeAmount = source.match(new RegExp(`\\b(?:${label})\\b[^0-9₹]{0,24}${currencyAmount}`, 'i'));
        if (beforeAmount) {
            const amountPaise = parseNumericAmount(beforeAmount[1]);
            if (amountPaise) return amountPaise;
        }
        const afterAmount = source.match(new RegExp(`${currencyAmount}[^A-Za-z0-9]{0,12}\\b(?:${label})\\b`, 'i'));
        if (afterAmount) {
            const amountPaise = parseNumericAmount(afterAmount[1]);
            if (amountPaise) return amountPaise;
        }
        const numberBeforeCurrency = source.match(new RegExp(`\\b(?:${label})\\b[^0-9]{0,24}${amountCurrency}`, 'i'));
        if (numberBeforeCurrency) {
            const amountPaise = parseNumericAmount(numberBeforeCurrency[1]);
            if (amountPaise) return amountPaise;
        }
    }

    const settledAmountPatterns = [
        new RegExp(`${currencyAmount}[^A-Za-z0-9]{0,12}\\b(?:debited|paid|spent|charged|withdrawn|refunded)\\b`, 'i'),
        new RegExp(`\\b(?:debited|paid|spent|charged|withdrawn|refunded)\\b(?:\\s+(?:by|of|for))?[^0-9₹]{0,18}${currencyAmount}`, 'i')
    ];
    for (const pattern of settledAmountPatterns) {
        const match = source.match(pattern);
        if (!match) continue;
        const amountPaise = parseNumericAmount(match[1]);
        if (amountPaise) return amountPaise;
    }

    const matches = [];
    const patterns = [
        /(?:₹\s*|INR\s*|Rs\.?\s*)([0-9][0-9,]*(?:\.\d{1,2})?)/gi,
        /([0-9][0-9,]*(?:\.\d{1,2})?)\s*(?:INR|rupees?)\b/gi
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(source)) !== null) {
            const amountPaise = parseNumericAmount(match[1]);
            if (!amountPaise) continue;
            const beforeContext = source.slice(Math.max(0, match.index - 32), match.index);
            const afterContext = source.slice(match.index + match[0].length, match.index + match[0].length + 24);
            const context = `${beforeContext} ${afterContext}`;
            const immediateContext = `${beforeContext.slice(-20)} ${afterContext.slice(0, 12)}`;
            let score = 0;
            if (/\b(?:grand\s*total|amount\s*paid|total\s*paid|order\s*total|charged|debited|spent|payment\s*(?:of|for)?)\b/i.test(context)) score += 8;
            if (/\b(?:total|paid|payment|debit|purchase|order)\b/i.test(context)) score += 4;
            if (/\b(?:discount|saved|cashback|coupon|mrp|delivery\s*fee|handling\s*fee|tax)\b/i.test(context)) score -= 4;
            if (/\b(?:available|avl|current|closing|ledger)\s+(?:a\/?c\s+)?bal(?:ance)?\b/i.test(immediateContext)) score -= 20;
            matches.push({ amountPaise, score, index: match.index });
        }
    }

    if (matches.length === 0) return null;
    matches.sort((left, right) => right.score - left.score || right.index - left.index);
    return matches[0].amountPaise;
}

function matchMerchantRule(text) {
    const source = String(text || '');
    for (const rule of MERCHANT_RULES) {
        const match = source.match(rule.pattern);
        if (!match) continue;
        return {
            merchant: rule.merchant || match[0].trim().replace(/\s+/g, ' '),
            channelCategory: rule.category
        };
    }
    return null;
}

function isForexTransactionText(text) {
    const source = String(text || '');
    const patterns = [
        /\b([A-Z]{3})\s*[0-9][0-9,.]*/gi,
        /\b[0-9][0-9,.]*\s*([A-Z]{3})\b/gi,
        /\bInfo[A-Z0-9*._-]*\*([A-Z]{3})(?=[0-9*._-]|\b)/gi
    ];
    return patterns.some(pattern => {
        let match;
        while ((match = pattern.exec(source)) !== null) {
            if (FOREIGN_CURRENCY_CODES.has(match[1].toUpperCase())) return true;
        }
        return false;
    });
}

function cleanMerchantCandidate(value) {
    let candidate = String(value || '')
        .replace(/\[(?:payment reference|reference|phone|link|upi id|email)\]/gi, ' ')
        .replace(/\b[A-Z0-9._-]{2,}@[A-Z][A-Z0-9.-]{1,30}\b/gi, ' ')
        .replace(/(?<!\d)(?:\+?91[\s-]?)?[6-9](?:[\s-]?\d){9}(?!\d)/g, ' ')
        .replace(/\bX{2,}\d{2,}\b|\*{2,}\d{2,}/gi, ' ')
        .replace(/\b(?:\d[\s-]?){8,}\b/g, ' ')
        .replace(/\.{2,}$/g, '')
        .replace(/^[=+@-]+/, '')
        .replace(/^[\s,;:|/-]+|[\s,;:|/-]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
    candidate = candidate.replace(/^(?:mr|mrs|ms)\.?\s+/i, '');
    if (/^[A-Z0-9 &'().-]+$/.test(candidate) && /[A-Z]/.test(candidate)) {
        candidate = candidate.toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase());
    }
    return candidate;
}

function merchantFromCandidate(value, fallbackCategory = 'miscellaneous') {
    const candidate = cleanMerchantCandidate(value);
    if (!candidate || candidate.length < 2) return null;
    return matchMerchantRule(candidate) || {
        merchant: candidate,
        channelCategory: classifyMerchantNameFallback(candidate, fallbackCategory)
    };
}

function identifyMerchant(text) {
    const source = String(text || '');
    if (isForexTransactionText(source)) return { merchant: 'Forex', channelCategory: 'forex' };

    const knownMerchant = matchMerchantRule(source);
    if (knownMerchant) return knownMerchant;

    const templatePatterns = [
        {
            pattern: /\bSent\b[\s\S]{0,220}?\bTo\s+(.{2,100}?)\s+\bOn\s+(?:\d{1,2}[/-][A-Za-z0-9]{2,4}[/-]\d{2,4}|\[reference\])/i,
            category: 'transfer'
        },
        {
            pattern: /\bSpent\b[\s\S]{0,220}?\bAt\s+(.{2,100}?)\s+\bOn\s+(?:\d{1,2}[/-][A-Za-z0-9]{2,4}[/-]\d{2,4}|\[reference\])/i,
            category: 'miscellaneous'
        },
        {
            pattern: /\bdebited\s+for\b[\s\S]{0,120}?;\s*(.{2,100}?)\s+credited\b/i,
            category: 'transfer'
        },
        {
            pattern: /\bdone\s+for\s+(.{2,100}?)\s+has\s+(?:succeeded|successful)\b/i,
            category: 'miscellaneous'
        },
        {
            pattern: /\brefunded\s+by\s+(.{2,100}?)\s+\bon\s+(?:\d{1,2}[/-]|\[reference\])/i,
            category: 'miscellaneous'
        }
    ];
    for (const template of templatePatterns) {
        const match = source.match(template.pattern);
        const merchant = match ? merchantFromCandidate(match[1], template.category) : null;
        if (merchant) return merchant;
    }

    const genericTemplates = [
        {
            pattern: /\bbeneficiary(?:\s+(?:listed\s+as|name(?:\s+is)?))?\s*[:=-]?\s*([A-Za-z][A-Za-z0-9 &'._()-]{1,100}?)(?=\s+(?:using|via|on|ref|upi|for)\b|[.;]|$)/i,
            category: 'transfer'
        },
        {
            pattern: /\b(?:paid\s+to|payment\s+to|transferred\s+to|sent\s+to)\s+([A-Za-z][A-Za-z0-9 &.'_()-]{1,100}?)(?=\s+(?:using|via|on|ref|upi|for)\b|[.;]|$)/i,
            category: 'transfer'
        },
        {
            pattern: /\b(?:paid\s+at|payment\s+at|spent\s+at|purchase\s+at)\s+([A-Za-z][A-Za-z0-9 &.'_()-]{1,100}?)(?=\s+(?:using|via|on|ref|upi|for)\b|[.;]|$)/i,
            category: 'miscellaneous'
        }
    ];
    for (const template of genericTemplates) {
        const match = source.match(template.pattern);
        if (!match) continue;
        return merchantFromCandidate(match[1], template.category) || { merchant: 'Unknown merchant', channelCategory: 'miscellaneous' };
    }
    return { merchant: 'Unknown merchant', channelCategory: 'miscellaneous' };
}

function classifyItem(itemName, context = {}) {
    const source = String(itemName || '');
    const channelCategory = canonicalChannelCategory(
        typeof context === 'string'
            ? context
            : (context.channelCategory || context.channel_category)
    );
    const provider = String(typeof context === 'object' ? context.provider || '' : '').toLowerCase();
    const merchant = String(typeof context === 'object' ? context.merchant || '' : '').toLowerCase();
    const isDeliveryOrder = channelCategory === 'online_delivery' || provider === 'swiggy_instamart' || /\b(?:instamart|zepto|blinkit|big\s*basket|flipkart\s*minutes?)\b/i.test(merchant);
    const isFoodOrder = !isDeliveryOrder && (
        channelCategory === 'online_food' || provider === 'swiggy_food' || /\b(?:swiggy|zomato|ownly|eat\s*club)\b/i.test(merchant)
    );

    if (ITEM_RULES[0].pattern.test(source)) return 'poha';

    // Preserve non-food line types even when they occur inside a delivery order.
    for (const rule of ITEM_RULES.filter(candidate => [
        'supplements', 'household', 'personal_care', 'medicine', 'fees_taxes'
    ].includes(candidate.category))) {
        if (rule.pattern.test(source)) return rule.category;
    }

    // Restaurant dishes are food, even when their names contain grocery words
    // such as paneer, dal, or vegetables.
    if (isFoodOrder) return 'online_food';

    for (const rule of ITEM_RULES) {
        if (rule.pattern.test(source)) return rule.category;
    }
    if (isDeliveryOrder) return 'online_delivery';
    return 'other';
}

function extractOrderIdHash(text) {
    const match = String(text || '').match(/\b(?:order(?:\s+id|\s+no\.?|\s+number)?|invoice)\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{4,40})\b/i);
    return match ? stableHash(match[1].toUpperCase()) : null;
}

function inferDirection(text) {
    const source = String(text || '');
    if (/\b(?:refund(?:ed)?|reversal|credited\s+back|refund\s+credited)\b/i.test(source)) return 'refund';
    if (/\b(?:payment\s+(?:of\s+(?:₹\s*|INR\s*|Rs\.?\s*)?[0-9,.]+\s*)?received|amount\s+credited|credited\s+(?:to|into)|salary\s+credited|deposit(?:ed)?\s+(?:to|into))\b/i.test(source)) return 'income';
    // Some bank alerts say "Acct XX123 is credited with Rs ... from ...".
    // Do not confuse that with debit alerts whose counterparty "is credited".
    if (!/\bdebited\b/i.test(source) && (
        /\b(?:a\/?c|acct|account)\b[\s\S]{0,40}?\bis\s+credited\s+with\b/i.test(source) ||
        /\bis\s+credited\s+with\b[\s\S]{0,80}?\bfrom\b/i.test(source)
    )) return 'income';
    return 'debit';
}

function isPotentialPaymentText(text) {
    const source = String(text || '');
    if (!extractAmountPaise(source)) return false;
    if (inferDirection(source) === 'income') return false;
    return /\b(?:paid|payment|debited|spent|charged|purchase|order|refund(?:ed)?|credited\s+back|swiggy|instamart|zepto|blinkit|zomato|ownly|big\s*basket)\b/i.test(source);
}

function createTransaction({ provider, externalId, occurredAt, text, sourceType }) {
    const amountPaise = extractAmountPaise(text);
    if (!amountPaise) return null;
    const direction = inferDirection(text);
    if (direction === 'income') return null;
    const merchant = identifyMerchant(text);
    const deterministicMerchant = isForexTransactionText(text) || Boolean(matchMerchantRule(text));
    const merchantClassificationCandidate = sourceType === 'sms' &&
        !deterministicMerchant &&
        merchant.merchant !== 'Unknown merchant' &&
        merchant.channelCategory !== 'forex';
    const id = stableHash(`${provider}|${externalId}`);
    const sourceId = `${provider}:${id}`;
    return {
        id,
        provider,
        sourceType,
        occurredAt: new Date(occurredAt).toISOString(),
        merchantRaw: merchant.merchant,
        merchant: merchant.merchant,
        channelCategory: merchant.channelCategory,
        direction,
        amountPaise,
        currency: 'INR',
        orderIdHash: extractOrderIdHash(text),
        items: [],
        sourceExcerpt: redactSensitiveText(text).slice(0, 3000),
        sources: [provider],
        sourceIds: [sourceId],
        _merchantCategoryLocked: deterministicMerchant,
        _merchantClassificationCandidate: merchantClassificationCandidate
    };
}

function redactSensitiveText(text) {
    return String(text || '')
        .replace(/https?:\/\/\S+/gi, '[link]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .replace(/\b(?:delivery|shipping|billing)\s+address\b\s*[:\-]?\s*.*?(?=\b(?:order\s+(?:summary|details)|items?|subtotal|grand\s*total|amount|payment|invoice)\b|$)/gi, '[address removed] ')
        .replace(/\b(?:hi|hello|dear)\s+[A-Za-z][A-Za-z .'-]{1,50}(?=[,!])/gi, '[recipient]')
        .replace(/\b[A-Z0-9._-]{2,}@[A-Z][A-Z0-9.-]{1,30}\b/gi, '[upi id]')
        .replace(/(?<!\d)(?:\+?91[\s-]?)?[6-9](?:[\s-]?\d){9}(?!\d)/g, '[phone]')
        .replace(/\b(?:a\/?c|account|card|rrn|utr|upi\s*(?:ref|reference)?|txn|transaction|reference|ref)\s*(?:no\.?|number|id)?\s*[:#-]?\s*[X*\d][X*\d\s-]{5,30}\b/gi, '[payment reference]')
        .replace(/\b(?:\d[\s-]?){8,}\b/g, '[reference]')
        .replace(/\s+/g, ' ')
        .trim();
}

function decodeBase64Url(data) {
    if (!data) return '';
    const normalized = String(data).replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf8');
}

function stripHtml(html) {
    return String(html || '')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#39;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractGmailBody(payload) {
    const plain = [];
    const html = [];
    const visit = part => {
        if (!part) return;
        const mimeType = String(part.mimeType || '').toLowerCase();
        const decoded = decodeBase64Url(part.body?.data);
        if (decoded && mimeType === 'text/plain') plain.push(decoded);
        if (decoded && mimeType === 'text/html') html.push(stripHtml(decoded));
        for (const child of part.parts || []) visit(child);
    };
    visit(payload);
    const result = plain.length > 0 ? plain.join('\n') : html.join('\n');
    return result.replace(/\s+/g, ' ').trim();
}

function loadBudgetGmailOAuthClient(tokenPath) {
    if (!tokenPath || !fs.existsSync(tokenPath)) return null;
    const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    if (!tokenData.client_id || !tokenData.client_secret || !tokenData.tokens) return null;
    const client = new google.auth.OAuth2(tokenData.client_id, tokenData.client_secret);
    client.setCredentials(tokenData.tokens);
    client.on('tokens', tokens => {
        try {
            const current = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
            current.tokens = { ...current.tokens, ...tokens };
            fs.writeFileSync(tokenPath, JSON.stringify(current, null, 2), 'utf8');
        } catch (error) {
            console.error('Could not persist refreshed Gmail budget token:', error.message || error);
        }
    });
    return client;
}

async function collectGmailReceiptTransactions({ authClient, window, maxMessages = DEFAULT_GMAIL_LIMIT }) {
    if (!authClient) {
        return {
            transactions: [],
            warnings: ['Gmail receipts are not connected; item-level coverage may be incomplete. Run `node auth-budget.js`.']
        };
    }

    const gmail = google.gmail({ version: 'v1', auth: authClient });
    const after = Math.floor(window.startMs / 1000);
    const before = Math.floor(window.endMs / 1000);
    const merchantTerms = '{swiggy instamart zepto blinkit zomato ownly bigbasket "big basket" "payment successful" "amount debited" receipt invoice}';
    const q = `after:${after} before:${before} ${merchantTerms}`;
    const messageRefs = [];
    let pageToken;

    try {
        do {
            const response = await gmail.users.messages.list({
                userId: 'me',
                q,
                maxResults: Math.min(100, maxMessages - messageRefs.length),
                pageToken
            });
            messageRefs.push(...(response.data.messages || []));
            pageToken = response.data.nextPageToken;
        } while (pageToken && messageRefs.length < maxMessages);
    } catch (error) {
        const message = error?.response?.data?.error?.message || error.message || String(error);
        return { transactions: [], warnings: [`Gmail receipt query failed: ${message}`] };
    }

    const transactions = [];
    const warnings = [];
    let failedMessageFetches = 0;
    for (let offset = 0; offset < messageRefs.length; offset += 10) {
        const batch = messageRefs.slice(offset, offset + 10);
        const settled = await Promise.allSettled(batch.map(ref => gmail.users.messages.get({
            userId: 'me',
            id: ref.id,
            format: 'full'
        })));

        for (const result of settled) {
            if (result.status !== 'fulfilled') {
                failedMessageFetches += 1;
                continue;
            }
            const message = result.value.data;
            const headers = Object.fromEntries((message.payload?.headers || []).map(header => [String(header.name).toLowerCase(), header.value]));
            const body = extractGmailBody(message.payload);
            const combined = `${headers.subject || ''}\n${headers.from || ''}\n${body}`;
            const occurredAtMs = Number(message.internalDate);
            if (!Number.isFinite(occurredAtMs) || occurredAtMs < window.startMs || occurredAtMs >= window.endMs) continue;
            if (!isPotentialPaymentText(combined)) continue;
            const transaction = createTransaction({
                provider: 'gmail_receipts',
                externalId: message.id,
                occurredAt: occurredAtMs,
                text: combined,
                sourceType: 'receipt'
            });
            if (transaction) transactions.push(transaction);
        }
    }

    if (messageRefs.length >= maxMessages) warnings.push(`Gmail receipt scan reached its ${maxMessages}-message safety limit.`);
    if (failedMessageFetches > 0) warnings.push(`Gmail could not fetch ${failedMessageFetches} matching receipt message(s).`);
    return { transactions, warnings };
}

function collectAndroidSmsTransactions({ storePath, storeSecret, window, coverageVerified = false }) {
    if (!storePath || !fs.existsSync(storePath)) {
        return {
            transactions: [],
            warnings: coverageVerified
                ? []
                : ['Android transaction SMS source is not connected; bank/UPI coverage may be incomplete.']
        };
    }

    if (!storeSecret) {
        return {
            transactions: [],
            warnings: ['Android transaction SMS data exists, but SMS_INGESTION_SECRET is unavailable, so it could not be decrypted.']
        };
    }

    const transactions = [];
    let malformedLines = 0;
    const lines = fs.readFileSync(storePath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
        let record;
        try {
            record = decryptStoredSmsRecord(JSON.parse(line), storeSecret);
        } catch (_) {
            malformedLines += 1;
            continue;
        }
        const occurredAtMs = new Date(record.occurredAt).getTime();
        if (!Number.isFinite(occurredAtMs) || occurredAtMs < window.startMs || occurredAtMs >= window.endMs) continue;
        const body = String(record.body || '').trim();
        if (!isPotentialPaymentText(body)) continue;
        const transaction = createTransaction({
            provider: 'android_sms',
            externalId: record.id || `${record.sender}|${record.occurredAt}|${body}`,
            occurredAt: occurredAtMs,
            text: `${record.sender || ''} ${body}`,
            sourceType: 'sms'
        });
        if (transaction) transactions.push(transaction);
    }
    const warnings = malformedLines > 0 ? [`Ignored ${malformedLines} malformed Android SMS record(s).`] : [];
    return { transactions, warnings };
}

function smsCoverageError(reason, window) {
    const guidance = {
        sms_secret_unavailable: 'The SMS ingestion secret is unavailable.',
        missing_scan_state: 'No completed Android SMS scan has been received.',
        month_not_scanned: `The Android phone has not completed a full scan for ${window.label}.`,
        scan_did_not_start_at_month_boundary: `The latest Android scan did not cover all of ${window.label}.`,
        scan_is_stale: 'The latest Android SMS scan is too old to produce a complete current-month report.',
        sms_store_missing: 'The completed scan reported transaction SMS, but their encrypted store is unavailable.'
    };
    const error = new Error(`${guidance[reason] || 'A complete Android SMS scan is required.'} Open SMS Budget Companion on the phone, tap "Sync current month now" while npm start is running, then request the budget again.`);
    error.code = 'SMS_SCAN_REQUIRED';
    error.coverageReason = reason;
    return error;
}

function merchantQuality(transaction) {
    if (!transaction || transaction.merchant === 'Unknown merchant') return 0;
    if (transaction.channelCategory === 'forex' || isTransferCategory(transaction.channelCategory)) return 3;
    if (transaction.channelCategory && canonicalChannelCategory(transaction.channelCategory) !== 'miscellaneous') return 4;
    return 2;
}

function mergeTransaction(existing, incoming, duplicateReason = 'matching_record') {
    let preferred = existing;
    if (incoming.sourceType === 'receipt' && existing.sourceType !== 'receipt') preferred = incoming;
    else if (incoming.sourceType === existing.sourceType && merchantQuality(incoming) > merchantQuality(existing)) preferred = incoming;
    const secondary = preferred === existing ? incoming : existing;
    const firstOccurredAt = new Date(Math.min(
        new Date(existing._dedupeFirstOccurredAt || existing.occurredAt).getTime(),
        new Date(incoming._dedupeFirstOccurredAt || incoming.occurredAt).getTime()
    )).toISOString();
    const merchantCategoryLocked = Boolean(existing._merchantCategoryLocked || incoming._merchantCategoryLocked);
    return {
        ...preferred,
        id: existing.id,
        orderIdHash: preferred.orderIdHash || secondary.orderIdHash,
        items: preferred.items.length > 0 ? preferred.items : secondary.items,
        sources: [...new Set([...(existing.sources || [existing.provider]), ...(incoming.sources || [incoming.provider])])],
        sourceIds: [...new Set([...(existing.sourceIds || []), ...(incoming.sourceIds || [])])],
        duplicateCount: (existing.duplicateCount || 0) + (incoming.duplicateCount || 0) + 1,
        duplicateReasons: [...new Set([
            ...(existing.duplicateReasons || []),
            ...(incoming.duplicateReasons || []),
            duplicateReason
        ])],
        matchedAlertTimes: [...new Set([
            ...(existing.matchedAlertTimes || [existing.occurredAt]),
            ...(incoming.matchedAlertTimes || [incoming.occurredAt])
        ])].sort(),
        _dedupeFirstOccurredAt: firstOccurredAt,
        _merchantCategoryLocked: merchantCategoryLocked,
        _merchantClassificationCandidate: !merchantCategoryLocked && Boolean(
            existing._merchantClassificationCandidate || incoming._merchantClassificationCandidate
        )
    };
}

function normalizedMerchantKey(value) {
    return normalizeEvidence(value)
        .replace(/\b(?:www|com|private|pvt|limited|ltd|technologies|technology|payments?)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function merchantsAreCompatible(left, right) {
    if (!left || !right || left === 'Unknown merchant' || right === 'Unknown merchant') return false;
    const leftKey = normalizedMerchantKey(left);
    const rightKey = normalizedMerchantKey(right);
    if (!leftKey || !rightKey) return false;
    if (leftKey === rightKey) return true;
    return Math.min(leftKey.length, rightKey.length) >= 5 &&
        (leftKey.startsWith(rightKey) || rightKey.startsWith(leftKey));
}

function smsNotificationFamily(transaction) {
    const evidence = String(transaction?.sourceExcerpt || '');
    if (/\bpay\s*u\b|payuib|\bdone\s+for\b[\s\S]{0,120}\bhas\s+(?:succeeded|successful)\b/i.test(evidence)) return 'gateway';
    if (/hdfc|icici|axis|kotak|sbi|indusind|yes\s*bank|idfc|\b(?:bank|acct|a\/?c|credit\s*card|debit\s*card)\b/i.test(evidence)) return 'bank';
    return 'other';
}

function smsNotifierKey(transaction) {
    const sender = String(transaction?.sourceExcerpt || '').trim().match(/^([^\s]{2,80})/u)?.[1] || '';
    return normalizeEvidence(sender);
}

function smsTemplateFingerprint(transaction) {
    const evidence = String(transaction?.sourceExcerpt || '');
    if (/\brefund[\s\S]{0,40}\binitiated\b/i.test(evidence)) return 'refund_initiated';
    if (/\b(?:refund\s+credited|credited\s+back)\b/i.test(evidence)) return 'refund_credited';
    if (/\brefunded\s+by\b/i.test(evidence)) return 'refunded_by';
    if (/\breversal\b/i.test(evidence)) return 'reversal';
    if (/\bdone\s+for\b[\s\S]{0,120}\bhas\s+(?:succeeded|successful)\b/i.test(evidence)) return 'gateway_success';
    if (/\bspent\b/i.test(evidence)) return 'spent';
    if (/\bsent\b/i.test(evidence)) return 'sent';
    if (/\bdebited\s+for\b[\s\S]{0,120}\bcredited\b/i.test(evidence)) return 'debit_credit';
    return 'other';
}

function hasDistinctSmsNotificationEvidence(left, right) {
    const leftNotifier = smsNotifierKey(left);
    const rightNotifier = smsNotifierKey(right);
    if (leftNotifier && rightNotifier && leftNotifier !== rightNotifier) return true;
    const leftTemplate = smsTemplateFingerprint(left);
    const rightTemplate = smsTemplateFingerprint(right);
    return leftTemplate !== 'other' && rightTemplate !== 'other' && leftTemplate !== rightTemplate;
}

function sameSmsDuplicateReason(left, right, timeDifferenceMs) {
    if (left.sourceType !== 'sms' || right.sourceType !== 'sms') return null;
    if (isTransferCategory(left.channelCategory) || isTransferCategory(right.channelCategory)) return null;
    if (left.channelCategory === 'forex' || right.channelCategory === 'forex') return null;

    if (left.direction === 'refund') {
        return merchantsAreCompatible(left.merchant, right.merchant) &&
            hasDistinctSmsNotificationEvidence(left, right) &&
            timeDifferenceMs <= 5 * 60 * 1000
            ? 'refund_same_amount_merchant_within_5m'
            : null;
    }
    if (left.direction !== 'debit') return null;

    const leftFamily = smsNotificationFamily(left);
    const rightFamily = smsNotificationFamily(right);
    const families = new Set([leftFamily, rightFamily]);
    if (families.has('bank') && families.has('gateway')) {
        return left.merchant !== 'Unknown merchant' && right.merchant !== 'Unknown merchant' &&
            timeDifferenceMs <= 30 * 1000
            ? 'debit_bank_gateway_same_amount_within_30s'
            : null;
    }

    return leftFamily === 'bank' && rightFamily === 'bank' &&
        merchantsAreCompatible(left.merchant, right.merchant) &&
        hasDistinctSmsNotificationEvidence(left, right) &&
        timeDifferenceMs <= 90 * 1000
        ? 'debit_same_merchant_same_amount_within_90s'
        : null;
}

function reconcileTransactions(transactions) {
    const sorted = [...transactions].sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
    const reconciled = [];
    for (const transaction of sorted) {
        let matchIndex = -1;
        let duplicateReason = null;
        for (let index = 0; index < reconciled.length; index += 1) {
            const candidate = reconciled[index];
            if (candidate.direction !== transaction.direction) continue;
            if (candidate.amountPaise !== transaction.amountPaise) continue;
            if (candidate.orderIdHash && transaction.orderIdHash && candidate.orderIdHash === transaction.orderIdHash) {
                matchIndex = index;
                duplicateReason = 'matching_order_reference';
                break;
            }
            const candidateStart = new Date(candidate._dedupeFirstOccurredAt || candidate.occurredAt);
            const transactionStart = new Date(transaction._dedupeFirstOccurredAt || transaction.occurredAt);
            const timeDifference = Math.abs(candidateStart - transactionStart);
            const smsReason = sameSmsDuplicateReason(candidate, transaction, timeDifference);
            if (smsReason) {
                matchIndex = index;
                duplicateReason = smsReason;
                break;
            }
            if (candidate.provider === transaction.provider) continue;
            if (isTransferCategory(candidate.channelCategory) || isTransferCategory(transaction.channelCategory)) continue;
            if (candidate.channelCategory === 'forex' || transaction.channelCategory === 'forex') continue;
            if (merchantsAreCompatible(candidate.merchant, transaction.merchant) && timeDifference <= 4 * 60 * 60 * 1000) {
                matchIndex = index;
                duplicateReason = 'cross_source_same_amount_merchant_within_4h';
                break;
            }
        }
        if (matchIndex === -1) reconciled.push(transaction);
        else reconciled[matchIndex] = mergeTransaction(reconciled[matchIndex], transaction, duplicateReason);
    }
    return reconciled;
}

function buildSmsMerchantEvidence(transaction) {
    if (canonicalChannelCategory(transaction?.channelCategory) === 'forex') return '';
    if (transaction?.merchant && transaction.merchant !== 'Unknown merchant') {
        const merchantName = cleanMerchantCandidate(transaction.merchant);
        if (/^(?:beneficiary|merchant|payee|upi(?:\s+id)?)$/i.test(merchantName)) return '';
        return merchantName;
    }
    return '';
}

function isSmsMerchantClassificationCandidate(transaction) {
    return transaction?.sourceType === 'sms' &&
        transaction._merchantClassificationCandidate === true &&
        transaction._merchantCategoryLocked !== true &&
        canonicalChannelCategory(transaction.channelCategory) !== 'forex' &&
        Boolean(buildSmsMerchantEvidence(transaction));
}

function buildMerchantCategoryPrompt(transactions) {
    const payload = transactions
        .filter(isSmsMerchantClassificationCandidate)
        .map(transaction => ({
            id: transaction.id,
            merchant: buildSmsMerchantEvidence(transaction)
        }));
    return `Classify extracted Indian payment merchant names. Each record contains only a hashed local row id and merchant name. Infer from the name alone and do not invent facts.

Allowed channel_category values: ${[...GEMINI_MERCHANT_CATEGORIES].join(', ')}.

Rules:
- Ayush Mehta is handled locally and will not appear here. Never return ayush_transfers.
- Swiggy, Zomato, Ownly, and EatClub are online_food.
- Zepto, Instamart, BigBasket, Flipkart Minutes, and Blinkit are online_delivery.
- A person's name or personal UPI payee is transfer.
- A restaurant, cafe, food stall, sweets shop, bakery, canteen, or other direct food business is misc_food, not online_food.
- Use the closest allowed category for a clearly signifying business name, such as health, transport, education, donations, utilities, housing, shopping, or services.
- A legal suffix such as Private Limited, Pvt, Ltd, LLP, Technologies, Payments, or Ventures does not establish what the merchant sells.
- If the name is opaque, ambiguous, or does not reliably signify a category, use miscellaneous and entity_type unknown.
- Return one result per supplied id. Confidence must reflect evidence from the merchant name alone.

Return strict JSON only:
{"transactions":[{"id":"hash","entity_type":"person|business|unknown","channel_category":"allowed value","confidence":0.0}]}

Records:
${JSON.stringify(payload)}`;
}

function buildBudgetEnrichmentPrompt(transactions) {
    if (transactions.length > 0 && transactions.every(transaction => transaction.sourceType === 'sms')) {
        return buildMerchantCategoryPrompt(transactions);
    }
    const payload = transactions
        .filter(transaction => transaction.sourceType === 'receipt')
        .map(transaction => ({
            id: transaction.id,
            source_type: 'receipt',
            current_merchant: transaction.merchant,
            channel_category: canonicalChannelCategory(transaction.channelCategory),
            evidence_text: String(transaction.sourceExcerpt || '').slice(0, 3000)
        }));
    return `You categorize Indian household spending records. Use only the supplied evidence_text; never invent an item, price, quantity, merchant, or total.

Allowed channel_category values: ${[...VALID_CHANNEL_CATEGORIES].join(', ')}.
Allowed item category values: ${[...VALID_ITEM_CATEGORIES].join(', ')}.

Rules:
- Zepto, Blinkit, Swiggy Instamart, BigBasket, and Flipkart Minutes are online_delivery.
- Swiggy restaurant delivery, Zomato, and Ownly are online_food.
- Bottle Lab is office_cafeteria.
- Foreign-currency card/payment descriptions are merchant Forex and channel_category forex.
- A named individual or personal UPI recipient is channel_category transfer.
- Wheat, vegetables, paneer, milk, bread, butter, rice, dal, eggs, fruit, and staples are essential_groceries.
- Poha is poha. Other restaurant dishes from Swiggy, Zomato, Ownly, or EatClub are online_food.
- Protein bars, Diet Coke, chips, sweets, soft drinks, and desserts from a delivery order are online_delivery.
- Isabgol/psyllium, protein powder/whey, creatine, vitamins, and similar products are supplements.
- If a line price is not explicitly visible, use null. Do not allocate the transaction total across items.
- Remove phone numbers, addresses, and payment references from names.
- Extract only item lines explicitly present in receipt evidence.
- Never return or alter a transaction amount.

Return strict JSON only:
{"transactions":[{"id":"hash","merchant":"canonical merchant","channel_category":"allowed value","confidence":0.0,"items":[{"name":"explicit item","quantity":"explicit quantity or empty","line_amount":"INR number string or null","category":"allowed value","confidence":0.0}]}]}

Records:
${JSON.stringify(payload)}`;
}

function normalizeEvidence(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function evidenceSupportsName(name, evidence) {
    const normalizedName = normalizeEvidence(name);
    const normalizedEvidence = normalizeEvidence(evidence);
    if (!normalizedName || !normalizedEvidence) return false;
    if (normalizedEvidence.includes(normalizedName)) return true;
    const meaningfulTokens = normalizedName.split(' ').filter(token => token.length >= 3 || /^\d+$/.test(token));
    return meaningfulTokens.length > 0 && meaningfulTokens.every(token => normalizedEvidence.includes(token));
}

function extractAllCurrencyAmountsPaise(text) {
    const amounts = [];
    const patterns = [
        /(?:₹\s*|INR\s*|Rs\.?\s*)([0-9][0-9,]*(?:\.\d{1,2})?)/gi,
        /([0-9][0-9,]*(?:\.\d{1,2})?)\s*(?:INR|rupees?)\b/gi
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(String(text || ''))) !== null) {
            const amountPaise = parseNumericAmount(match[1]);
            if (amountPaise) amounts.push(amountPaise);
        }
    }
    return amounts;
}

function applySmsMerchantClassification(transactions, enrichment) {
    const entries = Array.isArray(enrichment?.transactions) ? enrichment.transactions : [];
    const groupedById = new Map();
    for (const entry of entries) {
        const id = String(entry?.id || '');
        if (!id) continue;
        if (!groupedById.has(id)) groupedById.set(id, []);
        groupedById.get(id).push(entry);
    }
    return transactions.map(transaction => {
        const matches = groupedById.get(transaction.id) || [];
        const enriched = matches.length === 1 ? matches[0] : null;
        if (!enriched || !isSmsMerchantClassificationCandidate(transaction)) return transaction;
        const confidence = Number(enriched.confidence);
        if (!Number.isFinite(confidence) || confidence < 0.75) return transaction;

        const currentChannelCategory = canonicalChannelCategory(transaction.channelCategory) || 'miscellaneous';
        const entityType = String(enriched.entity_type || '').trim().toLowerCase();
        const proposedChannelCategory = canonicalChannelCategory(enriched.channel_category);
        let channelCategory = currentChannelCategory;
        if (entityType === 'unknown') channelCategory = 'miscellaneous';
        else if (entityType === 'person') channelCategory = 'transfer';
        else if (GEMINI_MERCHANT_CATEGORIES.has(proposedChannelCategory)) {
            channelCategory = entityType === 'business' && proposedChannelCategory === 'transfer'
                ? currentChannelCategory
                : proposedChannelCategory;
        }
        return { ...transaction, channelCategory };
    });
}

function applyBudgetEnrichment(transactions, enrichment) {
    const smsResults = new Map(
        applySmsMerchantClassification(
            transactions.filter(transaction => transaction.sourceType === 'sms'),
            enrichment
        ).map(transaction => [transaction.id, transaction])
    );
    const entries = Array.isArray(enrichment?.transactions) ? enrichment.transactions : [];
    const byId = new Map(entries.map(entry => [String(entry?.id || ''), entry]));
    return transactions.map(transaction => {
        if (transaction.sourceType === 'sms') return smsResults.get(transaction.id) || transaction;
        const enriched = byId.get(transaction.id);
        if (!enriched) return transaction;
        const evidence = String(transaction.sourceExcerpt || '');
        const proposedMerchant = cleanMerchantCandidate(enriched.merchant);
        const merchantCanBeEnriched = transaction.merchant === 'Unknown merchant' &&
            proposedMerchant && evidenceSupportsName(proposedMerchant, evidence);
        const merchant = merchantCanBeEnriched
            ? proposedMerchant
            : transaction.merchant;
        const currentChannelCategory = canonicalChannelCategory(transaction.channelCategory);
        const proposedChannelCategory = canonicalChannelCategory(enriched.channel_category);
        const canEnrichChannelCategory = transaction._merchantCategoryLocked !== true &&
            currentChannelCategory === 'miscellaneous';
        const channelCategory = !canEnrichChannelCategory
            ? currentChannelCategory
            : (GEMINI_MERCHANT_CATEGORIES.has(proposedChannelCategory) ? proposedChannelCategory : currentChannelCategory);
        const visibleAmounts = new Set(extractAllCurrencyAmountsPaise(evidence));
        const itemContext = { channelCategory, merchant, provider: transaction.provider };
        const items = (Array.isArray(enriched.items) ? enriched.items : [])
            .filter(item => item && evidenceSupportsName(item.name, evidence))
            .slice(0, 100)
            .map(item => ({
                name: String(item.name).trim().slice(0, 160),
                quantity: String(item.quantity || '').trim().slice(0, 80),
                lineAmountPaise: item.line_amount == null
                    ? null
                    : parseNumericAmount(String(item.line_amount).replace(/[^0-9.,]/g, '')),
                category: classifyItem(item.name, itemContext) !== 'other'
                    ? classifyItem(item.name, itemContext)
                    : (VALID_ITEM_CATEGORIES.has(canonicalItemCategory(item.category)) ? canonicalItemCategory(item.category) : 'other'),
                confidence: Number.isFinite(Number(item.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : null
            }))
            .map(item => ({
                ...item,
                lineAmountPaise: item.lineAmountPaise && visibleAmounts.has(item.lineAmountPaise)
                    ? item.lineAmountPaise
                    : null
            }));
        const visibleLineTotal = items.reduce((sum, item) => sum + (item.lineAmountPaise || 0), 0);
        if (visibleLineTotal > transaction.amountPaise) {
            for (const item of items) item.lineAmountPaise = null;
        }
        return {
            ...transaction,
            merchant,
            channelCategory,
            items
        };
    });
}

function swiggyOrderMatchesPlatform(transaction, order) {
    const merchant = normalizeEvidence(transaction?.merchant);
    if (order?.provider === 'swiggy_instamart') {
        return merchant.includes('instamart') || merchant === 'swiggy';
    }
    if (order?.provider === 'swiggy_food') {
        return merchant.includes('swiggy') && !merchant.includes('instamart');
    }
    return false;
}

function normalizeTransactionItemCategories(transaction) {
    const context = {
        channelCategory: transaction.channelCategory,
        merchant: transaction.merchant,
        provider: transaction.provider
    };
    return {
        ...transaction,
        items: (transaction.items || []).map(item => {
            const deterministic = classifyItem(item.name, context);
            const supplied = canonicalItemCategory(item.category);
            return {
                ...item,
                category: deterministic !== 'other'
                    ? deterministic
                    : (VALID_ITEM_CATEGORIES.has(supplied) ? supplied : 'other')
            };
        })
    };
}

function attachSwiggyOrdersToTransactions(transactions, orders, { maxTimeDifferenceMs = 4 * 60 * 60 * 1000 } = {}) {
    const nextTransactions = transactions.map(normalizeTransactionItemCategories);
    const usedTransactionIndexes = new Set();
    const warnings = [];
    let matchedOrderCount = 0;
    let skippedUnsafeLineAmounts = 0;
    let consideredOrderCount = 0;

    for (const order of Array.isArray(orders) ? orders : []) {
        const occurredAtMs = new Date(order?.occurredAt).getTime();
        const payablePaise = Number(order?.payablePaise);
        if (!['swiggy_instamart', 'swiggy_food'].includes(order?.provider) ||
            !Number.isInteger(payablePaise) || payablePaise <= 0 || !Number.isFinite(occurredAtMs)) continue;
        consideredOrderCount += 1;

        const exactOrderMatches = [];
        const amountTimeMatches = [];
        for (let index = 0; index < nextTransactions.length; index += 1) {
            if (usedTransactionIndexes.has(index)) continue;
            const transaction = nextTransactions[index];
            if (transaction.direction !== 'debit' || transaction.amountPaise !== payablePaise) continue;
            if (transaction.orderIdHash && order.orderIdHash && transaction.orderIdHash === order.orderIdHash) {
                exactOrderMatches.push(index);
                continue;
            }
            if (!swiggyOrderMatchesPlatform(transaction, order)) continue;
            const timeDifference = Math.abs(new Date(transaction.occurredAt).getTime() - occurredAtMs);
            if (timeDifference <= maxTimeDifferenceMs) amountTimeMatches.push(index);
        }

        const candidates = exactOrderMatches.length > 0 ? exactOrderMatches : amountTimeMatches;
        if (candidates.length !== 1) continue;
        const matchIndex = candidates[0];
        const transaction = nextTransactions[matchIndex];
        const context = {
            channelCategory: transaction.channelCategory,
            merchant: transaction.merchant,
            provider: order.provider
        };
        const orderItems = [
            ...(Array.isArray(order.items) ? order.items : []),
            ...(Array.isArray(order.fees) ? order.fees : [])
        ]
            .filter(item => item && String(item.name || '').trim())
            .slice(0, 150)
            .map(item => ({
                name: String(item.name).trim().slice(0, 160),
                quantity: String(item.quantity || '').trim().slice(0, 80),
                lineAmountPaise: Number.isInteger(Number(item.lineAmountPaise ?? item.amountPaise)) && Number(item.lineAmountPaise ?? item.amountPaise) > 0
                    ? Number(item.lineAmountPaise ?? item.amountPaise)
                    : null,
                category: classifyItem(item.name, context),
                confidence: 1,
                itemSource: 'swiggy_mcp'
            }));

        const orderLineTotal = orderItems.reduce((sum, item) => sum + (item.lineAmountPaise || 0), 0);
        if (orderLineTotal > transaction.amountPaise) {
            skippedUnsafeLineAmounts += 1;
            for (const item of orderItems) item.lineAmountPaise = null;
        }

        const byItemKey = new Map();
        for (const item of transaction.items || []) {
            const key = `${normalizeEvidence(item.name)}|${normalizeEvidence(item.quantity)}`;
            byItemKey.set(key, item);
        }
        for (const item of orderItems) {
            const key = `${normalizeEvidence(item.name)}|${normalizeEvidence(item.quantity)}`;
            byItemKey.set(key, { ...(byItemKey.get(key) || {}), ...item });
        }

        nextTransactions[matchIndex] = normalizeTransactionItemCategories({
            ...transaction,
            orderIdHash: transaction.orderIdHash || order.orderIdHash || null,
            items: [...byItemKey.values()],
            itemSources: [...new Set([...(transaction.itemSources || []), 'swiggy_mcp'])]
        });
        usedTransactionIndexes.add(matchIndex);
        matchedOrderCount += 1;
    }

    const unmatchedOrderCount = consideredOrderCount - matchedOrderCount;
    if (unmatchedOrderCount > 0) {
        warnings.push(`Swiggy supplied ${unmatchedOrderCount} order(s) that could not be uniquely matched to an exact bank payment; they were not counted as spending.`);
    }
    if (skippedUnsafeLineAmounts > 0) {
        warnings.push(`Swiggy item prices exceeded the settled payment for ${skippedUnsafeLineAmounts} matched order(s), usually because of discounts; item names were retained but those line values were not allocated.`);
    }
    return {
        transactions: nextTransactions,
        warnings,
        consideredOrderCount,
        matchedOrderCount,
        unmatchedOrderCount
    };
}

function aggregateBy(transactions, keySelector) {
    const totals = new Map();
    for (const transaction of transactions) {
        const key = keySelector(transaction);
        const signedAmount = transaction.direction === 'refund' ? -transaction.amountPaise : transaction.amountPaise;
        totals.set(key, (totals.get(key) || 0) + signedAmount);
    }
    return [...totals.entries()]
        .map(([key, amountPaise]) => ({ key, amountPaise }))
        .sort((a, b) => Math.abs(b.amountPaise) - Math.abs(a.amountPaise));
}

function summarizeBudget(transactions, monthlyBudgetPaise = null) {
    const debitsPaise = transactions.filter(item => item.direction === 'debit').reduce((sum, item) => sum + item.amountPaise, 0);
    const refundsPaise = transactions.filter(item => item.direction === 'refund').reduce((sum, item) => sum + item.amountPaise, 0);
    const netPaise = debitsPaise - refundsPaise;
    const duplicateRecordsMerged = transactions.reduce((sum, transaction) => sum + (transaction.duplicateCount || 0), 0);
    const itemTotals = new Map();
    let itemizedLinePaise = 0;
    let itemCount = 0;
    for (const transaction of transactions) {
        if (transaction.direction !== 'debit') continue;
        for (const item of transaction.items || []) {
            itemCount += 1;
            const category = canonicalItemCategory(item.category) || 'other';
            const current = itemTotals.get(category) || { count: 0, amountPaise: 0 };
            current.count += 1;
            if (item.lineAmountPaise) {
                current.amountPaise += item.lineAmountPaise;
                itemizedLinePaise += item.lineAmountPaise;
            }
            itemTotals.set(category, current);
        }
    }
    return {
        transactionCount: transactions.length,
        duplicateRecordsMerged,
        debitsPaise,
        refundsPaise,
        netPaise,
        monthlyBudgetPaise,
        remainingPaise: monthlyBudgetPaise == null ? null : monthlyBudgetPaise - netPaise,
        byChannel: aggregateBy(transactions, transaction => canonicalChannelCategory(transaction.channelCategory)),
        byMerchant: aggregateBy(transactions, transaction => transaction.merchant),
        byItemCategory: [...itemTotals.entries()].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.amountPaise - a.amountPaise || b.count - a.count),
        itemizedLinePaise,
        itemCount
    };
}

function formatInr(paise) {
    const value = Number(paise || 0) / 100;
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: value % 1 === 0 ? 0 : 2 }).format(value);
}

function formatBudgetWhatsApp(report) {
    const { summary } = report;
    const lines = [
        `💰 *Monthly Budget Report — ${report.label}*`,
        '',
        `*Net spend:* ${formatInr(summary.netPaise)}`,
        `Debits: ${formatInr(summary.debitsPaise)} | Refunds: ${formatInr(summary.refundsPaise)}`,
        `Transactions: ${summary.transactionCount}`,
        `Duplicate alerts merged: ${summary.duplicateRecordsMerged || 0}`
    ];

    if (summary.monthlyBudgetPaise != null) {
        const label = summary.remainingPaise >= 0 ? 'Remaining' : 'Over budget';
        lines.push(`Monthly limit: ${formatInr(summary.monthlyBudgetPaise)} | ${label}: ${formatInr(Math.abs(summary.remainingPaise))}`);
    }

    if (summary.byChannel.length > 0) {
        lines.push('', '*By channel*');
        for (const entry of summary.byChannel.slice(0, 8)) {
            lines.push(`• ${CHANNEL_LABELS[entry.key] || entry.key}: ${formatInr(entry.amountPaise)}`);
        }
    }

    if (summary.byMerchant.length > 0) {
        lines.push('', '*Top merchants*');
        for (const entry of summary.byMerchant.slice(0, 6)) lines.push(`• ${entry.key}: ${formatInr(entry.amountPaise)}`);
    }

    if (summary.byItemCategory.length > 0) {
        lines.push('', '*Item classification*');
        for (const entry of summary.byItemCategory.slice(0, 8)) {
            const value = entry.amountPaise > 0 ? ` | ${formatInr(entry.amountPaise)} itemized` : '';
            lines.push(`• ${ITEM_LABELS[entry.key] || entry.key}: ${entry.count} item(s)${value}`);
        }
        lines.push(`Itemized line-value coverage: ${formatInr(summary.itemizedLinePaise)} of ${formatInr(summary.debitsPaise)}`);
    } else if (summary.transactionCount > 0) {
        lines.push('', '_No itemized order or receipt lines were available, so categories were not guessed from payment totals._');
    }

    if (report.smsCoverage?.complete) {
        const scannedThrough = new Date(report.smsCoverage.scannedThrough).toLocaleString('en-IN', { timeZone: TIME_ZONE });
        lines.push(
            '',
            `SMS inbox coverage: ${report.smsCoverage.inboxMessageCount} messages scanned through ${scannedThrough}`,
            `Financial transaction alerts selected: ${report.smsCoverage.transactionCandidateCount}`
        );
    }

    const sourceCounts = Object.entries(report.sourceCounts || {}).filter(([, count]) => count > 0);
    if (sourceCounts.length > 0) {
        lines.push('', `Sources: ${sourceCounts.map(([source, count]) => `${source.replace(/_/g, ' ')} ${count}`).join(', ')}`);
    }
    if ((report.itemSourceCounts?.swiggy_mcp || 0) > 0) {
        lines.push(`Swiggy order-history matches: ${report.itemSourceCounts.swiggy_mcp}`);
    }
    if (report.warnings?.length) {
        lines.push('', '*Coverage notes*');
        for (const warning of report.warnings.slice(0, 4)) lines.push(`• ${warning}`);
    }
    lines.push('', 'Detailed categorized transactions are attached as HTML.');
    return lines.join('\n').slice(0, 3900);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderBudgetHtml(report) {
    const transactionRows = report.transactions.map(transaction => {
        const items = transaction.items?.length
            ? `<ul>${transaction.items.map(item => { const category = canonicalItemCategory(item.category); return `<li>${escapeHtml(item.name)}${item.quantity ? ` (${escapeHtml(item.quantity)})` : ''} — ${escapeHtml(ITEM_LABELS[category] || category)}${item.lineAmountPaise ? `, ${escapeHtml(formatInr(item.lineAmountPaise))}` : ''}</li>`; }).join('')}</ul>`
            : '<span class="muted">No itemized receipt data</span>';
        const duplicateReason = (transaction.duplicateReasons || [])
            .map(reason => DUPLICATE_REASON_LABELS[reason] || reason)
            .join('; ');
        const duplicateTimes = (transaction.matchedAlertTimes || [])
            .map(value => new Date(value).toLocaleString('en-IN', { timeZone: TIME_ZONE }))
            .join(' · ');
        const dedupe = transaction.duplicateCount > 0
            ? `<br><span class="muted">${escapeHtml(transaction.duplicateCount)} duplicate alert(s) merged${duplicateReason ? ` — ${escapeHtml(duplicateReason)}` : ''}${duplicateTimes ? `<br>${escapeHtml(duplicateTimes)}` : ''}</span>`
            : '';
        const itemSources = transaction.itemSources?.length
            ? `<br><span class="muted">Items: ${escapeHtml(transaction.itemSources.join(', '))}</span>`
            : '';
        return `<tr><td>${escapeHtml(new Date(transaction.occurredAt).toLocaleString('en-IN', { timeZone: TIME_ZONE }))}</td><td>${escapeHtml(transaction.merchant)}</td><td>${escapeHtml(CHANNEL_LABELS[transaction.channelCategory] || transaction.channelCategory)}</td><td>${escapeHtml(transaction.direction)}</td><td class="amount">${escapeHtml(formatInr(transaction.amountPaise))}</td><td>${items}</td><td>${escapeHtml(transaction.sources.join(', '))}${itemSources}${dedupe}</td></tr>`;
    }).join('');
    const categoryRows = report.summary.byChannel.map(entry => `<tr><td>${escapeHtml(CHANNEL_LABELS[entry.key] || entry.key)}</td><td class="amount">${escapeHtml(formatInr(entry.amountPaise))}</td></tr>`).join('');
    const itemCategoryRows = report.summary.byItemCategory.map(entry => `<tr><td>${escapeHtml(ITEM_LABELS[entry.key] || entry.key)}</td><td>${escapeHtml(entry.count)}</td><td class="amount">${entry.amountPaise > 0 ? escapeHtml(formatInr(entry.amountPaise)) : '<span class="muted">No explicit line value</span>'}</td></tr>`).join('');
    const smsCoverage = report.smsCoverage?.complete
        ? `<section><h2>SMS coverage</h2><p>${escapeHtml(report.smsCoverage.inboxMessageCount)} inbox messages scanned through ${escapeHtml(new Date(report.smsCoverage.scannedThrough).toLocaleString('en-IN', { timeZone: TIME_ZONE }))}; ${escapeHtml(report.smsCoverage.transactionCandidateCount)} financial transaction alerts selected.</p></section>`
        : '';
    const swiggyCoverage = report.swiggyCoverage?.enabled
        ? `<section><h2>Swiggy order-history coverage</h2><p>${escapeHtml(report.swiggyCoverage.matchedOrderCount || 0)} of ${escapeHtml(report.swiggyCoverage.consideredOrderCount || 0)} cached order(s) in this month were uniquely matched to bank payments. Instamart exposes a rolling 15-day source window; the encrypted cache retains successful syncs for ${escapeHtml(report.swiggyCoverage.cacheRetentionDays || 90)} days.</p></section>`
        : '';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Monthly Budget Report — ${escapeHtml(report.label)}</title><style>body{font-family:Segoe UI,Arial,sans-serif;margin:32px;color:#1f2937;background:#f8fafc}main{max-width:1200px;margin:auto}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card,section{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin:16px 0}.value{font-size:1.7rem;font-weight:700;color:#0f766e}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top}.amount{white-space:nowrap;text-align:right}.muted,.notes{color:#64748b}ul{margin:0;padding-left:20px}@media(max-width:720px){body{margin:12px}table{font-size:12px}}</style></head><body><main><h1>Monthly Budget Report</h1><p class="muted">${escapeHtml(report.label)} · Generated ${escapeHtml(new Date(report.generatedAt).toLocaleString('en-IN', { timeZone: TIME_ZONE }))}</p><div class="cards"><div class="card"><div>Net spend</div><div class="value">${escapeHtml(formatInr(report.summary.netPaise))}</div></div><div class="card"><div>Debits</div><div class="value">${escapeHtml(formatInr(report.summary.debitsPaise))}</div></div><div class="card"><div>Refunds</div><div class="value">${escapeHtml(formatInr(report.summary.refundsPaise))}</div></div><div class="card"><div>Transactions</div><div class="value">${report.summary.transactionCount}</div></div><div class="card"><div>Duplicate alerts merged</div><div class="value">${report.summary.duplicateRecordsMerged || 0}</div></div></div>${smsCoverage}${swiggyCoverage}<section><h2>Channel totals</h2><table><thead><tr><th>Category</th><th class="amount">Amount</th></tr></thead><tbody>${categoryRows || '<tr><td colspan="2">No transactions found.</td></tr>'}</tbody></table></section><section><h2>Item-category totals</h2><p class="muted">Only explicit item prices are totaled; the bank payment remains the financial source of truth.</p><table><thead><tr><th>Category</th><th>Items</th><th class="amount">Explicit line value</th></tr></thead><tbody>${itemCategoryRows || '<tr><td colspan="3">No itemized order or receipt data was available.</td></tr>'}</tbody></table></section><section><h2>Transactions and item categories</h2><table><thead><tr><th>Date</th><th>Merchant</th><th>Channel</th><th>Direction</th><th class="amount">Amount</th><th>Order / receipt items</th><th>Sources / duplicate matching</th></tr></thead><tbody>${transactionRows || '<tr><td colspan="7">No matching transactions found.</td></tr>'}</tbody></table></section>${report.warnings.length ? `<section class="notes"><h2>Coverage notes</h2><ul>${report.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></section>` : ''}</main></body></html>`;
}

function publicTransaction(transaction) {
    const {
        sourceExcerpt,
        _dedupeFirstOccurredAt,
        _merchantCategoryLocked,
        _merchantClassificationCandidate,
        ...safe
    } = transaction;
    return {
        ...safe,
        channelCategory: canonicalChannelCategory(safe.channelCategory),
        items: (safe.items || []).map(item => ({
            ...item,
            category: canonicalItemCategory(item.category)
        }))
    };
}

async function generateMonthlyBudgetReport({
    period = 'current_month',
    now = new Date(),
    gmailAuthClient = null,
    gmailMaxMessages = DEFAULT_GMAIL_LIMIT,
    smsStorePath = null,
    smsStoreSecret = null,
    smsScanStatePath = null,
    requireCompleteSmsScan = true,
    smsScanMaxAgeMs = DEFAULT_SCAN_FRESHNESS_MS,
    classifyBatch = null,
    swiggyOrders = [],
    swiggyWarnings = [],
    swiggyCoverage = null,
    monthlyBudgetPaise = null,
    outputDirectory = resolveRuntimePath({
        envKey: 'BUDGET_REPORTS_DIR',
        relativeSegments: ['budget-reports'],
        legacyPath: path.join(getAgentDataDirectory(), 'budget-reports')
    })
}) {
    const window = getMonthWindow(period, now);
    let smsCoverage = { complete: false, reason: 'not_required', scan: null };
    if (requireCompleteSmsScan) {
        if (!smsStoreSecret) throw smsCoverageError('sms_secret_unavailable', window);
        smsCoverage = getCompleteSmsScanCoverage({
            scanStatePath: smsScanStatePath,
            window,
            now,
            maxAgeMs: smsScanMaxAgeMs
        });
        if (!smsCoverage.complete) throw smsCoverageError(smsCoverage.reason, window);
        if (smsCoverage.scan.transactionCandidateCount > 0 && (!smsStorePath || !fs.existsSync(smsStorePath))) {
            throw smsCoverageError('sms_store_missing', window);
        }
    }
    const sourceResults = await Promise.all([
        collectGmailReceiptTransactions({ authClient: gmailAuthClient, window, maxMessages: gmailMaxMessages }),
        Promise.resolve(collectAndroidSmsTransactions({
            storePath: smsStorePath,
            storeSecret: smsStoreSecret,
            window,
            coverageVerified: smsCoverage.complete
        }))
    ]);
    const warnings = [
        ...sourceResults.flatMap(result => result.warnings || []),
        ...(Array.isArray(swiggyWarnings) ? swiggyWarnings : [])
    ];
    let transactions = reconcileTransactions(sourceResults.flatMap(result => result.transactions || []));

    if (classifyBatch && transactions.length > 0) {
        const receiptTransactions = transactions.filter(transaction =>
            transaction.sourceType === 'receipt' && transaction.sourceExcerpt
        );
        for (let offset = 0; offset < receiptTransactions.length; offset += 12) {
            const batch = receiptTransactions.slice(offset, offset + 12);
            try {
                const enrichment = await classifyBatch(batch, 'receipt');
                const enriched = applyBudgetEnrichment(batch, enrichment);
                const byId = new Map(enriched.map(transaction => [transaction.id, transaction]));
                transactions = transactions.map(transaction => byId.get(transaction.id) || transaction);
            } catch (error) {
                warnings.push(`Gemini receipt-item categorization was unavailable for ${batch.length} transaction(s); deterministic merchants and monetary totals remain exact.`);
                console.error('Budget receipt categorization batch failed:', error.message || error);
            }
        }

        const smsMerchantGroups = new Map();
        for (const transaction of transactions.filter(isSmsMerchantClassificationCandidate)) {
            const key = normalizedMerchantKey(buildSmsMerchantEvidence(transaction));
            if (!key) continue;
            if (!smsMerchantGroups.has(key)) smsMerchantGroups.set(key, []);
            smsMerchantGroups.get(key).push(transaction);
        }
        const smsRepresentatives = [...smsMerchantGroups.values()].map(group => group[0]);
        const classifiedCategoryByMerchant = new Map();
        for (let offset = 0; offset < smsRepresentatives.length; offset += 12) {
            const batch = smsRepresentatives.slice(offset, offset + 12);
            try {
                const enrichment = await classifyBatch(batch, 'sms_merchant');
                const enriched = applySmsMerchantClassification(batch, enrichment);
                for (const transaction of enriched) {
                    const key = normalizedMerchantKey(buildSmsMerchantEvidence(transaction));
                    if (key) classifiedCategoryByMerchant.set(key, transaction.channelCategory);
                }
            } catch (error) {
                warnings.push(`Gemini merchant-name categorization was unavailable for ${batch.length} unique merchant(s); deterministic fallback categories and monetary totals remain exact.`);
                console.error('Budget merchant-name categorization batch failed:', error.message || error);
            }
        }
        if (classifiedCategoryByMerchant.size > 0) {
            transactions = transactions.map(transaction => {
                if (!isSmsMerchantClassificationCandidate(transaction)) return transaction;
                const key = normalizedMerchantKey(buildSmsMerchantEvidence(transaction));
                const channelCategory = classifiedCategoryByMerchant.get(key);
                return channelCategory ? { ...transaction, channelCategory } : transaction;
            });
        }
    }

    const swiggyOrdersInWindow = (Array.isArray(swiggyOrders) ? swiggyOrders : []).filter(order => {
        const occurredAtMs = new Date(order?.occurredAt).getTime();
        return Number.isFinite(occurredAtMs) && occurredAtMs >= window.startMs && occurredAtMs < window.endMs;
    });
    const swiggyAttachment = attachSwiggyOrdersToTransactions(transactions, swiggyOrdersInWindow);
    transactions = swiggyAttachment.transactions;
    warnings.push(...swiggyAttachment.warnings);

    const safeTransactions = transactions.map(publicTransaction);
    const sourceCounts = {};
    for (const transaction of safeTransactions) {
        for (const source of transaction.sources || [transaction.provider]) sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }
    const report = {
        monthKey: window.monthKey,
        label: window.label,
        generatedAt: new Date().toISOString(),
        smsCoverage: smsCoverage.complete ? {
            complete: true,
            scannedThrough: new Date(smsCoverage.scan.throughMs).toISOString(),
            inboxMessageCount: smsCoverage.scan.inboxMessageCount,
            transactionCandidateCount: smsCoverage.scan.transactionCandidateCount
        } : { complete: false },
        sourceCounts,
        itemSourceCounts: {
            swiggy_mcp: swiggyAttachment.matchedOrderCount
        },
        swiggyCoverage: {
            ...(swiggyCoverage || { enabled: false }),
            matchedOrderCount: swiggyAttachment.matchedOrderCount,
            consideredOrderCount: swiggyAttachment.consideredOrderCount
        },
        warnings: [...new Set(warnings)],
        transactions: safeTransactions,
        summary: summarizeBudget(safeTransactions, monthlyBudgetPaise)
    };
    report.whatsappMessage = formatBudgetWhatsApp(report);

    fs.mkdirSync(outputDirectory, { recursive: true });
    const jsonPath = path.join(outputDirectory, `budget_${window.monthKey}.json`);
    const htmlPath = path.join(outputDirectory, `budget_${window.monthKey}.html`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(htmlPath, renderBudgetHtml(report), 'utf8');
    return { report, jsonPath, htmlPath };
}

module.exports = {
    BUDGET_CRON_EXPRESSION,
    CHANNEL_LABELS,
    ITEM_LABELS,
    VALID_CHANNEL_CATEGORIES,
    GEMINI_MERCHANT_CATEGORIES,
    VALID_ITEM_CATEGORIES,
    canonicalChannelCategory,
    canonicalItemCategory,
    isTransferCategory,
    normalizePeriod,
    getMonthWindow,
    extractAmountPaise,
    identifyMerchant,
    classifyMerchantNameFallback,
    classifyItem,
    inferDirection,
    isPotentialPaymentText,
    createTransaction,
    extractGmailBody,
    loadBudgetGmailOAuthClient,
    collectGmailReceiptTransactions,
    collectAndroidSmsTransactions,
    reconcileTransactions,
    buildSmsMerchantEvidence,
    isSmsMerchantClassificationCandidate,
    buildMerchantCategoryPrompt,
    buildBudgetEnrichmentPrompt,
    applySmsMerchantClassification,
    applyBudgetEnrichment,
    normalizeTransactionItemCategories,
    attachSwiggyOrdersToTransactions,
    summarizeBudget,
    formatInr,
    formatBudgetWhatsApp,
    renderBudgetHtml,
    generateMonthlyBudgetReport,
    integerFromEnv
};
