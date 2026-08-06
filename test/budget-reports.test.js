const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    VALID_CHANNEL_CATEGORIES,
    GEMINI_MERCHANT_CATEGORIES,
    canonicalChannelCategory,
    canonicalItemCategory,
    getMonthWindow,
    extractAmountPaise,
    identifyMerchant,
    classifyMerchantNameFallback,
    classifyItem,
    normalizeBudgetCategoryRuleProposals,
    buildBudgetRuleMerchantMatchPrompt,
    createTransaction,
    reconcileTransactions,
    buildSmsMerchantEvidence,
    isSmsMerchantClassificationCandidate,
    projectSmsMerchantForGemini,
    buildMerchantCategoryPrompt,
    buildBudgetEnrichmentPrompt,
    applySmsMerchantClassification,
    applyBudgetEnrichment,
    attachSwiggyOrdersToTransactions,
    summarizeBudget,
    formatBudgetWhatsApp,
    renderBudgetHtml,
    collectAndroidSmsTransactions,
    generateMonthlyBudgetReport
} = require('../budget-reports');
const { encryptStoredSmsRecord, recordCompleteSmsScan } = require('../sms-ingestion');

test('builds exact Asia/Kolkata month boundaries', () => {
    const window = getMonthWindow('2026-07');
    assert.equal(window.start.toISOString(), '2026-06-30T18:30:00.000Z');
    assert.equal(window.end.toISOString(), '2026-07-31T18:30:00.000Z');
    assert.equal(window.monthKey, '2026-07');
});

test('extracts INR amounts and prefers an explicitly labelled grand total', () => {
    assert.equal(extractAmountPaise('INR 1,249.50 debited from your account'), 124950);
    assert.equal(extractAmountPaise('Subtotal ₹500, discount ₹100, grand total ₹430'), 43000);
    assert.equal(extractAmountPaise('Amount paid ₹ 2,050.25'), 205025);
    assert.equal(extractAmountPaise('Rs.500 paid to Zepto. Avl Bal Rs.10,000'), 50000);
});

test('does not count incoming credits as spending', () => {
    assert.equal(createTransaction({
        provider: 'android_sms',
        externalId: 'incoming-1',
        occurredAt: '2026-07-11T12:00:00Z',
        text: 'Payment received: INR 500 from Zomato',
        sourceType: 'sms'
    }), null);
    assert.equal(createTransaction({
        provider: 'android_sms',
        externalId: 'incoming-2',
        occurredAt: '2026-07-11T12:00:00Z',
        text: 'INR 500 credited to your account from Zomato',
        sourceType: 'sms'
    }), null);
    assert.equal(createTransaction({
        provider: 'android_sms',
        externalId: 'incoming-3',
        occurredAt: '2026-07-11T12:00:00Z',
        text: 'ICICIB Acct XX027 is credited with Rs 50,000.00 on 11-Jul-26 from GEETA MEHTA.',
        sourceType: 'sms'
    }), null);
});

test('redacts payment identifiers before receipt text can reach Gemini', () => {
    const transaction = createTransaction({
        provider: 'gmail_receipts',
        externalId: 'private-mail',
        occurredAt: '2026-07-11T12:00:00Z',
        text: 'Dear Ayush, paid ₹500 to Zepto via ayush.name@okhdfc UTR 1234 5678 9012 phone +91 98765 43210',
        sourceType: 'receipt'
    });
    assert.doesNotMatch(transaction.sourceExcerpt, /ayush\.name@okhdfc|1234 5678 9012|98765 43210/i);
    assert.match(transaction.sourceExcerpt, /\[upi id\]|\[payment reference\]/i);
});

test('maps named food and delivery platforms without confusing Instamart or Flipkart Minutes', () => {
    assert.deepEqual(identifyMerchant('Order from Swiggy Instamart'), { merchant: 'Swiggy Instamart', channelCategory: 'online_delivery' });
    assert.deepEqual(identifyMerchant('Paid ₹450 to Swiggy'), { merchant: 'Swiggy', channelCategory: 'online_food' });
    assert.deepEqual(identifyMerchant('Paid ₹450 to Zomato'), { merchant: 'Zomato', channelCategory: 'online_food' });
    assert.deepEqual(identifyMerchant('Paid ₹450 to Ownly'), { merchant: 'Ownly', channelCategory: 'online_food' });
    assert.deepEqual(identifyMerchant('Paid ₹450 to EatClub'), { merchant: 'EatClub', channelCategory: 'online_food' });
    assert.deepEqual(identifyMerchant('Blinkit payment successful'), { merchant: 'Blinkit', channelCategory: 'online_delivery' });
    assert.deepEqual(identifyMerchant('BigBasket invoice'), { merchant: 'BigBasket', channelCategory: 'online_delivery' });
    assert.deepEqual(identifyMerchant('Spent Rs.500 At WWWBIGBASKETCOM On 29/Jul/2026'), { merchant: 'BigBasket', channelCategory: 'online_delivery' });
    assert.deepEqual(identifyMerchant('Payment to ZeptoNow'), { merchant: 'Zepto', channelCategory: 'online_delivery' });
    assert.deepEqual(identifyMerchant('Payment to Flipkart Minutes'), { merchant: 'Flipkart Minutes', channelCategory: 'online_delivery' });
    assert.equal(identifyMerchant('Payment to Flipkart').channelCategory, 'shopping');
});

test('reserves Ayush Mehta variants for Ayush transfers without matching near names', () => {
    assert.deepEqual(
        identifyMerchant('Sent Rs.500 From HDFC Bank A/C XX123 To AYUSH MEHTA On 29/Jul/2026'),
        { merchant: 'Ayush Mehta', channelCategory: 'ayush_transfers' }
    );
    assert.deepEqual(
        identifyMerchant('Sent Rs.500 From HDFC Bank A/C XX123 To AYUSH BHAI MEHT On 29/Jul/2026'),
        { merchant: 'Ayush Mehta', channelCategory: 'ayush_transfers' }
    );
    assert.notEqual(
        identifyMerchant('Sent Rs.500 From HDFC Bank A/C XX123 To AYUSH MEHTANI On 29/Jul/2026').channelCategory,
        'ayush_transfers'
    );
});

test('maps Tata Payments to the reserved credit card payment category', () => {
    assert.deepEqual(
        identifyMerchant('INR 25,000 paid to TATA PAYMENTS'),
        { merchant: 'Tata Payments', channelCategory: 'credit_card_payment' }
    );
    assert.equal(VALID_CHANNEL_CATEGORIES.has('credit_card_payment'), true);
    assert.equal(GEMINI_MERCHANT_CATEGORIES.has('credit_card_payment'), false);
});

test('extracts merchants from recurring bank and payment-gateway templates', () => {
    assert.deepEqual(
        identifyMerchant('Sent Rs.500 From HDFC Bank A/C XX123 To JOHN DOE On 29/Jul/2026'),
        { merchant: 'John Doe', channelCategory: 'transfer' }
    );
    assert.deepEqual(
        identifyMerchant('Acct XX027 debited for Rs 40.00; BOTTLE LAB TECHNOLOGIES P credited.'),
        { merchant: 'Bottle Lab', channelCategory: 'office_cafeteria' }
    );
    assert.deepEqual(
        identifyMerchant('Transaction of Rs.2181.53 done for ELITE MINDSET has succeeded via PayU.'),
        { merchant: 'SuperYou', channelCategory: 'health' }
    );
    assert.deepEqual(
        identifyMerchant('Rs.154.08 refunded by SWIGGYFOOD on 29/Jul/2026'),
        { merchant: 'Swiggy', channelCategory: 'online_food' }
    );
    assert.deepEqual(
        identifyMerchant('INR 500 paid to JOHN DOE via UPI.'),
        { merchant: 'John Doe', channelCategory: 'transfer' }
    );
});

test('uses safe merchant-name fallbacks when Gemini is unavailable', () => {
    assert.equal(classifyMerchantNameFallback('John Doe', 'transfer'), 'transfer');
    assert.equal(classifyMerchantNameFallback('Subko Cofee Pvt Ltd', 'transfer'), 'misc_food');
    assert.equal(classifyMerchantNameFallback('Sharma Chaat Corner', 'transfer'), 'misc_food');
    assert.equal(classifyMerchantNameFallback('Teach To Lead', 'transfer'), 'donations');
    assert.equal(classifyMerchantNameFallback('Indian Motors A', 'transfer'), 'transport');
    assert.equal(classifyMerchantNameFallback('Zuchiz Private Limited', 'transfer'), 'misc_food');
    assert.equal(classifyMerchantNameFallback('Arliga Ecoworld Business', 'transfer'), 'miscellaneous');
});

test('keeps other known opaque legal merchants in Miscellaneous instead of over-interpreting them', () => {
    for (const merchant of ['GOZO VENTURES', 'ARLIGA ECOWORLD BUSINESS']) {
        const transaction = createTransaction({
            provider: 'android_sms',
            externalId: `opaque-${merchant}`,
            occurredAt: '2026-07-11T12:00:00Z',
            text: `INR 500 paid to ${merchant} via UPI.`,
            sourceType: 'sms'
        });
        assert.equal(transaction.channelCategory, 'miscellaneous');
        assert.equal(isSmsMerchantClassificationCandidate(transaction), false);
    }
});

test('labels foreign-currency transactions as Forex', () => {
    assert.deepEqual(
        identifyMerchant('Rs.2,180 spent on card at InfoNRS*USD24.99'),
        { merchant: 'Forex', channelCategory: 'forex' }
    );
    assert.deepEqual(
        identifyMerchant('INR 4,500 debited for an international purchase of EUR 48.20'),
        { merchant: 'Forex', channelCategory: 'forex' }
    );
    assert.deepEqual(
        identifyMerchant('INR 8,100 charged for 75.00 GBP'),
        { merchant: 'Forex', channelCategory: 'forex' }
    );
    assert.deepEqual(
        identifyMerchant('INR 950 charged for CNY 79.50'),
        { merchant: 'Forex', channelCategory: 'forex' }
    );
});

test('categorizes requested grocery examples deterministically', () => {
    for (const item of ['wheat flour', 'vegetables', 'paneer', 'milk', 'bread', 'butter']) {
        assert.equal(classifyItem(item), 'essential_groceries');
    }
    for (const item of ['protein bar', 'Diet Coke Zero', 'chips']) assert.equal(classifyItem(item), 'online_delivery');
    for (const item of ['isabgol', 'whey protein powder']) assert.equal(classifyItem(item), 'supplements');
    assert.equal(classifyItem('Kanda Poha'), 'poha');
    assert.equal(classifyItem('Paneer tikka', { channelCategory: 'online_food', merchant: 'Swiggy' }), 'online_food');
    assert.equal(classifyItem('Fresh paneer', { channelCategory: 'online_delivery', merchant: 'Swiggy Instamart' }), 'essential_groceries');
    assert.equal(classifyItem('Unknown imported drink', { channelCategory: 'online_delivery' }), 'online_delivery');
    assert.equal(canonicalItemCategory('non_essential_food'), 'online_delivery');
    assert.equal(canonicalItemCategory('restaurant_food'), 'online_food');
});

test('keeps documented utility and health merchant mappings stable', () => {
    for (const text of ['BESCOM electricity payment', 'water bill paid', 'broadband internet', 'Airtel recharge', 'Jio recharge', 'VI recharge']) {
        assert.equal(identifyMerchant(text).channelCategory, 'utilities');
    }
    for (const text of ['local pharmacy', 'PharmEasy', 'Netmeds', 'Apollo Pharmacy', '1mg', 'Medibuddy']) {
        assert.equal(identifyMerchant(text).channelCategory, 'health');
    }
});

test('aggregates legacy grocery categories into Online delivery', () => {
    const legacyDebit = {
        ...createTransaction({ provider: 'android_sms', externalId: 'legacy-grocery', occurredAt: '2026-07-12', text: '₹100 paid to Blinkit', sourceType: 'sms' }),
        channelCategory: 'quick_commerce'
    };
    const groceryDebit = createTransaction({ provider: 'android_sms', externalId: 'new-grocery', occurredAt: '2026-07-13', text: '₹200 paid to BigBasket', sourceType: 'sms' });
    const legacyRefund = {
        ...createTransaction({ provider: 'android_sms', externalId: 'legacy-refund', occurredAt: '2026-07-14', text: '₹50 refunded by Blinkit', sourceType: 'sms' }),
        channelCategory: 'quick_commerce'
    };
    const summary = summarizeBudget([legacyDebit, groceryDebit, legacyRefund]);
    assert.deepEqual(summary.byChannel, [{ key: 'online_delivery', amountPaise: 25000 }]);
    assert.equal(canonicalChannelCategory('quick_commerce'), 'online_delivery');
    assert.equal(canonicalChannelCategory('online_grocery'), 'online_delivery');
    assert.equal(canonicalChannelCategory('other'), 'miscellaneous');
});

test('normalizes a legacy Gemini quick-commerce result into Online delivery', () => {
    const transaction = createTransaction({
        provider: 'gmail_receipts', externalId: 'legacy-gemini-category', occurredAt: '2026-07-12',
        text: 'ACME GROCER grand total ₹100', sourceType: 'receipt'
    });
    const [enriched] = applyBudgetEnrichment([transaction], {
        transactions: [{ id: transaction.id, merchant: 'Acme Grocer', channel_category: 'quick_commerce', items: [] }]
    });
    assert.equal(enriched.channelCategory, 'online_delivery');
    assert.doesNotMatch(buildBudgetEnrichmentPrompt([transaction]), /quick_commerce|online_grocery/i);
});

test('reconciles a receipt and payment record instead of double-counting', () => {
    const payment = createTransaction({
        provider: 'android_sms',
        externalId: 'sms-1',
        occurredAt: '2026-07-10T12:00:00Z',
        text: 'INR 500 debited for Zepto order AB12345',
        sourceType: 'sms'
    });
    const receipt = createTransaction({
        provider: 'gmail_receipts',
        externalId: 'mail-1',
        occurredAt: '2026-07-10T12:05:00Z',
        text: 'Zepto order AB12345 amount paid ₹500',
        sourceType: 'receipt'
    });
    const reconciled = reconcileTransactions([payment, receipt]);
    assert.equal(reconciled.length, 1);
    assert.deepEqual(new Set(reconciled[0].sources), new Set(['android_sms', 'gmail_receipts']));
});

test('reconciles immediate bank and gateway alerts for one SMS purchase', () => {
    const gateway = createTransaction({
        provider: 'android_sms',
        externalId: 'gateway-alert',
        occurredAt: '2026-07-10T12:00:00Z',
        text: 'PAYUIB Transaction of Rs.65 done for BOTTLE LAB has succeeded via PayU.',
        sourceType: 'sms'
    });
    const bank = createTransaction({
        provider: 'android_sms',
        externalId: 'bank-alert',
        occurredAt: '2026-07-10T12:00:14Z',
        text: 'HDFCBK Spent Rs.65 At THE SMARTQ123 On 10/Jul/2026 using card XX1234.',
        sourceType: 'sms'
    });
    const reconciled = reconcileTransactions([gateway, bank]);
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].amountPaise, 6500);
    assert.equal(reconciled[0].sourceIds.length, 2);
});

test('reconciles near-identical bank purchase alerts but preserves separate transfers', () => {
    const firstPurchase = createTransaction({
        provider: 'android_sms', externalId: 'purchase-a', occurredAt: '2026-07-10T12:00:00Z',
        text: 'HDFCBK Spent Rs.154.08 At ZOMATO LIMITED On 10/Jul/2026.', sourceType: 'sms'
    });
    const duplicatePurchase = createTransaction({
        provider: 'android_sms', externalId: 'purchase-b', occurredAt: '2026-07-10T12:01:04Z',
        text: 'HDFCALT Spent Rs.154.08 At ZOMATO On 10/Jul/2026.', sourceType: 'sms'
    });
    const laterPurchase = createTransaction({
        provider: 'android_sms', externalId: 'purchase-c', occurredAt: '2026-07-10T12:04:00Z',
        text: 'HDFCBK Spent Rs.154.08 At ZOMATO On 10/Jul/2026.', sourceType: 'sms'
    });
    assert.equal(reconcileTransactions([firstPurchase, duplicatePurchase, laterPurchase]).length, 2);

    const transferA = createTransaction({
        provider: 'android_sms', externalId: 'transfer-a', occurredAt: '2026-07-10T13:00:00Z',
        text: 'HDFCBK Sent Rs.500 From HDFC Bank A/C XX123 To JOHN DOE On 10/Jul/2026.', sourceType: 'sms'
    });
    const transferB = createTransaction({
        provider: 'android_sms', externalId: 'transfer-b', occurredAt: '2026-07-10T13:00:10Z',
        text: 'HDFCBK Sent Rs.500 From HDFC Bank A/C XX123 To JANE DOE On 10/Jul/2026.', sourceType: 'sms'
    });
    assert.equal(reconcileTransactions([transferA, transferB]).length, 2);

    const ayushA = createTransaction({
        provider: 'android_sms', externalId: 'ayush-transfer-a', occurredAt: '2026-07-10T14:00:00Z',
        text: 'HDFCBK Sent Rs.500 From HDFC Bank A/C XX123 To AYUSH MEHTA On 10/Jul/2026.', sourceType: 'sms'
    });
    const ayushB = createTransaction({
        provider: 'android_sms', externalId: 'ayush-transfer-b', occurredAt: '2026-07-10T14:00:10Z',
        text: 'ICICIB Sent Rs.500 From ICICI Bank A/C XX456 To AYUSH MEHTA On 10/Jul/2026.', sourceType: 'sms'
    });
    assert.equal(reconcileTransactions([ayushA, ayushB]).length, 2);
});

test('reconciles matching refund alerts by exact cost and time', () => {
    const initiated = createTransaction({
        provider: 'android_sms', externalId: 'refund-a', occurredAt: '2026-07-10T12:00:00Z',
        text: 'APPALERT Refund of Rs.84 initiated by Zomato.', sourceType: 'sms'
    });
    const credited = createTransaction({
        provider: 'android_sms', externalId: 'refund-b', occurredAt: '2026-07-10T12:03:20Z',
        text: 'HDFCBK Rs.84 refund credited back by Zomato.', sourceType: 'sms'
    });
    const [reconciled] = reconcileTransactions([initiated, credited]);
    assert.equal(reconcileTransactions([initiated, credited]).length, 1);
    assert.equal(reconciled.direction, 'refund');
    assert.equal(reconciled.duplicateCount, 1);
    assert.deepEqual(reconciled.duplicateReasons, ['refund_same_amount_merchant_within_5m']);
    assert.deepEqual(reconciled.matchedAlertTimes, ['2026-07-10T12:00:00.000Z', '2026-07-10T12:03:20.000Z']);
    assert.equal(summarizeBudget([reconciled]).duplicateRecordsMerged, 1);
});

test('does not chain-merge refunds beyond five minutes from the first alert', () => {
    const makeRefund = (externalId, occurredAt, sender) => createTransaction({
        provider: 'android_sms', externalId, occurredAt,
        text: `${sender} Rs.84 refund credited back by Zomato.`, sourceType: 'sms'
    });
    const rows = reconcileTransactions([
        makeRefund('refund-chain-a', '2026-07-10T12:00:00Z', 'BANKA'),
        makeRefund('refund-chain-b', '2026-07-10T12:04:00Z', 'BANKB'),
        makeRefund('refund-chain-c', '2026-07-10T12:08:00Z', 'BANKC')
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows.reduce((sum, row) => sum + (row.duplicateCount || 0), 0), 1);
});

test('sends only a hashed id and extracted SMS merchant name to Gemini', () => {
    const transaction = createTransaction({
        provider: 'android_sms',
        externalId: 'private-sms',
        occurredAt: '2026-07-29T12:00:00Z',
        text: 'HDFCBK INR 1,234.50 spent at ACME KITCHENS on 29/Jul/2026 at 10:30 PM card XX1234. Avl Bal Rs.9,000.',
        sourceType: 'sms'
    });
    transaction.smsPrivacyValidated = true;
    const evidence = buildSmsMerchantEvidence(transaction);
    assert.match(evidence, /ACME KITCHENS/i);
    assert.doesNotMatch(evidence, /1,234\.50|29\/Jul\/2026|10:30|XX1234|9,000/i);
    const prompt = buildMerchantCategoryPrompt([transaction]);
    assert.doesNotMatch(prompt, /1,234\.50|29\/Jul\/2026|10:30|XX1234|9,000/i);
    const records = JSON.parse(prompt.split('Records:\n').at(-1));
    assert.deepEqual(records, [{ id: transaction.id, merchant: evidence }]);
    assert.deepEqual(Object.keys(records[0]), ['id', 'merchant']);

    const projection = projectSmsMerchantForGemini(transaction);
    assert.deepEqual(projection, { id: transaction.id, merchant: evidence });
    assert.deepEqual(Object.keys(projection), ['id', 'merchant']);
    for (const forbidden of [
        'sourceExcerpt', 'sender', 'amountPaise', 'occurredAt', 'provider',
        'sourceType', 'merchantRaw', 'sources', 'sourceIds', 'direction', 'currency'
    ]) {
        assert.equal(Object.hasOwn(projection, forbidden), false, `${forbidden} must not cross the Gemini boundary`);
    }
    assert.equal(buildMerchantCategoryPrompt([projection]), prompt);

    const embeddedIdentifiers = {
        ...transaction,
        merchant: 'John Doe 9876543210 john.doe@okhdfc'
    };
    assert.equal(buildSmsMerchantEvidence(embeddedIdentifiers), 'John Doe');
    assert.doesNotMatch(buildMerchantCategoryPrompt([embeddedIdentifiers]), /9876543210|john\.doe@okhdfc/i);
    assert.equal(buildSmsMerchantEvidence({ ...transaction, merchant: 'john.doe@okhdfc' }), '');
    assert.equal(projectSmsMerchantForGemini({ ...transaction, id: 'external-raw-id' }), null);
});

test('sends a transfer counterparty name but no transaction details to Gemini', () => {
    const transfer = createTransaction({
        provider: 'android_sms',
        externalId: 'private-transfer',
        occurredAt: '2026-07-29T12:00:00Z',
        text: 'HDFCBK Sent Rs.500 From HDFC Bank A/C XX123 To JOHN DOE On 29/Jul/2026.',
        sourceType: 'sms'
    });
    transfer.smsPrivacyValidated = true;
    const prompt = buildBudgetEnrichmentPrompt([transfer]);
    assert.match(prompt, /John Doe/);
    assert.doesNotMatch(prompt, /Rs\.500|HDFCBK|XX123|29\/Jul\/2026|From HDFC|Personal transfer/i);
    const records = JSON.parse(prompt.split('Records:\n').at(-1));
    assert.deepEqual(records, [{ id: transfer.id, merchant: 'John Doe' }]);
});

test('Gemini merchant classification changes only the SMS category', () => {
    const transaction = createTransaction({
        provider: 'android_sms',
        externalId: 'merchant-category-only',
        occurredAt: '2026-07-11T12:00:00Z',
        text: 'HDFCBK Sent Rs.500 From HDFC Bank A/C XX123 To GREEN LEAF CORNER On 11/Jul/2026.',
        sourceType: 'sms'
    });
    transaction.smsPrivacyValidated = true;
    transaction.items = [{ name: 'sentinel', category: 'other', lineAmountPaise: null }];
    assert.equal(isSmsMerchantClassificationCandidate(transaction), true);
    const before = structuredClone(transaction);
    const [enriched] = applySmsMerchantClassification([transaction], {
        transactions: [{
            id: transaction.id,
            entity_type: 'business',
            channel_category: 'misc_food',
            confidence: 0.99,
            merchant: 'Invented Cafe',
            amountPaise: 1,
            direction: 'refund',
            currency: 'USD',
            items: [{ name: 'Paneer', line_amount: '1', category: 'essential_groceries' }]
        }]
    });
    assert.deepEqual(enriched, { ...before, channelCategory: 'misc_food' });
});

test('Gemini maps people to Transfers and opaque names to Miscellaneous safely', () => {
    const person = createTransaction({
        provider: 'android_sms', externalId: 'person-ai', occurredAt: '2026-07-11T12:00:00Z',
        text: 'INR 500 paid to JOHN DOE via UPI.', sourceType: 'sms'
    });
    const opaque = createTransaction({
        provider: 'android_sms', externalId: 'opaque-ai', occurredAt: '2026-07-11T13:00:00Z',
        text: 'INR 500 paid to ARLIGA ECOWORLD BUSINESS via UPI.', sourceType: 'sms'
    });
    person.smsPrivacyValidated = true;
    opaque.smsPrivacyValidated = true;
    const results = applySmsMerchantClassification([person, opaque], {
        transactions: [
            { id: person.id, entity_type: 'person', channel_category: 'shopping', confidence: 0.96 },
            { id: opaque.id, entity_type: 'unknown', channel_category: 'services', confidence: 0.91 }
        ]
    });
    assert.equal(results[0].channelCategory, 'transfer');
    assert.equal(results[1].channelCategory, 'miscellaneous');
});

test('Gemini cannot override locked merchants, assign Ayush transfers, or add arbitrary categories', () => {
    const zepto = createTransaction({
        provider: 'android_sms', externalId: 'locked-zepto', occurredAt: '2026-07-11T12:00:00Z',
        text: 'INR 500 paid to Zepto via UPI.', sourceType: 'sms'
    });
    const ayush = createTransaction({
        provider: 'android_sms', externalId: 'locked-ayush', occurredAt: '2026-07-11T13:00:00Z',
        text: 'INR 500 paid to Ayush Mehta via UPI.', sourceType: 'sms'
    });
    const opaque = createTransaction({
        provider: 'android_sms', externalId: 'invalid-category', occurredAt: '2026-07-11T14:00:00Z',
        text: 'INR 500 paid to ARLIGA ECOWORLD BUSINESS via UPI.', sourceType: 'sms'
    });
    const results = applySmsMerchantClassification([zepto, ayush, opaque], {
        transactions: [
            { id: zepto.id, entity_type: 'business', channel_category: 'shopping', confidence: 1 },
            { id: ayush.id, entity_type: 'business', channel_category: 'misc_food', confidence: 1 },
            { id: opaque.id, entity_type: 'business', channel_category: 'luxury_coffee', confidence: 1 }
        ]
    });
    assert.equal(results[0].channelCategory, 'online_delivery');
    assert.equal(results[1].channelCategory, 'ayush_transfers');
    assert.equal(results[2].channelCategory, 'miscellaneous');
    assert.equal(VALID_CHANNEL_CATEGORIES.has('luxury_coffee'), false);
    assert.equal(GEMINI_MERCHANT_CATEGORIES.has('ayush_transfers'), false);
});

test('rejects low-confidence, duplicate-id, malformed, and unknown-merchant classifications', () => {
    const transaction = createTransaction({
        provider: 'android_sms', externalId: 'classification-validation', occurredAt: '2026-07-11T12:00:00Z',
        text: 'INR 500 paid to GREEN LEAF CORNER via UPI.', sourceType: 'sms'
    });
    transaction.smsPrivacyValidated = true;
    const lowConfidence = applySmsMerchantClassification([transaction], {
        transactions: [{ id: transaction.id, entity_type: 'business', channel_category: 'misc_food', confidence: 0.74 }]
    })[0];
    assert.equal(lowConfidence.channelCategory, transaction.channelCategory);

    const duplicateId = applySmsMerchantClassification([transaction], {
        transactions: [
            { id: transaction.id, entity_type: 'business', channel_category: 'misc_food', confidence: 1 },
            { id: transaction.id, entity_type: 'person', channel_category: 'transfer', confidence: 1 }
        ]
    })[0];
    assert.equal(duplicateId.channelCategory, transaction.channelCategory);
    assert.equal(applySmsMerchantClassification([transaction], null)[0].channelCategory, transaction.channelCategory);

    const unknown = createTransaction({
        provider: 'android_sms', externalId: 'unknown-name', occurredAt: '2026-07-11T13:00:00Z',
        text: 'INR 500 debited from account.', sourceType: 'sms'
    });
    assert.equal(unknown.merchant, 'Unknown merchant');
    assert.equal(isSmsMerchantClassificationCandidate(unknown), false);
    assert.deepEqual(JSON.parse(buildMerchantCategoryPrompt([unknown]).split('Records:\n').at(-1)), []);
});

test('Gemini enrichment cannot change deterministic monetary totals', () => {
    const transaction = createTransaction({
        provider: 'gmail_receipts',
        externalId: 'mail-2',
        occurredAt: '2026-07-11T12:00:00Z',
        text: 'Blinkit grand total ₹200 Paneer ₹120 Chips ₹80',
        sourceType: 'receipt'
    });
    const [enriched] = applyBudgetEnrichment([transaction], {
        transactions: [{
            id: transaction.id,
            merchant: 'Blinkit',
            channel_category: 'quick_commerce',
            amount: 999999,
            items: [
                { name: 'Paneer', line_amount: '120', category: 'essential_groceries', confidence: 0.99 },
                { name: 'Chips', line_amount: '80', category: 'non_essential_food', confidence: 0.99 }
            ]
        }]
    });
    assert.equal(enriched.amountPaise, 20000);
    assert.equal(enriched.items[0].lineAmountPaise, 12000);
    assert.equal(enriched.items[1].category, 'online_delivery');
});

test('attaches matched Swiggy order items without changing bank totals or transaction count', () => {
    const bankTransaction = createTransaction({
        provider: 'android_sms',
        externalId: 'instamart-bank-payment',
        occurredAt: '2026-07-18T12:00:00.000Z',
        text: 'INR 200 paid to Swiggy Instamart',
        sourceType: 'sms'
    });
    const result = attachSwiggyOrdersToTransactions([bankTransaction], [{
        provider: 'swiggy_instamart',
        orderIdHash: 'order-hash-1',
        occurredAt: '2026-07-18T12:05:00.000Z',
        payablePaise: 20000,
        items: [
            { name: 'Fresh paneer', quantity: '1', lineAmountPaise: 10000 },
            { name: 'Diet Coke Zero', quantity: '2', lineAmountPaise: 6000 }
        ],
        fees: [{ name: 'Delivery fee', quantity: '', lineAmountPaise: 4000 }]
    }]);
    assert.equal(result.matchedOrderCount, 1);
    assert.equal(result.transactions.length, 1);
    assert.equal(result.transactions[0].amountPaise, 20000);
    assert.equal(result.transactions[0].channelCategory, 'online_delivery');
    assert.deepEqual(result.transactions[0].items.map(item => item.category), [
        'essential_groceries', 'online_delivery', 'fees_taxes'
    ]);
    const summary = summarizeBudget(result.transactions);
    assert.equal(summary.netPaise, 20000);
    assert.equal(summary.itemizedLinePaise, 20000);
});

test('keeps ambiguous or unmatched Swiggy history out of spending totals', () => {
    const transactions = ['a', 'b'].map((externalId, index) => createTransaction({
        provider: 'android_sms',
        externalId,
        occurredAt: `2026-07-18T12:0${index}:00.000Z`,
        text: 'INR 300 paid to Swiggy',
        sourceType: 'sms'
    }));
    const result = attachSwiggyOrdersToTransactions(transactions, [{
        provider: 'swiggy_food',
        orderIdHash: 'ambiguous-order',
        occurredAt: '2026-07-18T12:02:00.000Z',
        payablePaise: 30000,
        items: [{ name: 'Poha', quantity: '1', lineAmountPaise: 30000 }]
    }]);
    assert.equal(result.matchedOrderCount, 0);
    assert.equal(result.transactions.reduce((sum, transaction) => sum + transaction.amountPaise, 0), 60000);
    assert.ok(result.transactions.every(transaction => transaction.items.length === 0));
    assert.match(result.warnings[0], /not counted as spending/i);
});

test('does not attach Swiggy history to Zomato or another online-delivery platform', () => {
    const transactions = [
        createTransaction({
            provider: 'android_sms', externalId: 'zomato-same-value', occurredAt: '2026-07-18T12:00:00.000Z',
            text: 'INR 250 paid to Zomato', sourceType: 'sms'
        }),
        createTransaction({
            provider: 'android_sms', externalId: 'zepto-same-value', occurredAt: '2026-07-18T12:00:00.000Z',
            text: 'INR 250 paid to Zepto', sourceType: 'sms'
        })
    ];
    const orders = [
        { provider: 'swiggy_food', orderIdHash: 'food-cross-platform', occurredAt: '2026-07-18T12:01:00.000Z', payablePaise: 25000, items: [{ name: 'Poha' }] },
        { provider: 'swiggy_instamart', orderIdHash: 'im-cross-platform', occurredAt: '2026-07-18T12:01:00.000Z', payablePaise: 25000, items: [{ name: 'Paneer' }] }
    ];
    const result = attachSwiggyOrdersToTransactions(transactions, orders);
    assert.equal(result.matchedOrderCount, 0);
    assert.ok(result.transactions.every(transaction => transaction.items.length === 0));
});

test('receipt enrichment cannot assign reserved categories or bypass a locked merchant', () => {
    const unresolved = createTransaction({
        provider: 'gmail_receipts', externalId: 'reserved-receipt', occurredAt: '2026-07-11T12:00:00Z',
        text: 'Unrecognized invoice grand total ₹100', sourceType: 'receipt'
    });
    const locked = createTransaction({
        provider: 'gmail_receipts', externalId: 'locked-receipt', occurredAt: '2026-07-11T13:00:00Z',
        text: 'TATA PAYMENTS L grand total ₹200', sourceType: 'receipt'
    });
    const results = applyBudgetEnrichment([unresolved, locked], {
        transactions: [
            { id: unresolved.id, merchant: 'Unrecognized', channel_category: 'ayush_transfers', items: [] },
            { id: locked.id, merchant: 'Tata Payments', channel_category: 'health', items: [] }
        ]
    });
    assert.equal(results[0].channelCategory, 'miscellaneous');
    assert.equal(results[1].channelCategory, 'credit_card_payment');

    const forexAttempt = applyBudgetEnrichment([unresolved], {
        transactions: [{ id: unresolved.id, merchant: 'Unrecognized', channel_category: 'forex', items: [] }]
    })[0];
    assert.equal(forexAttempt.channelCategory, 'miscellaneous');
});

test('rejects Gemini items and prices that are not evidenced by the receipt', () => {
    const transaction = createTransaction({
        provider: 'gmail_receipts',
        externalId: 'mail-evidence',
        occurredAt: '2026-07-11T12:00:00Z',
        text: 'Blinkit grand total ₹200 Paneer ₹120 Chips ₹80',
        sourceType: 'receipt'
    });
    const [enriched] = applyBudgetEnrichment([transaction], {
        transactions: [{
            id: transaction.id,
            merchant: '=IMPORTXML("https://evil.invalid")',
            channel_category: 'utilities',
            items: [
                { name: 'Paneer', line_amount: '999999', category: 'supplements' },
                { name: '=HYPERLINK("https://evil.invalid","Protein powder")', line_amount: '80', category: 'supplements' }
            ]
        }]
    });
    assert.equal(enriched.merchant, 'Blinkit');
    assert.equal(enriched.channelCategory, 'online_delivery');
    assert.equal(enriched.items.length, 1);
    assert.equal(enriched.items[0].name, 'Paneer');
    assert.equal(enriched.items[0].category, 'essential_groceries');
    assert.equal(enriched.items[0].lineAmountPaise, null);
});

test('summarizes debits and refunds using integer paise', () => {
    const debit = createTransaction({ provider: 'android_sms', externalId: 'd', occurredAt: '2026-07-12', text: '₹100.10 paid to Zomato', sourceType: 'sms' });
    const refund = createTransaction({ provider: 'android_sms', externalId: 'r', occurredAt: '2026-07-13', text: '₹20.05 refunded by Zomato', sourceType: 'sms' });
    const summary = summarizeBudget([debit, refund], 20000);
    assert.equal(summary.debitsPaise, 10010);
    assert.equal(summary.refundsPaise, 2005);
    assert.equal(summary.netPaise, 8005);
    assert.equal(summary.remainingPaise, 11995);
});

test('shows Ayush transfers and Tata card payments separately without counting them as expenses', () => {
    const expense = createTransaction({ provider: 'android_sms', externalId: 'expense', occurredAt: '2026-07-12', text: 'INR 450 paid to Zomato', sourceType: 'sms' });
    const ayushTransfer = createTransaction({ provider: 'android_sms', externalId: 'ayush', occurredAt: '2026-07-13', text: 'INR 1000 sent to Ayush Mehta', sourceType: 'sms' });
    const cardPayment = createTransaction({ provider: 'android_sms', externalId: 'card', occurredAt: '2026-07-14', text: 'INR 25000 paid to Tata Payments', sourceType: 'sms' });
    const summary = summarizeBudget([expense, ayushTransfer, cardPayment], 5000000);

    assert.equal(summary.debitsPaise, 45000);
    assert.equal(summary.netPaise, 45000);
    assert.equal(summary.remainingPaise, 4955000);
    assert.equal(summary.transactionCount, 1);
    assert.equal(summary.totalTransactionCount, 3);
    assert.equal(summary.excludedTransactionCount, 2);
    assert.equal(summary.excludedNetPaise, 2600000);
    assert.deepEqual(summary.byChannel, [{ key: 'online_food', amountPaise: 45000 }]);
    assert.deepEqual(summary.excludedByChannel, [
        { key: 'credit_card_payment', amountPaise: 2500000 },
        { key: 'ayush_transfers', amountPaise: 100000 }
    ]);

    const report = {
        label: 'July 2026',
        generatedAt: '2026-07-31T18:30:00.000Z',
        summary,
        sourceCounts: { android_sms: 3 },
        warnings: [],
        transactions: [expense, ayushTransfer, cardPayment]
    };
    assert.match(formatBudgetWhatsApp(report), /excluded from budget spend/i);
    assert.match(formatBudgetWhatsApp(report), /Credit card payment/);
    assert.match(renderBudgetHtml(report), /Excluded money movements/);
});

test('reports missing itemization honestly instead of allocating payment totals', () => {
    const transaction = createTransaction({ provider: 'android_sms', externalId: 'x', occurredAt: '2026-07-12', text: '₹650 paid to Zepto', sourceType: 'sms' });
    const report = {
        label: 'July 2026',
        summary: summarizeBudget([transaction]),
        sourceCounts: { android_sms: 1 },
        warnings: [],
        transactions: [transaction]
    };
    assert.match(formatBudgetWhatsApp(report), /were not guessed from payment totals/i);
});

test('reads encrypted Android financial SMS records for the selected month', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-sms-'));
    const storePath = path.join(directory, 'sms.enc.jsonl');
    const secret = 'a-secure-test-secret-that-is-long-enough';
    const record = {
        id: 'record-1',
        occurredAt: '2026-07-14T10:00:00.000Z',
        sender: 'HDFCBK',
        body: 'INR 450 debited for Blinkit order'
    };
    fs.writeFileSync(storePath, `${JSON.stringify(encryptStoredSmsRecord(record, secret))}\n`, 'utf8');
    try {
        const result = collectAndroidSmsTransactions({ storePath, storeSecret: secret, window: getMonthWindow('2026-07') });
        assert.equal(result.transactions.length, 1);
        assert.equal(result.transactions[0].merchant, 'Blinkit');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('merges historical copies of one SMS accepted under different companion installations', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-sms-cross-install-'));
    const storePath = path.join(directory, 'sms.enc.jsonl');
    const secret = 'historical-cross-install-secret-at-least-32-characters';
    const records = [
        {
            id: 'legacy-device-one-id',
            occurredAt: '2026-08-04T10:15:00.000Z',
            sender: 'AX-HDFCBK',
            body: 'INR 500 debited at ZEPTO'
        },
        {
            id: 'legacy-device-two-id',
            occurredAt: '2026-08-04T10:15:00.000Z',
            sender: 'AX-HDFCBK',
            body: 'INR 500 debited at ZEPTO'
        }
    ];
    fs.writeFileSync(
        storePath,
        `${records.map(record => JSON.stringify(encryptStoredSmsRecord(record, secret))).join('\n')}\n`,
        'utf8'
    );
    try {
        const collected = collectAndroidSmsTransactions({
            storePath,
            storeSecret: secret,
            window: getMonthWindow('2026-08')
        });
        const reconciled = reconcileTransactions(collected.transactions);
        assert.equal(collected.transactions.length, 2, 'source aliases stay available for Google Sheets reconciliation');
        assert.equal(reconciled.length, 1);
        assert.equal(reconciled[0].duplicateCount, 1);
        assert.deepEqual(reconciled[0].duplicateReasons, ['repeated_companion_sync']);
        assert.equal(reconciled[0].sourceIds.length, 2);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('revalidates encrypted historical SMS before budget parsing or Gemini eligibility', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-sms-privacy-'));
    const storePath = path.join(directory, 'sms.enc.jsonl');
    const secret = 'privacy-boundary-test-secret-that-is-long-enough';
    const records = [
        { id: 'valid', occurredAt: '2026-07-14T10:00:00.000Z', sender: 'HDFCBK', body: 'INR 450 paid at GREEN LEAF CAFE' },
        { id: 'personal', occurredAt: '2026-07-14T10:01:00.000Z', sender: '[phone]', body: 'I paid INR 450 for dinner' },
        { id: 'otp', occurredAt: '2026-07-14T10:02:00.000Z', sender: 'HDFCBK', body: 'OTP 123456 for transaction of INR 450' },
        { id: 'promo', occurredAt: '2026-07-14T10:03:00.000Z', sender: 'ZEPTON', body: 'Get INR 450 cashback when you shop now' },
        { id: 'balance', occurredAt: '2026-07-14T10:04:00.000Z', sender: 'HDFCBK', body: 'Available balance is INR 45,000' },
        { id: 'statement', occurredAt: '2026-07-14T10:05:00.000Z', sender: 'HDFCCB', body: 'Statement generated. Amount due INR 450' }
    ];
    fs.writeFileSync(
        storePath,
        `${records.map(record => JSON.stringify(encryptStoredSmsRecord(record, secret))).join('\n')}\n`,
        'utf8'
    );
    try {
        const result = collectAndroidSmsTransactions({
            storePath,
            storeSecret: secret,
            window: getMonthWindow('2026-07')
        });
        assert.equal(result.transactions.length, 1);
        assert.equal(result.transactions[0].merchant, 'Green Leaf Cafe');
        assert.match(result.warnings.join(' '), /Ignored 5 stored SMS record\(s\).*privacy validation/i);
        assert.deepEqual(projectSmsMerchantForGemini(result.transactions[0]), {
            id: result.transactions[0].id,
            merchant: 'Green Leaf Cafe'
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('end-to-end SMS budget path exposes only sanitized merchant projections to every Gemini hook', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-sms-llm-boundary-'));
    const storePath = path.join(directory, 'sms.enc.jsonl');
    const outputDirectory = path.join(directory, 'reports');
    const secret = 'end-to-end-privacy-secret-that-is-long-enough';
    const privateTokens = [
        'HDFCBK', '1,234.50', '9876', '29/Jul/2026', '10:30', 'N123456789',
        'I paid INR 888 for dinner', '+919999999999'
    ];
    const records = [
        {
            id: 'valid-private-source',
            occurredAt: '2026-07-14T10:00:00.000Z',
            sender: 'HDFCBK',
            body: 'INR 1,234.50 paid to SECRET CAFE 9876 via UPI on 29/Jul/2026 at 10:30; UTR N123456789.'
        },
        {
            id: 'personal-source',
            occurredAt: '2026-07-14T10:01:00.000Z',
            sender: '+919999999999',
            body: 'I paid INR 888 for dinner, send me your half.'
        }
    ];
    fs.writeFileSync(
        storePath,
        `${records.map(record => JSON.stringify(encryptStoredSmsRecord(record, secret))).join('\n')}\n`,
        'utf8'
    );
    const merchantClassifierCalls = [];
    const categoryMatcherCalls = [];
    const categoryRules = normalizeBudgetCategoryRuleProposals([{
        category_label: 'Eating Out',
        merchant_types: ['food_business']
    }]);
    try {
        const result = await generateMonthlyBudgetReport({
            period: '2026-07',
            now: new Date('2026-07-30T08:00:00.000Z'),
            requireCompleteSmsScan: false,
            smsStorePath: storePath,
            smsStoreSecret: secret,
            outputDirectory,
            categoryRules,
            classifyBatch: async (batch, mode) => {
                assert.equal(mode, 'sms_merchant');
                merchantClassifierCalls.push(structuredClone(batch));
                assert.deepEqual(batch, [{ id: batch[0].id, merchant: 'Secret Cafe' }]);
                const prompt = buildMerchantCategoryPrompt(batch);
                for (const token of privateTokens) assert.doesNotMatch(prompt, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
                return {
                    transactions: [{
                        id: batch[0].id,
                        entity_type: 'business',
                        channel_category: 'misc_food',
                        confidence: 0.99
                    }]
                };
            },
            matchCategoryRules: async (batch, rules) => {
                categoryMatcherCalls.push(structuredClone(batch));
                assert.deepEqual(batch, [{ id: batch[0].id, merchant: 'Secret Cafe' }]);
                const prompt = buildBudgetRuleMerchantMatchPrompt(batch, rules);
                for (const token of privateTokens) assert.doesNotMatch(prompt, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
                return { matches: [{ id: batch[0].id, rule_ids: [rules[0].id] }] };
            }
        });
        assert.equal(merchantClassifierCalls.length, 1);
        assert.equal(categoryMatcherCalls.length, 1);
        assert.equal(result.report.transactions.length, 1, 'the personal SMS must not enter the report pipeline');
        assert.equal(result.report.transactions[0].merchant, 'Secret Cafe 9876');
        assert.match(result.report.transactions[0].channelCategory, /^custom_eating_out_/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('reports an encrypted SMS store whose secret is unavailable', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-sms-'));
    const storePath = path.join(directory, 'sms.enc.jsonl');
    fs.writeFileSync(storePath, '{}\n', 'utf8');
    try {
        const result = collectAndroidSmsTransactions({ storePath, storeSecret: null, window: getMonthWindow('2026-07') });
        assert.equal(result.transactions.length, 0);
        assert.match(result.warnings[0], /secret is unavailable/i);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('requires completed SMS coverage and creates no report files when it is missing or stale', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-report-'));
    const outputDirectory = path.join(directory, 'reports');
    const scanStatePath = path.join(directory, 'scan-state.json');
    const secret = 'required-coverage-secret-at-least-32-characters';
    const now = new Date('2026-07-30T08:00:00.000Z');
    const window = getMonthWindow('2026-07');
    try {
        await assert.rejects(
            generateMonthlyBudgetReport({
                period: '2026-07',
                now,
                smsStoreSecret: secret,
                smsScanStatePath: scanStatePath,
                outputDirectory
            }),
            error => error.code === 'SMS_SCAN_REQUIRED' && error.coverageReason === 'missing_scan_state'
        );
        assert.equal(fs.existsSync(outputDirectory), false);

        recordCompleteSmsScan({
            scanStatePath,
            deviceId: 'test-phone',
            scan: {
                id: 'stale_scan_20260701',
                monthKey: '2026-07',
                fromMs: window.startMs,
                throughMs: window.startMs + 24 * 60 * 60 * 1000,
                inboxMessageCount: 20,
                transactionCandidateCount: 0,
                complete: true
            },
            completedAt: new Date(window.startMs + 24 * 60 * 60 * 1000)
        });
        await assert.rejects(
            generateMonthlyBudgetReport({
                period: '2026-07',
                now,
                smsStoreSecret: secret,
                smsScanStatePath: scanStatePath,
                outputDirectory
            }),
            error => error.code === 'SMS_SCAN_REQUIRED' && error.coverageReason === 'scan_is_stale'
        );
        assert.equal(fs.existsSync(outputDirectory), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('generates HTML from an encrypted transaction after a valid full SMS scan', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-report-sms-'));
    const outputDirectory = path.join(directory, 'reports');
    const storePath = path.join(directory, 'sms.enc.jsonl');
    const scanStatePath = path.join(directory, 'scan-state.json');
    const secret = 'valid-full-scan-secret-at-least-32-characters';
    const now = new Date('2026-07-30T08:00:00.000Z');
    const window = getMonthWindow('2026-07');
    const record = {
        id: 'record-for-full-scan',
        occurredAt: '2026-07-14T10:00:00.000Z',
        sender: 'HDFCBK',
        body: 'INR 450 debited for Blinkit order BLINK12345'
    };
    fs.writeFileSync(storePath, `${JSON.stringify(encryptStoredSmsRecord(record, secret))}\n`, 'utf8');
    recordCompleteSmsScan({
        scanStatePath,
        deviceId: 'test-phone',
        scan: {
            id: 'complete_scan_20260730',
            monthKey: '2026-07',
            fromMs: window.startMs,
            throughMs: now.getTime(),
            inboxMessageCount: 120,
            transactionCandidateCount: 1,
            complete: true
        },
        completedAt: now
    });
    try {
        const result = await generateMonthlyBudgetReport({
            period: '2026-07',
            now,
            smsStorePath: storePath,
            smsStoreSecret: secret,
            smsScanStatePath: scanStatePath,
            outputDirectory
        });
        assert.equal(result.report.summary.netPaise, 45000);
        assert.equal(result.report.transactions[0].merchant, 'Blinkit');
        assert.equal(result.report.sourceCounts.android_sms, 1);
        assert.deepEqual(result.report.smsCoverage, {
            complete: true,
            scannedThrough: now.toISOString(),
            inboxMessageCount: 120,
            transactionCandidateCount: 1
        });
        assert.equal(fs.existsSync(result.htmlPath), true);
        assert.equal(fs.existsSync(result.jsonPath), true);
        assert.match(fs.readFileSync(result.htmlPath, 'utf8'), /Monthly Budget Report/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('monthly report enriches a matched Swiggy payment and renders item-category totals', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-report-swiggy-'));
    const storePath = path.join(directory, 'sms.enc.jsonl');
    const secret = 'swiggy-report-cache-secret-at-least-32-characters';
    fs.writeFileSync(storePath, `${JSON.stringify(encryptStoredSmsRecord({
        id: 'swiggy-payment',
        occurredAt: '2026-07-20T12:00:00.000Z',
        sender: 'HDFCBK',
        body: 'INR 200 paid to Swiggy Instamart'
    }, secret))}\n`, 'utf8');
    try {
        const result = await generateMonthlyBudgetReport({
            period: '2026-07',
            now: new Date('2026-07-30T08:00:00.000Z'),
            requireCompleteSmsScan: false,
            smsStorePath: storePath,
            smsStoreSecret: secret,
            swiggyOrders: [{
                provider: 'swiggy_instamart',
                orderIdHash: 'monthly-swiggy-order',
                occurredAt: '2026-07-20T12:02:00.000Z',
                payablePaise: 20000,
                items: [
                    { name: 'Paneer', quantity: 1, lineAmountPaise: 12000 },
                    { name: 'Diet Coke', quantity: 1, lineAmountPaise: 8000 }
                ]
            }],
            swiggyCoverage: { enabled: true, cacheRetentionDays: 90 },
            outputDirectory: path.join(directory, 'reports')
        });
        assert.equal(result.report.summary.netPaise, 20000);
        assert.equal(result.report.summary.transactionCount, 1);
        assert.equal(result.report.itemSourceCounts.swiggy_mcp, 1);
        assert.deepEqual(result.report.summary.byItemCategory.map(entry => entry.key), [
            'essential_groceries', 'online_delivery'
        ]);
        const html = fs.readFileSync(result.htmlPath, 'utf8');
        assert.match(html, /Item-category totals/);
        assert.match(html, /Essential grocery/);
        assert.match(html, /Diet Coke/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('classifies each unresolved SMS merchant once and propagates the category', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-merchant-ai-'));
    const outputDirectory = path.join(directory, 'reports');
    const storePath = path.join(directory, 'sms.enc.jsonl');
    const scanStatePath = path.join(directory, 'scan-state.json');
    const secret = 'merchant-ai-scan-secret-at-least-32-characters';
    const now = new Date('2026-07-30T08:00:00.000Z');
    const window = getMonthWindow('2026-07');
    const records = [
        { id: 'green-1', occurredAt: '2026-07-14T10:00:00.000Z', sender: 'HDFCBK', body: 'INR 100 paid to GREEN LEAF CORNER via UPI.' },
        { id: 'green-2', occurredAt: '2026-07-14T10:00:10.000Z', sender: 'ICICIB', body: 'INR 100 paid to GREEN LEAF CORNER via UPI.' },
        { id: 'person-1', occurredAt: '2026-07-16T10:00:00.000Z', sender: 'HDFCBK', body: 'INR 300 paid to JOHN DOE via UPI.' },
        { id: 'zepto-1', occurredAt: '2026-07-17T10:00:00.000Z', sender: 'HDFCBK', body: 'INR 400 paid to Zepto via UPI.' }
    ];
    fs.writeFileSync(
        storePath,
        `${records.map(record => JSON.stringify(encryptStoredSmsRecord(record, secret))).join('\n')}\n`,
        'utf8'
    );
    recordCompleteSmsScan({
        scanStatePath,
        deviceId: 'test-phone',
        scan: {
            id: 'merchant_ai_scan_20260730',
            monthKey: '2026-07',
            fromMs: window.startMs,
            throughMs: now.getTime(),
            inboxMessageCount: 4,
            transactionCandidateCount: 4,
            complete: true
        },
        completedAt: now
    });
    const classificationCalls = [];
    try {
        const result = await generateMonthlyBudgetReport({
            period: '2026-07',
            now,
            smsStorePath: storePath,
            smsStoreSecret: secret,
            smsScanStatePath: scanStatePath,
            outputDirectory,
            classifyBatch: async (batch, mode) => {
                assert.ok(batch.every(record => JSON.stringify(Object.keys(record)) === JSON.stringify(['id', 'merchant'])));
                assert.ok(batch.every(record => /^[a-f0-9]{24}$/.test(record.id)));
                classificationCalls.push({ mode, merchants: batch.map(transaction => transaction.merchant) });
                assert.equal(mode, 'sms_merchant');
                return {
                    transactions: batch.map(transaction => transaction.merchant === 'John Doe'
                        ? { id: transaction.id, entity_type: 'person', channel_category: 'transfer', confidence: 0.99 }
                        : { id: transaction.id, entity_type: 'business', channel_category: 'misc_food', confidence: 0.99 })
                };
            }
        });
        assert.deepEqual(classificationCalls, [{
            mode: 'sms_merchant',
            merchants: ['Green Leaf Corner', 'John Doe']
        }]);
        assert.equal(result.report.transactions.length, 4);
        assert.equal(result.report.summary.netPaise, 90000);
        assert.equal(result.report.transactions.filter(transaction => transaction.merchant === 'Green Leaf Corner').length, 2);
        assert.ok(result.report.transactions
            .filter(transaction => transaction.merchant === 'Green Leaf Corner')
            .every(transaction => transaction.channelCategory === 'misc_food'));
        assert.equal(result.report.transactions.find(transaction => transaction.merchant === 'John Doe').channelCategory, 'transfer');
        assert.equal(result.report.transactions.find(transaction => transaction.merchant === 'Zepto').channelCategory, 'online_delivery');
        assert.ok(result.report.transactions.every(transaction => !('_merchantClassificationCandidate' in transaction)));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
