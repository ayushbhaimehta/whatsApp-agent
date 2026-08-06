require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
    findWhatsAppBrowserExecutable,
    getAgentDataDirectory,
    resolveRuntimePath
} = require('./runtime-paths');

const AGENT_STATUS_PATH = resolveRuntimePath({
    envKey: 'AGENT_STATUS_PATH',
    relativeSegments: ['.agent-status.json'],
    legacyPath: path.join(__dirname, '.agent-status.json')
});
const WHATSAPP_QR_PATH = resolveRuntimePath({
    envKey: 'WHATSAPP_QR_PATH',
    relativeSegments: ['.whatsapp-qr.png'],
    legacyPath: path.join(__dirname, '.whatsapp-qr.png')
});
const WHATSAPP_AUDIT_LOG_PATH = resolveRuntimePath({
    envKey: 'WHATSAPP_AUDIT_LOG_PATH',
    relativeSegments: ['chat-events.log'],
    legacyPath: path.join(__dirname, 'chat-events.log')
});
const GOOGLE_TASKS_TOKEN_PATH = resolveRuntimePath({
    envKey: 'GOOGLE_TASKS_TOKEN_PATH',
    relativeSegments: ['secrets', 'google-tasks-token.json'],
    legacyPath: path.join(__dirname, 'google-tasks-token.json')
});
const WHATSAPP_AUTH_PATH = resolveRuntimePath({
    envKey: 'WHATSAPP_AUTH_PATH',
    relativeSegments: ['whatsapp-auth'],
    legacyPath: null
});
const WHATSAPP_WEB_CACHE_PATH = resolveRuntimePath({
    envKey: 'WHATSAPP_WEB_CACHE_PATH',
    relativeSegments: ['whatsapp-web-cache'],
    legacyPath: path.join(__dirname, '.wwebjs_cache')
});

function ensureParentDirectory(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

const bootStatus = status => {
    ensureParentDirectory(AGENT_STATUS_PATH);
    fs.writeFileSync(
        AGENT_STATUS_PATH,
        JSON.stringify({ status, updatedAt: new Date().toISOString() }, null, 2),
        'utf8'
    );
};
bootStatus('loading');

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
bootStatus('loading_qrcode');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
bootStatus('loading_cron');
const cron = require('node-cron');
bootStatus('loading_gemini');
const { GoogleGenerativeAI } = require('@google/generative-ai');
bootStatus('loading_google_auth');
const { GoogleAuth, OAuth2Client } = require('google-auth-library');
bootStatus('loading_sheets');
const { sheets: createSheetsClient } = require('@googleapis/sheets');
bootStatus('loading_tasks');
const { tasks: createTasksClient } = require('@googleapis/tasks');
bootStatus('loading_stock_reports');
const { parseStockReportRequest, runStockReports, stockHealth } = require('./stock-reports');
const {
    BUDGET_CRON_EXPRESSION,
    buildBudgetEnrichmentPrompt,
    buildMerchantCategoryPrompt,
    buildBudgetRuleMerchantMatchPrompt,
    canonicalChannelCategory,
    canonicalItemCategory,
    formatBudgetWhatsApp,
    generateMonthlyBudgetReport,
    integerFromEnv,
    loadBudgetCategoryRules,
    loadBudgetGmailOAuthClient,
    normalizeBudgetCategoryRuleProposals,
    normalizePeriod,
    persistBudgetCategoryRules,
    regenerateMonthlyBudgetReportFromExisting
} = require('./budget-reports');
const { createSmsIngestionServer } = require('./sms-ingestion');
const {
    getDefaultSwiggyAuthDirectory,
    syncSwiggyOrderCache
} = require('./swiggy-orders');
const {
    initializeBudgetScheduleState,
    claimScheduledBudgetRun,
    markScheduledBudgetRunComplete
} = require('./budget-schedule-state');
const {
    BUDGET_REPORT_DELIVERY_OPTIONS,
    assertBudgetChatConfiguration,
    assertBudgetDeliveryChatId,
    getConfiguredBudgetChatId,
    redactBudgetAuditBody,
    resolveBudgetRequestDestination
} = require('./budget-access-policy');
const {
    GEMINI_MODEL_NAME,
    GEMINI_FALLBACK_MODEL_NAMES,
    getMessageCacheKey,
    isAgentGeneratedMessageBody,
    normalizeMediaMimeType,
    parseMonthlyBudgetRequest,
    resolveBudgetCategoryOperation,
    resolveTextShortcut,
    resolveGeminiAction
} = require('./message-policy');
const { generateWithGeminiFallback } = require('./gemini-resilience');
const { downloadVoiceMediaWithRetry } = require('./whatsapp-media');
const {
    clearWhatsAppWebCache,
    createWhatsAppReadinessWatchdog
} = require('./whatsapp-readiness');
bootStatus('loading_dotenv');
bootStatus('initializing');

// --- Initialization & State Management ---

// 1. Startup Guard & Chat Identification (initialized to current time, populated on ready)
let clientReadyTime = Math.floor(Date.now() / 1000);
let myPrivateChatId = null;
let clientIsReady = false;

// 2. Message Cache: Prevent duplicate processing (Max 200 items to save RAM)
const processedMessageIds = new Set();

// Stock reports run serially so a scheduled batch and an on-demand request cannot
// compete for network/API resources or overwrite the same ticker output.
let stockJobQueue = Promise.resolve();
let stockSchedule = null;
let budgetJobQueue = Promise.resolve();
let budgetSchedule = null;
let budgetCatchUpSchedule = null;
let swiggyOrderSyncSchedule = null;
let swiggyOrderSyncQueue = Promise.resolve();
let swiggyReauthNoticeSent = false;
let smsIngestionService = null;
const chatIdentityCache = new Map();

function writeAgentStatus(status, details = {}) {
    try {
        ensureParentDirectory(AGENT_STATUS_PATH);
        fs.writeFileSync(
            AGENT_STATUS_PATH,
            JSON.stringify({ status, updatedAt: new Date().toISOString(), ...details }, null, 2),
            'utf8'
        );
    } catch (error) {
        console.error('Could not write agent status:', error.message || error);
    }
}

writeAgentStatus('starting');

// Persist the installation month before WhatsApp authentication completes. If
// QR/auth recovery spans the 26th, a later ready event can distinguish a real
// missed future run from the feature's first installation month.
try {
    initializeBudgetScheduleState(
        getBudgetScheduleStatePath(),
        new Date(),
        { allowInitialCatchUp: process.env.BUDGET_ALLOW_INITIAL_CATCH_UP === 'true' }
    );
} catch (error) {
    console.error('Could not initialize monthly budget schedule state:', error.message || error);
}

// 3. Gemini Setup (current stable Flash with automatic transient-error fallback)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModelNames = [...new Set([
    process.env.GEMINI_MODEL || GEMINI_MODEL_NAME,
    ...GEMINI_FALLBACK_MODEL_NAMES
])];
const jsonModels = geminiModelNames.map(modelName => ({
    name: modelName,
    model: genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
            responseMimeType: "application/json",
        }
    })
}));
// Plain text model for conversational and formatted responses (such as meal suggestions)
const textModels = geminiModelNames.map(modelName => ({
    name: modelName,
    model: genAI.getGenerativeModel({ model: modelName })
}));

// 4. WhatsApp Setup
const whatsappBrowserExecutable = findWhatsAppBrowserExecutable();
const whatsappPuppeteerOptions = {
    // Reuse the saved Linked Devices session without showing a browser window.
    // A visible session can still be requested explicitly for QR recovery.
    headless: process.env.WHATSAPP_HEADLESS !== 'false',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(whatsappBrowserExecutable ? { executablePath: whatsappBrowserExecutable } : {})
};
const client = new Client({
    authStrategy: new LocalAuth(WHATSAPP_AUTH_PATH ? { dataPath: WHATSAPP_AUTH_PATH } : {}),
    authTimeoutMs: 300000,
    // whatsapp-web.js persists the authenticated page before injecting its
    // message/event utilities. In a non-root container /app is intentionally
    // read-only, so the default ./.wwebjs_cache path aborts readiness with a
    // silent EACCES. Keep the cache in the writable persistent data volume.
    webVersionCache: {
        type: 'local',
        path: WHATSAPP_WEB_CACHE_PATH,
        strict: false
    },
    puppeteer: whatsappPuppeteerOptions
});
const configuredWhatsAppReadyTimeout = Number(process.env.WHATSAPP_READY_TIMEOUT_MS);
const whatsappReadyTimeoutMs = Number.isFinite(configuredWhatsAppReadyTimeout)
    && configuredWhatsAppReadyTimeout >= 30000
    && configuredWhatsAppReadyTimeout <= 600000
    ? configuredWhatsAppReadyTimeout
    : 120000;
const whatsappReadinessWatchdog = createWhatsAppReadinessWatchdog({
    client,
    isReady: () => clientIsReady,
    stallTimeoutMs: whatsappReadyTimeoutMs,
    recover: async () => {
        // The pinned upstream client makes inject() restart-safe: it cancels
        // stale frame work, de-duplicates browser listeners, loads WWebJS, and
        // attaches message events before emitting the real ready event.
        await client.inject();
        return true;
    },
    onStalled: async details => {
        const snapshot = details?.snapshot || {};
        const diagnostic = {
            elapsedSeconds: Math.round(Number(details?.elapsedMs || 0) / 1000),
            socketState: snapshot.socketState || null,
            hasSynced: Boolean(snapshot.hasSynced),
            documentReadyState: snapshot.documentReadyState || null,
            wwebjsInjected: Boolean(snapshot.wwebjsInjected),
            webVersion: snapshot.webVersion || null,
            recoveryAttempts: Number(details?.recoveryAttempts || 0),
            authenticatedObserved: Boolean(details?.authenticatedObserved)
        };
        console.error(
            'WhatsApp authenticated but did not become ready before the safety timeout. ' +
            `Restarting the browser process. Diagnostic: ${JSON.stringify(diagnostic)}`
        );
        writeAgentStatus('whatsapp_ready_timeout', diagnostic);
        try {
            await Promise.race([
                client.destroy(),
                new Promise(resolve => setTimeout(resolve, 1500))
            ]);
        } catch (error) {
            console.warn('Could not close the stalled WhatsApp browser cleanly:', error.message || error);
        }
        try {
            clearWhatsAppWebCache(WHATSAPP_WEB_CACHE_PATH);
            console.warn(
                `Cleared the disposable WhatsApp Web cache at ${WHATSAPP_WEB_CACHE_PATH}. ` +
                'The linked-device session was preserved; the next container attempt will load a fresh web client.'
            );
        } catch (error) {
            console.warn('Could not clear the stalled WhatsApp Web cache:', error.message || error);
        }
        process.exit(1);
    }
});

// 5. Google API Setup
const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/tasks'
    ],
});

// 6. Google Tasks OAuth 2.0 Setup
const tokenPath = GOOGLE_TASKS_TOKEN_PATH;
let oauth2Client = null;
let oauthTokenFileMtimeMs = 0;
let googleTasksAuthNeedsRenewal = false;

function loadGoogleTasksOAuthClient({ onlyIfChanged = false } = {}) {
    if (!fs.existsSync(tokenPath)) {
        oauth2Client = null;
        return false;
    }

    try {
        const tokenMtimeMs = fs.statSync(tokenPath).mtimeMs;
        if (onlyIfChanged && oauth2Client && tokenMtimeMs === oauthTokenFileMtimeMs) {
            return true;
        }

        const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
        const nextClient = new OAuth2Client(
            tokenData.client_id,
            tokenData.client_secret
        );
        nextClient.setCredentials(tokenData.tokens);

        // Auto-save refreshed tokens back to disk
        nextClient.on('tokens', (tokens) => {
            try {
                const currentData = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
                currentData.tokens = { ...currentData.tokens, ...tokens };
                fs.writeFileSync(tokenPath, JSON.stringify(currentData, null, 2), 'utf-8');
                oauthTokenFileMtimeMs = fs.statSync(tokenPath).mtimeMs;
                console.log("🔄 Google Tasks OAuth 2.0 access token auto-refreshed and saved.");
            } catch (saveError) {
                console.error("❌ Failed to auto-save refreshed Google Tasks tokens:", saveError);
            }
        });

        oauth2Client = nextClient;
        oauthTokenFileMtimeMs = tokenMtimeMs;
        googleTasksAuthNeedsRenewal = false;
        console.log("🔑 Google Tasks OAuth 2.0 client loaded successfully!");
        return true;
    } catch (err) {
        oauth2Client = null;
        console.error("❌ Error loading Google Tasks token file:", err);
        return false;
    }
}

if (fs.existsSync(tokenPath)) {
    loadGoogleTasksOAuthClient();
} else {
    console.warn("⚠️  WARNING: 'google-tasks-token.json' not found! Google Tasks will not be available.");
    console.warn("👉 Please run 'node auth-tasks.js' to authorize Google Tasks access.");
}

// --- WhatsApp Events ---

client.on('qr', async (qr) => {
    const qrPath = WHATSAPP_QR_PATH;
    try {
        ensureParentDirectory(qrPath);
        await QRCode.toFile(qrPath, qr, { width: 420, margin: 2 });
    } catch (error) {
        console.error('Could not create WhatsApp QR image:', error.message || error);
    }
    writeAgentStatus('qr_required', { qrImage: qrPath });
    console.log('⚠️  QR CODE RECEIVED. SCAN IT WITH WHATSAPP:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('✅ WhatsApp session authenticated. Waiting for chat synchronization...');
    writeAgentStatus('whatsapp_authenticated');
    whatsappReadinessWatchdog.noteAuthenticated();
});

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ WhatsApp loading: ${percent}%${message ? ` — ${message}` : ''}`);
    whatsappReadinessWatchdog.noteLoading(percent, message);
});

client.on('change_state', state => {
    console.log(`ℹ️ WhatsApp connection state: ${state}`);
});

client.on('ready', async () => {
    if (clientIsReady) return;
    clientIsReady = true;
    whatsappReadinessWatchdog.stop();
    try {
        fs.rmSync(WHATSAPP_QR_PATH, { force: true });
    } catch (error) {
        console.warn('Could not remove expired WhatsApp QR image:', error.message || error);
    }
    clientReadyTime = Math.floor(Date.now() / 1000);
    myPrivateChatId = client.info?.wid?._serialized;

    console.log('🚀 Agent is online! Watching for NEW messages only...');
    console.log('🔑 Established private DM JID:', myPrivateChatId);

    // This convenience setting must never block schedules or the SMS listener.
    // Some WhatsApp Web builds leave its promise pending even though the client
    // is already ready and usable.
    void client.setAutoDownloadAudio(true)
        .then(() => console.log('WhatsApp automatic audio download is enabled.'))
        .catch(error => console.warn('Could not enable WhatsApp automatic audio download:', error.message || error));

    const readyDetails = {
        privateChatConfigured: Boolean(myPrivateChatId),
        budgetPersonalChatConfigured: Boolean(getConfiguredBudgetChatId(process.env.PERSONAL_CHAT_ID)),
        stockSchedule: '0 18 * * 1-5 Asia/Kolkata',
        budgetSchedule: `${BUDGET_CRON_EXPRESSION} Asia/Kolkata`,
        swiggyOrderSync: swiggyOrderHistoryEnabled()
            ? `${process.env.SWIGGY_ORDER_SYNC_CRON || '10 3 * * *'} Asia/Kolkata`
            : 'disabled'
    };
    let readyStatus = 'ready';
    try {
        const health = stockHealth();
        readyDetails.python = health.python;
        console.log(`Stock report engine ready: ${health.python}`);
        startStockSchedule();
    } catch (error) {
        readyStatus = 'ready_with_stock_error';
        readyDetails.stockError = error.message || String(error);
        console.error('Stock report engine is not ready:', error.message || error);
    }
    try {
        startBudgetSchedule();
    } catch (error) {
        readyDetails.budgetScheduleError = error.message || String(error);
        console.error('Monthly budget schedule could not start:', error.message || error);
    }
    try {
        startSwiggyOrderSyncSchedule();
    } catch (error) {
        readyDetails.swiggyOrderSyncError = error.message || String(error);
        console.error('Swiggy order-history sync could not start:', error.message || error);
    }
    try {
        const smsAddress = await startSmsIngestionIfConfigured();
        if (smsAddress) readyDetails.smsIngestion = smsAddress;
    } catch (error) {
        readyDetails.smsIngestionError = error.message || String(error);
        console.error('Android SMS ingestion could not start:', error.message || error);
    }
    writeAgentStatus(readyStatus, readyDetails);
});

client.on('auth_failure', message => {
    writeAgentStatus('auth_failure', { error: String(message || 'WhatsApp authentication failed') });
});

client.on('disconnected', reason => {
    clientIsReady = false;
    whatsappReadinessWatchdog.stop();
    writeAgentStatus('disconnected', { reason: String(reason || 'Unknown') });
    console.error(`WhatsApp disconnected: ${String(reason || 'Unknown')}. Run npm start again to reconnect the agent.`);
    // A disconnected whatsapp-web.js client is not reliable to reuse. Exit the
    // foreground npm process; there is deliberately no external restart task.
    setTimeout(() => process.exit(1), 500);
});

client.on('message_create', async (msg) => {
    // --- GUARD: Ignore bot's own generated responses to avoid loops ---
    const body = msg.body || "";
    if (isAgentGeneratedMessageBody(body)) return;
    if (body.startsWith("✨ *Personalized Meal Suggestions*") || 
        body.startsWith("✅ *Meals Logged*") || 
        body.startsWith("🛒 *Added to Shopping List*") ||
        body.startsWith("🛒 *Added to Google Tasks*") ||
        body.startsWith("📊 *Daily Summary*") ||
        body.startsWith("📈 *Stock report") ||
        body.startsWith("📦 *Scheduled stock reports*") ||
        body.startsWith("💰 *Monthly Budget Report") ||
        body.startsWith("💰 *Budget report status*") ||
        body.startsWith("💰 *Scheduled budget report") ||
        body.startsWith("⚠️ *Agent error*")) {
        return;
    }

    // --- GUARD 0: Prevent Duplicate Processing ---
    const messageCacheKey = getMessageCacheKey(msg);
    if (messageCacheKey && processedMessageIds.has(messageCacheKey)) return;
    // Reserve the ID before the first await. whatsapp-web.js can emit the same
    // message twice while chat metadata is still resolving; reserving it later
    // allowed both async handlers to reach Sheets/Tasks concurrently.
    if (messageCacheKey) {
        processedMessageIds.add(messageCacheKey);
        if (processedMessageIds.size > 200) {
            const oldestId = processedMessageIds.values().next().value;
            processedMessageIds.delete(oldestId);
        }
    }

    // Audit every unique newly created incoming and outgoing message before
    // applying feature-specific chat or time filters. This makes chat-ID
    // discovery easy without duplicating audit rows.
    await auditWhatsAppMessage(msg);

    const cookChatId = process.env.COOK_CHAT_ID;
    const configuredPersonalChatId = String(process.env.PERSONAL_CHAT_ID || '').trim();
    const personalChatId = configuredPersonalChatId || client.info?.wid?._serialized;

    // --- GUARD 1 & 2: Time and Target Chat ---
    if (msg.timestamp < clientReadyTime - 10) return;

    // Resolve the actual conversation. For outgoing messages, msg.from is always
    // the logged-in account and must not be used to classify the destination chat.
    const chatScope = await resolveMessageChatScope(
        msg,
        cookChatId,
        personalChatId,
        configuredPersonalChatId
    );
    const { isCookChat, isPrivateChat, isConfiguredPersonalChat } = chatScope;

    // Log ignored chats
    if (!isCookChat && !isPrivateChat) {
        return; // Ignore silently
    }

    console.log(`-------------------------------------------`);
    if (isCookChat) {
        console.log(`📥 [Cook's Chat] NEW message received!`);
    } else if (isPrivateChat) {
        console.log(`📥 [Private Self-Chat] NEW message received!`);
    }
    console.log(`Direction: ${msg.fromMe ? 'Outgoing (You)' : 'Incoming'}`);
    console.log(`-------------------------------------------`);

    try {
        let inputData;
        let mimeType = "text/plain";

        // Handle Audio/Voice Notes
        if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')) {
            console.log("🎙️ Voice note detected. Starting download...");
            const media = await downloadVoiceMediaWithRetry({ client, message: msg });
            inputData = media.data;
            mimeType = normalizeMediaMimeType(media.mimetype);
            console.log("✅ Voice note download completed successfully!");
        } else {
            // Handle Text
            inputData = msg.body;
            if (!inputData || inputData.trim() === "") return;
            console.log(`📝 Text message read: "${inputData}"`);
        }

        // Financial commands fail closed everywhere except the exact configured
        // PERSONAL_CHAT_ID. This happens before Gemini so a cook-chat budget
        // request cannot be reinterpreted or sent to an external model.
        const budgetRequestHint = mimeType === 'text/plain' ? parseMonthlyBudgetRequest(inputData) : null;
        if (!isConfiguredPersonalChat && budgetRequestHint) {
            console.warn('Blocked a monthly-budget request outside the configured PERSONAL_CHAT_ID.');
            return;
        }

        // Stock analysis is deliberately limited to your private self-chat. A
        // deterministic parser keeps normal food messages out of the long-running
        // report pipeline and accepts phrases such as "run analysis for AMD".
        if (isPrivateChat && mimeType === "text/plain" && !budgetRequestHint) {
            const shortcut = resolveTextShortcut({
                text: inputData,
                isPrivateChat,
                parseStockRequest: parseStockReportRequest,
                getDefaultMealType: getMealType
            });
            if (shortcut?.action === 'summarize_day') {
                await sendDailyNutritionSummary(msg);
                return;
            }
            if (shortcut?.action === 'suggest_meal') {
                await sendMealSuggestions(msg, shortcut.mealType);
                return;
            }
            if (shortcut?.action === 'stock_report') {
                await handleOnDemandStockReport(msg, shortcut.ticker, personalChatId);
                return;
            }
        }

        console.log("🤖 Processing intent with Gemini...");
        let result;
        try {
            result = await processWithGemini(inputData, mimeType);
        } catch (geminiError) {
            const budgetFallback = isConfiguredPersonalChat ? budgetRequestHint : null;
            if (!budgetFallback) throw geminiError;
            if (budgetFallback.requiresRuleInterpretation) {
                const error = new Error('Gemini must be available to interpret a natural-language budget category rule safely. No rule or report change was made.');
                error.code = 'BUDGET_CATEGORY_RULE_INTERPRETATION_FAILED';
                error.cause = geminiError;
                throw error;
            }
            console.warn('Gemini intent analysis was unavailable; using the narrow monthly-budget phrase fallback.');
            result = { intent: 'monthly_budget', period: budgetFallback.period, items: [] };
        }
        if (result?.intent === 'none' && isConfiguredPersonalChat && budgetRequestHint) {
            if (budgetRequestHint.requiresRuleInterpretation) {
                const error = new Error('The budget category instruction could not be converted into a safe merchant rule. No rule or report change was made.');
                error.code = 'BUDGET_CATEGORY_RULE_INTERPRETATION_FAILED';
                throw error;
            }
            result = { intent: 'monthly_budget', period: budgetRequestHint.period, items: [] };
        }
        const safeBudgetCategoryOperation = resolveBudgetCategoryOperation(
            mimeType === 'text/plain' ? inputData : '',
            result?.budget_category_operation
        );
        if (result?.intent === 'monthly_budget' && budgetRequestHint?.requiresRuleInterpretation &&
            safeBudgetCategoryOperation !== 'clear' &&
            (!Array.isArray(result.budget_category_rules) || result.budget_category_rules.length === 0)) {
            const error = new Error('The budget category instruction did not produce a bounded merchant rule. No rule or report change was made.');
            error.code = 'BUDGET_CATEGORY_RULE_INTERPRETATION_FAILED';
            throw error;
        }
        console.log(`🔍 Gemini intent resolved: intent="${result.intent}"`);
        const resolvedAction = resolveGeminiAction({
            result,
            isCookChat,
            isPrivateChat,
            canAccessBudget: isConfiguredPersonalChat,
            budgetInstructionText: mimeType === 'text/plain' ? inputData : ''
        });

        // All confirmations are delivered to the explicitly configured personal chat.
        const notificationChatId = personalChatId;

        // Execute Action: LOG FOOD
        if (resolvedAction.action === 'log_food') {
            console.log("📊 Logging food items to Google Sheets...");
            const sheetRows = [];
            let summaryMessage = `✅ *Meals Logged*\n\n`;

            for (const food of resolvedAction.items) {
                const finalMealType = (food.meal_type && food.meal_type !== "Unknown")
                    ? food.meal_type
                    : getMealType();

                sheetRows.push([
                    new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                    `[${finalMealType}] ${food.item}`,
                    food.quantity || '1',
                    food.calories || 0,
                    food.protein || 0,
                    food.carbs || 0,
                    food.fat || 0,
                    food.fiber || 0
                ]);

                summaryMessage += `*[${finalMealType}]* 🍲 ${food.item} (${food.quantity})\n`;
                summaryMessage += `📊 ${food.protein}g P | ${food.fiber}g F | ${food.calories} kcal\n\n`;
            }

            await logToSheets(sheetRows);
            console.log("✅ Logged food items to Google Sheets successfully!");

            if (notificationChatId) {
                console.log("📨 Sending log summary confirmation to private DM...");
                await client.sendMessage(notificationChatId, summaryMessage.trim());
            }
        }
        // Execute Action: ADD REMINDER
        else if (resolvedAction.action === 'add_reminder') {
            console.log("🛒 Creating Google Task for shopping list...");
            const addedItems = [];
            const failedItems = [];

            for (const req of resolvedAction.items) {
                const added = await addToGoogleTasks(req.item);
                if (added) {
                    console.log(`✅ Google Task created for: "${req.item}"`);
                    addedItems.push(req.item);
                } else {
                    failedItems.push(req.item);
                }
            }

            if (notificationChatId && addedItems.length > 0) {
                console.log("📨 Sending shopping list confirmation to private DM...");
                const reminderMessage = `🛒 *Added to Google Tasks*\n\n${addedItems.map(item => `- ${item}`).join('\n')}`;
                await client.sendMessage(notificationChatId, reminderMessage);
            }
            if (notificationChatId && failedItems.length > 0) {
                const failureMessage = googleTasksAuthNeedsRenewal
                    ? 'Google Tasks authorization has expired. Run `node auth-tasks.js` once to reconnect Google Tasks, then retry your request.'
                    : `Could not add these items to Google Tasks: ${failedItems.join(', ')}`;
                await client.sendMessage(
                    notificationChatId,
                    `⚠️ *Agent error*\n\n${failureMessage}`
                );
            }
        }
        // Execute Action: SUGGEST MEAL
        else if (resolvedAction.action === 'suggest_meal') {
            const targetMeal = (resolvedAction.mealType && resolvedAction.mealType !== "Unknown")
                ? resolvedAction.mealType
                : getMealType();
            await sendMealSuggestions(msg, targetMeal);
        }
        // Execute Action: SUMMARIZE DAY
        else if (resolvedAction.action === 'summarize_day') {
            await sendDailyNutritionSummary(msg);
        }
        // Execute Action: MONTHLY BUDGET (private self-chat only)
        else if (resolvedAction.action === 'monthly_budget') {
            const budgetChatId = resolveBudgetRequestDestination({
                isConfiguredPersonalChat,
                personalChatId: configuredPersonalChatId
            });
            if (!budgetChatId) {
                console.warn('Blocked monthly-budget delivery outside PERSONAL_CHAT_ID.');
                return;
            }
            const isRuleUpdate = (resolvedAction.budgetCategoryRules?.length || 0) > 0 ||
                ['replace', 'clear'].includes(resolvedAction.budgetCategoryOperation);
            await client.sendMessage(
                budgetChatId,
                `💰 *Budget report status*\n\n${isRuleUpdate ? 'Saving the private month-specific category preference and regenerating' : 'Verifying the complete mobile SMS scan and generating'} the report for ${resolvedAction.period || 'the current month'}...`
            );
            await enqueueBudgetJob(() => runMonthlyBudgetReport({
                chatId: budgetChatId,
                period: resolvedAction.period || 'current_month',
                trigger: isRuleUpdate ? 'whatsapp_recategorization' : 'whatsapp',
                categoryRuleProposals: resolvedAction.budgetCategoryRules || [],
                categoryRuleOperation: resolvedAction.budgetCategoryOperation || 'merge'
            }));
        }

    } catch (error) {
        console.error("❌ Error processing message:", error);
        const errorChatId = chatScope.chatId || process.env.PERSONAL_CHAT_ID || myPrivateChatId;
        if (errorChatId) {
            const errorMessage = error?.code === 'SMS_SCAN_REQUIRED'
                ? `A complete current-month mobile SMS sync is mandatory before a budget report can be generated. ${conciseError(error)}`
                : error?.code === 'BUDGET_CATEGORY_RULE_INTERPRETATION_FAILED' || error?.code === 'BUDGET_CATEGORY_RULE_INVALID'
                    ? conciseError(error)
                : error?.code === 'BUDGET_REPORT_NOT_FOUND' || error?.code === 'BUDGET_REPORT_INVALID'
                    ? `${conciseError(error)} Sync the month in SMS Budget Companion, then request the budget report again.`
                : 'I could not process the last request. This may be a temporary Gemini, Google API, or network issue. Please try again shortly.';
            await client.sendMessage(
                errorChatId,
                `⚠️ *Agent error*\n\n${errorMessage}`
            ).catch(sendError => console.error('Could not send error notification:', sendError));
        }
    }
});

function enqueueStockJob(task) {
    const queuedJob = stockJobQueue.then(task, task);
    stockJobQueue = queuedJob.catch(() => undefined);
    return queuedJob;
}

function enqueueBudgetJob(task) {
    const queuedJob = budgetJobQueue.then(task, task);
    budgetJobQueue = queuedJob.catch(() => undefined);
    return queuedJob;
}

async function resolveMessageChatScope(msg, cookChatId, personalChatId, configuredPersonalChatId = null) {
    let chat = null;
    try {
        chat = await msg.getChat();
    } catch (_) {
        // Fall back to the message's directional chat ID below.
    }

    const directionalChatId = msg.fromMe ? msg.to : msg.from;
    const chatId = chat?.id?._serialized || directionalChatId;
    const candidates = new Set([chatId, directionalChatId].filter(Boolean));
    let contactIsMe = false;

    if (chatId && chatIdentityCache.has(chatId)) {
        const cached = chatIdentityCache.get(chatId);
        for (const candidate of cached.candidates) candidates.add(candidate);
        contactIsMe = cached.contactIsMe;
    } else if (chatId) {
        try {
            if (chatId.endsWith('@lid') && typeof client.getContactLidAndPhone === 'function') {
                const mappings = await client.getContactLidAndPhone([chatId]);
                for (const mapping of mappings || []) {
                    if (mapping?.lid) candidates.add(mapping.lid);
                    if (mapping?.pn) candidates.add(mapping.pn);
                }
            }
        } catch (error) {
            console.warn(`Could not resolve LID mapping for ${chatId}:`, error.message || error);
        }

        try {
            const contact = chat && !chat.isGroup ? await chat.getContact() : null;
            contactIsMe = Boolean(contact?.isMe);
            if (contact?.id?._serialized) candidates.add(contact.id._serialized);
        } catch (_) {
            // Exact configured IDs and LID/phone mappings remain available.
        }

        chatIdentityCache.set(chatId, { candidates: [...candidates], contactIsMe });
    }

    const matchesCookChat = [...candidates].some(candidate => jidsMatch(candidate, cookChatId));
    const matchesPersonalChat = [...candidates].some(candidate => jidsMatch(candidate, personalChatId));
    const matchesConfiguredPersonalChat = Boolean(getConfiguredBudgetChatId(configuredPersonalChatId)) &&
        !chat?.isGroup &&
        [...candidates].some(candidate => jidsMatch(candidate, configuredPersonalChatId));

    return {
        chatId,
        isCookChat: matchesCookChat,
        isPrivateChat: contactIsMe || matchesPersonalChat,
        isConfiguredPersonalChat: matchesConfiguredPersonalChat
    };
}

async function auditWhatsAppMessage(msg) {
    try {
        const chat = await msg.getChat().catch(() => null);
        const chatId = chat?.id?._serialized || (msg.fromMe ? msg.to : msg.from) || null;
        const body = redactBudgetAuditBody(msg.body, { fromMe: Boolean(msg.fromMe) });
        const record = {
            timestamp: new Date().toISOString(),
            direction: msg.fromMe ? 'sent' : 'received',
            chatId,
            chatName: chat?.name || null,
            from: msg.from || null,
            to: msg.to || null,
            author: msg.author || null,
            messageId: getMessageCacheKey(msg),
            type: msg.type || null,
            hasMedia: Boolean(msg.hasMedia),
            body
        };

        ensureParentDirectory(WHATSAPP_AUDIT_LOG_PATH);
        fs.appendFileSync(
            WHATSAPP_AUDIT_LOG_PATH,
            `${JSON.stringify(record)}\n`,
            'utf8'
        );
        console.log(
            `[WhatsApp ${record.direction}] chatId=${record.chatId || 'unknown'} ` +
            `name=${JSON.stringify(record.chatName || '')} type=${record.type || 'unknown'} ` +
            `body=${JSON.stringify(record.body)}`
        );
    } catch (error) {
        console.error('Could not audit WhatsApp message:', error.message || error);
    }
}

async function sendDailyNutritionSummary(msg) {
    console.log("📊 Generating daily macro summary from direct self-chat command...");
    const dailyLogs = await getDailyLogs();
    const overallGoal = await getUserGoal();
    const summary = await generateDailySummary(dailyLogs, overallGoal);
    await msg.reply(`📊 *Daily Summary*\n\n${summary}`);
}

async function sendMealSuggestions(msg, mealType) {
    console.log(`🥗 Generating vegetarian meal suggestions for ${mealType}...`);
    const dailyLogs = await getDailyLogs();
    const overallGoal = await getUserGoal();
    const suggestions = await generateSuggestions(mealType, dailyLogs, overallGoal);
    await msg.reply(`✨ *Personalized Meal Suggestions*\n\n${suggestions}`);
}

function conciseError(error) {
    const message = String(error?.message || error || 'Unknown error');
    return message.split(/\r?\n/).filter(Boolean).slice(-3).join('\n').slice(0, 1200);
}

function reportPublicUrl(reportPath) {
    const baseUrl = process.env.REPORT_PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
    return baseUrl ? `${baseUrl}/${encodeURIComponent(path.basename(reportPath))}` : null;
}

async function sendReportDocument(chatId, reportPath, caption, { allowPublicLink = true } = {}) {
    if (!fs.existsSync(reportPath)) {
        throw new Error(`Generated report file is missing: ${reportPath}`);
    }
    const media = MessageMedia.fromFilePath(reportPath);
    const link = allowPublicLink ? reportPublicUrl(reportPath) : null;
    const finalCaption = link ? `${caption}\n\nOpen online: ${link}` : caption;
    await client.sendMessage(chatId, media, { caption: finalCaption });
}

async function handleOnDemandStockReport(msg, ticker, chatId) {
    if (!ticker) return handleOnDemandStockBatch(msg, chatId);

    await msg.reply(`📈 *Stock report status*\n\nQueued ${ticker}. I’ll send the HTML report here when it is ready.`);

    return enqueueStockJob(async () => {
        try {
            const result = await runStockReports(ticker);
            const reportPath = result.reports?.[0];
            if (!reportPath) {
                throw new Error(result.failures?.[0]?.[1] || `No report was generated for ${ticker}.`);
            }

            await sendReportDocument(
                chatId,
                reportPath,
                `📈 *Stock report ready: ${ticker}*\n\nTap the attached HTML document to download and open it.`
            );
        } catch (error) {
            console.error(`Stock report request failed for ${ticker}:`, error);
            await msg.reply(`📈 *Stock report failed: ${ticker}*\n\n${conciseError(error)}`);
        }
    });
}

async function handleOnDemandStockBatch(msg, chatId) {
    await msg.reply(
        '📦 *Stock report status*\n\nQueued the complete configured ticker list. I’ll send the ZIP or HTML reports here when the batch is ready.'
    );

    return enqueueStockJob(async () => {
        try {
            // Omitting --tickers deliberately uses TICKER_INPUT from gemini-code.py,
            // exactly like the Monday-Friday 6 PM scheduled batch.
            const result = await runStockReports();
            const successful = result.reports?.length || 0;
            const failed = result.failures?.length || 0;

            if (result.zip && fs.existsSync(result.zip)) {
                await sendReportDocument(
                    chatId,
                    result.zip,
                    `📦 *Complete stock reports ready*\n\n${successful} completed, ${failed} failed. Open the attached ZIP to access every HTML report.`
                );
            } else {
                for (const reportPath of result.reports || []) {
                    const completedTicker = path.basename(reportPath).split('_', 1)[0];
                    await sendReportDocument(
                        chatId,
                        reportPath,
                        `📈 *Stock report ready: ${completedTicker}*\n\nTap the attached HTML document to open it.`
                    );
                }
            }

            if (failed > 0) {
                const failedTickers = result.failures.map(item => item[0]).join(', ');
                await client.sendMessage(
                    chatId,
                    `📦 *Complete stock reports*\n\nFailed tickers: ${failedTickers}`
                );
            }
        } catch (error) {
            console.error('On-demand complete stock report batch failed:', error);
            await msg.reply(`📦 *Complete stock reports failed*\n\n${conciseError(error)}`);
        }
    });
}

async function runScheduledStockReports() {
    const chatId = process.env.PERSONAL_CHAT_ID || myPrivateChatId;
    if (!chatId) throw new Error('Private self-chat ID is unavailable.');

    await client.sendMessage(
        chatId,
        '📦 *Scheduled stock reports*\n\nThe Monday–Friday 6:00 PM IST batch has started.'
    );

    try {
        const result = await runStockReports();
        const successful = result.reports?.length || 0;
        const failed = result.failures?.length || 0;

        if (result.zip && fs.existsSync(result.zip)) {
            await sendReportDocument(
                chatId,
                result.zip,
                `📦 *Scheduled stock reports ready*\n\n${successful} completed, ${failed} failed. Open the attached ZIP to access each HTML report.`
            );
        } else {
            for (const reportPath of result.reports || []) {
                const ticker = path.basename(reportPath).split('_', 1)[0];
                await sendReportDocument(
                    chatId,
                    reportPath,
                    `📈 *Stock report ready: ${ticker}*\n\nTap the attached HTML document to open it.`
                );
            }
        }

        if (failed > 0) {
            const failedTickers = result.failures.map(item => item[0]).join(', ');
            await client.sendMessage(chatId, `📦 *Scheduled stock reports*\n\nFailed tickers: ${failedTickers}`);
        }
    } catch (error) {
        console.error('Scheduled stock report batch failed:', error);
        await client.sendMessage(
            chatId,
            `📦 *Scheduled stock reports failed*\n\n${conciseError(error)}`
        );
    }
}

function startStockSchedule() {
    if (stockSchedule) return;
    stockSchedule = cron.schedule(
        '0 18 * * 1-5',
        () => enqueueStockJob(runScheduledStockReports),
        { timezone: 'Asia/Kolkata' }
    );
    console.log('Stock report schedule active: Monday-Friday at 6:00 PM Asia/Kolkata.');
}

async function classifyBudgetBatchWithGemini(transactions, mode = 'receipt') {
    const prompt = mode === 'sms_merchant'
        ? buildMerchantCategoryPrompt(transactions)
        : buildBudgetEnrichmentPrompt(transactions);
    const { response } = await generateWithGeminiFallback({
        models: jsonModels,
        contents: [prompt],
        operation: 'monthly budget categorization'
    });
    const rawText = response.response.text().trim();
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    return JSON.parse(jsonText);
}

async function matchBudgetCategoryRulesWithGemini(merchantRecords, rules) {
    const prompt = buildBudgetRuleMerchantMatchPrompt(merchantRecords, rules);
    const { response } = await generateWithGeminiFallback({
        models: jsonModels,
        contents: [prompt],
        operation: 'private budget merchant-name rule matching'
    });
    const rawText = response.response.text().trim();
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    return JSON.parse(jsonText);
}

function parseMonthlyBudgetPaise() {
    const rupees = Number(process.env.MONTHLY_BUDGET_INR);
    return Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : null;
}

function getSmsTransactionStorePath() {
    if (process.env.SMS_TRANSACTION_STORE) return process.env.SMS_TRANSACTION_STORE;
    return getPrivateAgentDataPath('budget-data', 'android-sms.enc.jsonl');
}

function getSmsScanStatePath() {
    return process.env.SMS_SCAN_STATE_PATH || getPrivateAgentDataPath('budget-data', 'android-sms-scan-state.json');
}

function getBudgetCategoryRulesPath() {
    return process.env.BUDGET_CATEGORY_RULES_PATH || getPrivateAgentDataPath('budget-data', 'category-rules.json');
}

function getPrivateAgentDataPath(...segments) {
    return path.join(getAgentDataDirectory(), ...segments);
}

function getSmsIngestionSecret() {
    const inlineSecret = String(process.env.SMS_INGESTION_SECRET || '').trim();
    if (inlineSecret) return inlineSecret;
    const secretPath = process.env.SMS_INGESTION_SECRET_FILE || getPrivateAgentDataPath('secrets', 'sms-ingestion-secret.txt');
    try {
        return fs.readFileSync(secretPath, 'utf8').trim() || null;
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('Could not read the SMS ingestion secret file:', error.message || error);
        return null;
    }
}

function swiggyOrderHistoryEnabled() {
    return process.env.SWIGGY_ORDER_HISTORY_ENABLED !== 'false';
}

function getSwiggyOrderCachePath() {
    return process.env.SWIGGY_ORDER_CACHE_PATH || getPrivateAgentDataPath('budget-data', 'swiggy-orders.enc.json');
}

function getSwiggyOrderCacheSecret() {
    return String(process.env.SWIGGY_ORDER_CACHE_SECRET || getSmsIngestionSecret() || '').trim() || null;
}

async function notifySwiggyReauthorizationOnce() {
    if (swiggyReauthNoticeSent || !clientIsReady) return;
    const chatId = getConfiguredBudgetChatId(process.env.PERSONAL_CHAT_ID);
    if (!chatId) return;
    swiggyReauthNoticeSent = true;
    try {
        await client.sendMessage(
            chatId,
            '🧾 *Swiggy order history needs authorization*\n\nRun `npm run auth:swiggy` once in PowerShell and complete Swiggy phone/OTP sign-in. Budget reports will continue from SMS and any existing encrypted order cache until then.'
        );
    } catch (error) {
        console.warn('Could not send the Swiggy authorization reminder:', error.message || error);
    }
}

async function syncSwiggyOrderHistory(trigger = 'manual') {
    if (!swiggyOrderHistoryEnabled()) {
        return {
            orders: [],
            warnings: ['Swiggy order-history enrichment is disabled.'],
            reauthRequired: false,
            coverage: { enabled: false, trigger }
        };
    }
    const cacheSecret = getSwiggyOrderCacheSecret();
    if (!cacheSecret) {
        return {
            orders: [],
            warnings: ['Swiggy order history could not use its encrypted cache because no cache secret is configured.'],
            reauthRequired: false,
            coverage: { enabled: true, trigger, cacheAvailable: false }
        };
    }

    try {
        const result = await syncSwiggyOrderCache({
            cachePath: getSwiggyOrderCachePath(),
            cacheSecret,
            authDirectory: process.env.SWIGGY_MCP_AUTH_DIR || getDefaultSwiggyAuthDirectory(),
            now: new Date(),
            allowInteractiveAuth: false
        });
        if (result.reauthRequired) void notifySwiggyReauthorizationOnce();
        const fetched = result.fetchedProviders?.length
            ? result.fetchedProviders.map(provider => provider.replace(/^swiggy_/, '')).join(', ')
            : 'encrypted cache only';
        console.log(`Swiggy order-history sync (${trigger}): ${result.orders.length} cached order(s), ${fetched}.`);
        return {
            ...result,
            coverage: {
                enabled: true,
                trigger,
                syncedAt: new Date().toISOString(),
                providerStatus: result.providerStatus,
                ...result.coverage
            }
        };
    } catch (error) {
        console.error(`Swiggy order-history sync (${trigger}) failed safely:`, error.message || error);
        return {
            orders: [],
            warnings: ['Swiggy order-history enrichment was unavailable; SMS/Gmail totals remain unchanged.'],
            reauthRequired: false,
            coverage: { enabled: true, trigger, failed: true }
        };
    }
}

function enqueueSwiggyOrderSync(trigger) {
    const run = swiggyOrderSyncQueue.then(() => syncSwiggyOrderHistory(trigger));
    swiggyOrderSyncQueue = run.catch(() => null);
    return run;
}

function startSwiggyOrderSyncSchedule() {
    if (!swiggyOrderHistoryEnabled()) {
        console.log('Swiggy order-history enrichment is disabled.');
        return;
    }
    if (swiggyOrderSyncSchedule) return;
    const expression = process.env.SWIGGY_ORDER_SYNC_CRON || '10 3 * * *';
    if (!cron.validate(expression)) throw new Error(`Invalid SWIGGY_ORDER_SYNC_CRON: ${expression}`);
    swiggyOrderSyncSchedule = cron.schedule(
        expression,
        () => void enqueueSwiggyOrderSync('daily'),
        { timezone: 'Asia/Kolkata' }
    );
    setImmediate(() => void enqueueSwiggyOrderSync('startup'));
    console.log(`Swiggy order-history sync active: startup plus ${expression} Asia/Kolkata.`);
}

async function runMonthlyBudgetReport({
    chatId,
    period = 'current_month',
    trigger = 'scheduled',
    categoryRuleProposals = [],
    categoryRuleOperation = 'merge'
}) {
    const budgetChatId = assertBudgetDeliveryChatId({
        personalChatId: process.env.PERSONAL_CHAT_ID,
        requestedChatId: chatId
    });
    const monthKey = normalizePeriod(period);
    const normalizedRuleProposals = normalizeBudgetCategoryRuleProposals(categoryRuleProposals);
    const hasRuleCommand = categoryRuleOperation === 'clear' || categoryRuleOperation === 'replace' || categoryRuleProposals.length > 0;
    if (categoryRuleProposals.length > 0 && normalizedRuleProposals.length === 0) {
        const error = new Error('The requested budget category rule did not contain a safe category label and bounded merchant selector.');
        error.code = 'BUDGET_CATEGORY_RULE_INVALID';
        throw error;
    }
    if (categoryRuleOperation === 'replace' && normalizedRuleProposals.length === 0) {
        const error = new Error('Replacing budget category rules requires at least one valid rule. Use an explicit clear/reset request to remove them.');
        error.code = 'BUDGET_CATEGORY_RULE_INVALID';
        throw error;
    }
    const categoryRulePath = getBudgetCategoryRulesPath();
    const ruleUpdate = hasRuleCommand
        ? persistBudgetCategoryRules({
            filePath: categoryRulePath,
            period: monthKey,
            proposals: normalizedRuleProposals,
            operation: categoryRuleOperation
        })
        : null;
    const categoryRules = ruleUpdate?.rules || loadBudgetCategoryRules({ filePath: categoryRulePath, period: monthKey });
    const reportOutputDirectory = getPrivateAgentDataPath('budget-reports');
    const regenerateExisting = () => regenerateMonthlyBudgetReportFromExisting({
        period: monthKey,
        categoryRules,
        matchCategoryRules: matchBudgetCategoryRulesWithGemini,
        monthlyBudgetPaise: parseMonthlyBudgetPaise(),
        outputDirectory: reportOutputDirectory
    });

    let result;
    if (process.env.SMS_INGESTION_ENABLED === 'false') {
        if (hasRuleCommand) {
            result = await regenerateExisting();
        } else {
            const error = new Error('Android SMS ingestion is disabled. Set SMS_INGESTION_ENABLED=true, keep the agent online, and sync the SMS Budget Companion before retrying.');
            error.code = 'SMS_SCAN_REQUIRED';
            throw error;
        }
    }
    const budgetTokenPath = process.env.BUDGET_GMAIL_TOKEN_PATH || getPrivateAgentDataPath('google-budget-token.json');
    let gmailAuthClient = null;
    try {
        gmailAuthClient = loadBudgetGmailOAuthClient(budgetTokenPath);
    } catch (error) {
        console.error('Could not load Gmail receipt authorization:', error.message || error);
    }

    console.log(`Starting ${trigger} monthly budget report for ${period}...`);
    if (!result) {
        const swiggyOrderHistory = await enqueueSwiggyOrderSync('budget_report');
        try {
            result = await generateMonthlyBudgetReport({
                period: monthKey,
                gmailAuthClient,
                gmailMaxMessages: integerFromEnv(process.env.BUDGET_GMAIL_MESSAGE_LIMIT, 250, { min: 10, max: 2000 }),
                smsStorePath: getSmsTransactionStorePath(),
                smsStoreSecret: getSmsIngestionSecret(),
                smsScanStatePath: getSmsScanStatePath(),
                smsScanMaxAgeMs: integerFromEnv(process.env.SMS_SCAN_MAX_AGE_HOURS, 12, { min: 1, max: 72 }) * 60 * 60 * 1000,
                classifyBatch: classifyBudgetBatchWithGemini,
                swiggyOrders: swiggyOrderHistory.orders,
                swiggyWarnings: swiggyOrderHistory.warnings,
                swiggyCoverage: swiggyOrderHistory.coverage,
                categoryRules,
                matchCategoryRules: matchBudgetCategoryRulesWithGemini,
                monthlyBudgetPaise: parseMonthlyBudgetPaise(),
                outputDirectory: reportOutputDirectory
            });
        } catch (error) {
            if (hasRuleCommand && error?.code === 'SMS_SCAN_REQUIRED') {
                console.warn('Fresh SMS coverage is unavailable; recategorizing the existing private report instead.');
                result = await regenerateExisting();
            } else {
                throw error;
            }
        }
    }
    result.categoryRuleUpdate = ruleUpdate;

    try {
        await persistBudgetReportToSheets(result.report, trigger);
    } catch (error) {
        console.error('Could not persist monthly budget report to Google Sheets:', error.message || error);
        result.report.warnings.push('Google Sheets budget logging failed; the attached local report is still complete.');
        result.report.whatsappMessage = formatBudgetWhatsApp(result.report);
    }

    await client.sendMessage(budgetChatId, result.report.whatsappMessage);
    await sendReportDocument(
        budgetChatId,
        result.htmlPath,
        `💰 *Monthly Budget Report — ${result.report.label}*\n\nOpen the attached HTML document for categorized transactions and receipt items.`,
        BUDGET_REPORT_DELIVERY_OPTIONS
    );
    return result;
}

async function runScheduledBudgetReport({ trigger = 'scheduled', period = 'current_month' } = {}) {
    const chatId = assertBudgetDeliveryChatId({ personalChatId: process.env.PERSONAL_CHAT_ID });
    const heading = trigger === 'catch_up' ? 'Scheduled budget catch-up' : 'Scheduled budget report';
    await client.sendMessage(
        chatId,
        `💰 *${heading}*\n\nVerifying complete mobile-SMS coverage and collecting available receipt/order details.`
    );
    try {
        return await runMonthlyBudgetReport({ chatId, period, trigger });
    } catch (error) {
        console.error('Scheduled monthly budget report failed:', error);
        await client.sendMessage(
            chatId,
            `💰 *Scheduled budget report failed*\n\n${conciseError(error)}`
        );
        throw error;
    }
}

function getBudgetScheduleStatePath() {
    return process.env.BUDGET_SCHEDULE_STATE_PATH || getPrivateAgentDataPath('budget-data', 'monthly-schedule-state.json');
}

async function attemptScheduledBudgetReport(trigger) {
    const statePath = getBudgetScheduleStatePath();
    const claim = claimScheduledBudgetRun({ statePath, now: new Date() });
    if (!claim.claimed) return null;
    try {
        const result = await runScheduledBudgetReport({ trigger, period: claim.monthKey });
        markScheduledBudgetRunComplete(statePath, new Date(), claim.monthKey);
        return result;
    } catch (error) {
        // The persisted attempt timestamp lets the hourly catch-up check retry
        // after a cooldown without flooding the personal chat.
        console.error(`Monthly budget ${trigger} attempt will be eligible for a later retry:`, error.message || error);
        return null;
    }
}

function startBudgetSchedule() {
    if (budgetSchedule) return;
    assertBudgetChatConfiguration({
        personalChatId: process.env.PERSONAL_CHAT_ID,
        cookChatId: process.env.COOK_CHAT_ID
    });
    const allowInitialCatchUp = process.env.BUDGET_ALLOW_INITIAL_CATCH_UP === 'true';
    const initialization = initializeBudgetScheduleState(
        getBudgetScheduleStatePath(),
        new Date(),
        { allowInitialCatchUp }
    );
    budgetSchedule = cron.schedule(
        BUDGET_CRON_EXPRESSION,
        () => enqueueBudgetJob(() => attemptScheduledBudgetReport('scheduled')),
        { timezone: 'Asia/Kolkata' }
    );
    budgetCatchUpSchedule = cron.schedule(
        '5 * * * *',
        () => enqueueBudgetJob(() => attemptScheduledBudgetReport('catch_up')),
        { timezone: 'Asia/Kolkata' }
    );
    if (!initialization.created || allowInitialCatchUp) {
        setImmediate(() => enqueueBudgetJob(() => attemptScheduledBudgetReport('catch_up')));
    }
    console.log('Monthly budget schedule active: the 26th at 6:00 PM Asia/Kolkata, with persisted missed-run recovery.');
}

async function startSmsIngestionIfConfigured() {
    if (process.env.SMS_INGESTION_ENABLED === 'false' || smsIngestionService) return null;
    const secret = getSmsIngestionSecret();
    if (!secret) throw new Error('SMS_INGESTION_ENABLED is true but no SMS ingestion secret is configured. Run `npm run setup:sms`.');
    const host = process.env.SMS_INGESTION_HOST || '127.0.0.1';
    const port = integerFromEnv(process.env.SMS_INGESTION_PORT, 8787, { min: 1024, max: 65535 });
    const tlsKeyPath = process.env.SMS_TLS_KEY_PATH || null;
    const tlsCertPath = process.env.SMS_TLS_CERT_PATH || null;
    const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    if (!isLoopback && (!tlsKeyPath || !tlsCertPath) && process.env.SMS_ALLOW_INSECURE_HTTP !== 'true') {
        throw new Error('A non-loopback SMS endpoint requires TLS certificate/key paths, or an explicitly trusted encrypted tunnel.');
    }
    smsIngestionService = createSmsIngestionServer({
        secret,
        host,
        port,
        tlsKeyPath,
        tlsCertPath,
        storePath: getSmsTransactionStorePath(),
        scanStatePath: getSmsScanStatePath()
    });
    const address = await smsIngestionService.listen();
    const endpoint = `${smsIngestionService.protocol}://${host}:${address.port}/v1/sms/transactions`;
    console.log(`Android transaction SMS ingestion is listening at ${endpoint}.`);
    return endpoint;
}

// --- Core Helper Functions ---

function getMealType() {
    // Get current hour in IST
    const options = { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false };
    const hour = parseInt(new Date().toLocaleString('en-US', options));

    if (hour >= 5 && hour < 12) return "Breakfast";
    if (hour >= 12 && hour < 16) return "Lunch";
    if (hour >= 16 && hour < 24) return "Dinner";
    return "Late Night Snack";
}

async function processWithGemini(input, mimeType) {
    const prompt = `
        You are the intent and nutrition-estimation layer for a WhatsApp food assistant.
        The input is either text or a Hindi/English voice note. Transcribe audio first when necessary.
        Analyze the intent:
        Intent priority rules:
        - HIGHEST PRIORITY: If someone says to buy, bring, purchase, order, pick up, or get grocery/food items, intent is 'add_reminder'. This always takes priority over 'log_food', even though the objects are foods (e.g. "buy milk", "dudh le aana", "vegetables kharidna", "eggs lana hai", "get some onions"). Apply this rule to the transcribed meaning of voice notes too.
        - If the user asks for suggestions, recommendations, or options of what to eat or cook (e.g., "suggest", "suggest dinner", "what should I eat", "recommend some breakfast options", "vegetarians option suggest"), intent is 'suggest_meal'.
        - If the user asks to summarize what they ate today, requests a daily report, or asks for macro totals (e.g., "summarize for the day", "summarize", "daily summary", "what did I eat today"), intent is 'summarize_day'.
        - If the user asks for their monthly spending, expenses, budget, payment breakdown, transaction summary, or how much they spent this month, intent is 'monthly_budget'. This includes natural Hindi/English requests such as "is mahine ka budget batao" or "where did my money go this month". Do not use this intent for "budget meal" or inexpensive meal suggestions. Set period to "current_month" unless the user explicitly names a month, in which case use YYYY-MM.
        - Also use 'monthly_budget' for a request to recategorize, regroup, rename, or regenerate a budget report, including standalone corrections such as "categorize Bottle Lab as Office Cafe" or "put restaurants under Eating Out". These are financial category instructions, not food logging.
        - Otherwise, if the message contains the name of any recognizable food, ingredient, dish, beverage, or meal, intent is 'log_food' even when it is only a bare food list and contains no verb. Examples: "chana and paneer chaat for breakfast", "2 rotis dal", "one coffee", "paneer", or "breakfast poha and milk". Do not require words such as ate, make, cook, or log.
        - Also use 'log_food' when the message states, requests, plans, or instructs that a food/dish be made, cooked, prepared, served, eaten, or consumed. Treat concrete preparation statements such as "make paneer and two rotis", "cook dal for dinner", or "aaj poha banana" as food to estimate and log; consumption need not be explicitly stated.
        - Use 'none' only when no food is identifiable and none of the other intents apply.
        
        If 'log_food' or 'add_reminder':
        1. Extract EACH distinct food/grocery item (in English) and its quantity separately.
        1a. For 'log_food', when quantity is not stated, infer and write a realistic standard serving for that item (for example "1 bowl (150 g)", "1 cup (240 ml)", or "100 g"). Never leave quantity blank or use an unexplained bare "1". Calculate nutrition for that inferred serving.
        2. For 'log_food', determine the specific meal for EACH item if mentioned (e.g., Breakfast, Lunch, Dinner, Snack). If not explicitly mentioned, output "Unknown". For 'add_reminder', set meal_type to "Unknown".
        3. For 'log_food', provide a realistic nutritional estimate for EACH distinct item. For 'add_reminder', set the nutritional numbers (calories, protein, carbs, fat, fiber) to 0.
        
        Return a JSON object with this exact structure:
        {
            "intent": "log_food" | "add_reminder" | "suggest_meal" | "summarize_day" | "monthly_budget" | "none",
            "meal_type": "string", // ONLY for 'suggest_meal'. Specify the meal type they asked for (e.g., "Breakfast", "Lunch", "Dinner", "Snack"). If not specified or clear, output "Unknown".
            "period": "current_month" | "YYYY-MM", // ONLY for 'monthly_budget'.
            "budget_category_operation": "merge" | "replace" | "clear", // ONLY for 'monthly_budget'. Default to "merge". Use "clear" only when the user explicitly asks to reset/remove all custom categories for that month. Use "replace" only when explicitly asked to replace all earlier rules.
            "budget_category_rules": [ // ONLY for a monthly-budget categorization instruction; otherwise [].
                {
                    "category_label": "user-requested category name",
                    "merchant_names": ["literal merchant names explicitly named by the user"],
                    "merchant_types": ["food_business" | "person_transfer" | "online_food_platform" | "online_delivery_platform" | "office_cafeteria" | "grocery_business" | "utilities_business" | "transport_business" | "travel_business" | "health_business" | "personal_care_business" | "education_business" | "donation_recipient" | "housing_business" | "subscription_business" | "entertainment_business" | "shopping_business" | "services_business" | "financial_services_business"],
                    "current_categories": ["online_food" | "online_delivery" | "office_cafeteria" | "misc_food" | "groceries" | "utilities" | "transport" | "travel" | "shopping" | "health" | "personal_care" | "education" | "donations" | "housing" | "subscriptions" | "entertainment" | "services" | "financial_services" | "ayush_transfers" | "transfer" | "forex" | "miscellaneous"]
                }
            ],
            "items": [
                {
                    "item": "string",
                    "quantity": "string",
                    "meal_type": "string", 
                    "calories": number,
                    "protein": number,
                    "carbs": number,
                    "fat": number,
                    "fiber": number
                }
            ]
        }
        
        Budget category-rule constraints:
        - Interpret the user's requested mapping, but never emit regex, executable code, free-form predicates, message text, payment amounts, phone numbers, sender names, references, or credentials.
        - merchant_names may contain only merchant names that the user explicitly wrote. Do not invent examples or expand a brand into related brands.
        - For "restaurants", "food stalls", cafes, bakeries, dhabas, canteens, sweets/snacks shops, or names that signify prepared-food businesses, use merchant_types ["food_business"].
        - Rules are alternatives within a target category: exact merchant names, allowed semantic merchant types, and/or existing allowed categories. Leave unused arrays empty.
        - "Forex" and "Ayush transfers" are reserved deterministic categories. Never emit either as category_label; existing transactions in those categories cannot be moved by a custom rule.
        - Never create a rule without at least one bounded selector. A normal budget request has budget_category_rules [] and operation "merge".

        If 'suggest_meal', 'summarize_day', or 'monthly_budget', set "items" to an empty array.
    `;

    const contents = mimeType === "text/plain"
        ? [prompt, input]
        : [prompt, { inlineData: { data: input, mimeType } }];

    const { response } = await generateWithGeminiFallback({
        models: jsonModels,
        contents,
        operation: mimeType === "text/plain" ? 'intent analysis' : 'voice-note analysis'
    });
    const text = response.response.text();

    try {
        return JSON.parse(text.trim());
    } catch (parseError) {
        console.error("❌ JSON Parse Failed. Raw Response:", text);
        return { intent: 'none', items: [] };
    }
}

async function logToSheets(rows) {
    const sheets = createSheetsClient({ version: 'v4', auth });
    const range = 'Sheet1!A:H';

    await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range,
        valueInputOption: 'USER_ENTERED',
        resource: { values: rows },
    });
    console.log(`📊 Successfully logged ${rows.length} items to Google Sheets.`);
}

const BUDGET_SHEET_HEADERS = {
    BudgetTransactions: [
        'transaction_id', 'occurred_at_ist', 'month_key', 'provider', 'sources', 'source_type',
        'merchant', 'channel_category', 'direction', 'amount_inr', 'currency', 'order_id_hash', 'item_count',
        'source_ids', 'duplicate_alerts_merged', 'duplicate_reasons', 'record_status', 'matched_alert_times_utc'
    ],
    BudgetItems: [
        'transaction_id', 'line_no', 'item', 'quantity', 'line_amount_inr', 'item_category', 'confidence'
    ],
    BudgetRuns: [
        'run_id', 'month_key', 'trigger', 'generated_at', 'transaction_count', 'net_spend_inr',
        'itemized_line_value_inr', 'warnings_json', 'duplicate_alerts_merged'
    ]
};

async function ensureBudgetSheets(sheets) {
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const metadata = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties.title'
    });
    const existing = new Set((metadata.data.sheets || []).map(sheet => sheet.properties?.title));
    const missing = Object.keys(BUDGET_SHEET_HEADERS).filter(title => !existing.has(title));
    if (missing.length > 0) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: missing.map(title => ({ addSheet: { properties: { title } } }))
            }
        });
    }
    await Promise.all(Object.entries(BUDGET_SHEET_HEADERS).map(([title, headers]) => sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${title}!A1:${String.fromCharCode(64 + headers.length)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headers] }
    })));
}

async function persistBudgetReportToSheets(report, trigger) {
    const sheets = createSheetsClient({ version: 'v4', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;
    await ensureBudgetSheets(sheets);
    const [existingTransactionResponse, existingItemResponse] = await Promise.all([
        sheets.spreadsheets.values.get({ spreadsheetId, range: 'BudgetTransactions!A2:R' }),
        sheets.spreadsheets.values.get({ spreadsheetId, range: 'BudgetItems!A2:G' })
    ]);
    const existingTransactionRows = existingTransactionResponse.data.values || [];
    const existingItemRows = existingItemResponse.data.values || [];
    const transactionById = new Map();
    const transactionBySourceId = new Map();
    const derivedUpdates = new Map();
    existingTransactionRows.forEach((row, index) => {
        if (!row[0]) return;
        const rowNumber = index + 2;
        const storedCategory = row[7] || '';
        const channelCategory = canonicalChannelCategory(storedCategory);
        const record = {
            id: row[0],
            rowNumber,
            provider: row[3] || '',
            merchant: row[6] || '',
            channelCategory,
            itemCount: Number(row[12]) || 0,
            sourceIds: new Set(String(row[13] || '').split(',').map(value => value.trim()).filter(Boolean)),
            duplicateCount: Number(row[14]) || 0,
            duplicateReasons: row[15] || '',
            recordStatus: row[16] || '',
            matchedAlertTimes: row[17] || ''
        };
        record.sourceIds.add(`${record.provider}:${record.id}`);
        if (storedCategory !== channelCategory) {
            derivedUpdates.set(rowNumber, [record.merchant, channelCategory]);
        }
        transactionById.set(record.id, record);
        for (const sourceId of record.sourceIds) transactionBySourceId.set(sourceId, record);
    });

    const aliasUpdates = new Map();
    const effectiveTransactions = report.transactions.map(transaction => {
        const sourceIds = new Set(transaction.sourceIds || [`${transaction.provider}:${transaction.id}`]);
        const existingMatches = new Set();
        const idMatch = transactionById.get(transaction.id);
        if (idMatch) existingMatches.add(idMatch);
        for (const sourceId of sourceIds) {
            const sourceMatch = transactionBySourceId.get(sourceId);
            if (sourceMatch) existingMatches.add(sourceMatch);
        }
        const existing = idMatch || [...existingMatches][0] || null;
        if (!existing) return { ...transaction, effectiveId: transaction.id, sourceIds: [...sourceIds], existing: null };

        const mergedSourceIds = new Set([...existing.sourceIds, ...sourceIds]);
        if (mergedSourceIds.size !== existing.sourceIds.size) {
            aliasUpdates.set(existing.rowNumber, [...mergedSourceIds].sort().join(','));
            existing.sourceIds = mergedSourceIds;
            for (const sourceId of mergedSourceIds) transactionBySourceId.set(sourceId, existing);
        }
        return {
            ...transaction,
            effectiveId: existing.id,
            sourceIds: [...mergedSourceIds],
            existing,
            existingMatches: [...existingMatches]
        };
    });
    const newTransactions = effectiveTransactions.filter(transaction => !transaction.existing);

    for (const transaction of effectiveTransactions) {
        for (const existing of transaction.existingMatches || []) {
            if (existing.merchant !== transaction.merchant || existing.channelCategory !== transaction.channelCategory) {
                derivedUpdates.set(existing.rowNumber, [transaction.merchant, transaction.channelCategory]);
            }
        }
    }

    const duplicateAuditUpdates = new Map();
    for (const transaction of effectiveTransactions) {
        if (!transaction.existing) continue;
        const reasons = (transaction.duplicateReasons || []).join(',');
        const matchedAlertTimes = (transaction.matchedAlertTimes || []).join(',');
        const canonicalValues = [
            transaction.duplicateCount || 0,
            reasons,
            'canonical',
            matchedAlertTimes
        ];
        if (transaction.existing.duplicateCount !== canonicalValues[0] ||
            transaction.existing.duplicateReasons !== canonicalValues[1] ||
            transaction.existing.recordStatus !== canonicalValues[2] ||
            transaction.existing.matchedAlertTimes !== canonicalValues[3]) {
            duplicateAuditUpdates.set(transaction.existing.rowNumber, canonicalValues);
        }
        for (const matched of transaction.existingMatches || []) {
            if (matched.rowNumber === transaction.existing.rowNumber) continue;
            const duplicateValues = [
                0,
                reasons,
                `duplicate_of:${transaction.effectiveId}`,
                matchedAlertTimes
            ];
            if (matched.duplicateCount !== duplicateValues[0] ||
                matched.duplicateReasons !== duplicateValues[1] ||
                matched.recordStatus !== duplicateValues[2] ||
                matched.matchedAlertTimes !== duplicateValues[3]) {
                duplicateAuditUpdates.set(matched.rowNumber, duplicateValues);
            }
        }
    }

    if (aliasUpdates.size > 0 || derivedUpdates.size > 0 || duplicateAuditUpdates.size > 0) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
                valueInputOption: 'RAW',
                data: [
                    ...[...aliasUpdates.entries()].map(([rowNumber, aliases]) => ({
                        range: `BudgetTransactions!N${rowNumber}`,
                        values: [[aliases]]
                    })),
                    ...[...derivedUpdates.entries()].map(([rowNumber, values]) => ({
                        range: `BudgetTransactions!G${rowNumber}:H${rowNumber}`,
                        values: [values]
                    })),
                    ...[...duplicateAuditUpdates.entries()].map(([rowNumber, values]) => ({
                        range: `BudgetTransactions!O${rowNumber}:R${rowNumber}`,
                        values: [values]
                    }))
                ]
            }
        });
    }

    if (newTransactions.length > 0) {
        const transactionRows = newTransactions.map(transaction => [
            transaction.effectiveId,
            new Date(transaction.occurredAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            report.monthKey,
            transaction.provider,
            (transaction.sources || []).join(','),
            transaction.sourceType,
            transaction.merchant,
            transaction.channelCategory,
            transaction.direction,
            transaction.amountPaise / 100,
            transaction.currency,
            transaction.orderIdHash || '',
            transaction.items?.length || 0,
            transaction.sourceIds.join(','),
            transaction.duplicateCount || 0,
            (transaction.duplicateReasons || []).join(','),
            'canonical',
            (transaction.matchedAlertTimes || []).join(',')
        ]);
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'BudgetTransactions!A:R',
            valueInputOption: 'RAW',
            requestBody: { values: transactionRows }
        });
    }

    const normalizeItemKeyPart = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const itemKey = (transactionId, item, lineAmountValue = null) => [
        transactionId,
        normalizeItemKeyPart(item.name),
        normalizeItemKeyPart(item.quantity),
        lineAmountValue == null ? '' : String(lineAmountValue)
    ].join('|');
    const existingItemKeys = new Set();
    const nextLineNumberByTransaction = new Map();
    const itemCategoryUpdates = new Map();
    existingItemRows.forEach((row, index) => {
        if (!row[0]) return;
        const lineNumber = Number(row[1]) || 0;
        nextLineNumberByTransaction.set(row[0], Math.max(nextLineNumberByTransaction.get(row[0]) || 0, lineNumber));
        existingItemKeys.add(itemKey(row[0], { name: row[2], quantity: row[3] }, row[4] === '' || row[4] == null ? null : row[4]));
        const canonicalCategory = canonicalItemCategory(row[5]);
        if (canonicalCategory && canonicalCategory !== row[5]) itemCategoryUpdates.set(index + 2, canonicalCategory);
    });
    const itemRows = [];
    for (const transaction of effectiveTransactions) {
        for (const item of transaction.items || []) {
            const lineAmount = item.lineAmountPaise == null ? null : item.lineAmountPaise / 100;
            const key = itemKey(transaction.effectiveId, item, lineAmount);
            if (existingItemKeys.has(key)) continue;
            existingItemKeys.add(key);
            const lineNumber = (nextLineNumberByTransaction.get(transaction.effectiveId) || 0) + 1;
            nextLineNumberByTransaction.set(transaction.effectiveId, lineNumber);
            itemRows.push([
                transaction.effectiveId,
                lineNumber,
                item.name,
                item.quantity || '',
                lineAmount == null ? '' : lineAmount,
                canonicalItemCategory(item.category),
                item.confidence == null ? '' : item.confidence
            ]);
        }
    }
    if (itemRows.length > 0) {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'BudgetItems!A:G',
            valueInputOption: 'RAW',
            requestBody: { values: itemRows }
        });
    }

    if (itemCategoryUpdates.size > 0) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
                valueInputOption: 'RAW',
                data: [...itemCategoryUpdates.entries()].map(([rowNumber, category]) => ({
                    range: `BudgetItems!F${rowNumber}`,
                    values: [[category]]
                }))
            }
        });
    }

    const itemCountUpdates = new Map();
    for (const transaction of effectiveTransactions) {
        if (!transaction.existing) continue;
        const finalCount = nextLineNumberByTransaction.get(transaction.effectiveId) || transaction.existing.itemCount;
        if (finalCount !== transaction.existing.itemCount) {
            itemCountUpdates.set(transaction.existing.rowNumber, finalCount);
        }
    }
    if (itemCountUpdates.size > 0) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
                valueInputOption: 'RAW',
                data: [...itemCountUpdates.entries()].map(([rowNumber, count]) => ({
                    range: `BudgetTransactions!M${rowNumber}`,
                    values: [[count]]
                }))
            }
        });
    }

    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'BudgetRuns!A:I',
        valueInputOption: 'RAW',
        requestBody: {
            values: [[
                `${report.monthKey}-${Date.now()}`,
                report.monthKey,
                trigger,
                report.generatedAt,
                report.summary.transactionCount,
                report.summary.netPaise / 100,
                report.summary.itemizedLinePaise / 100,
                JSON.stringify(report.warnings || []),
                report.summary.duplicateRecordsMerged || 0
            ]]
        }
    });
    console.log(`Persisted ${newTransactions.length} new budget transaction(s) and ${itemRows.length} missing item row(s) to Google Sheets.`);
}

async function addToGoogleTasks(item) {
    // A newly authorized token file is picked up without restarting WhatsApp.
    loadGoogleTasksOAuthClient({ onlyIfChanged: true });
    if (!oauth2Client) {
        console.warn(`⚠️ Google Tasks is not configured. Could not add "${item}". Please run 'node auth-tasks.js'.`);
        return false;
    }
    try {
        const tasks = createTasksClient({ version: 'v1', auth: oauth2Client });
        await tasks.tasks.insert({
            tasklist: '@default',
            requestBody: {
                title: `Buy ${item}`,
                notes: 'Added via WhatsApp Cook Agent'
            },
        });
        console.log(`📝 Successfully added ${item} to Google Tasks.`);
        return true;
    } catch (taskError) {
        const errorCode = taskError?.response?.data?.error || taskError?.code;
        const errorDescription = taskError?.response?.data?.error_description || taskError?.message || '';
        if (errorCode === 'invalid_grant' || /invalid_grant/i.test(errorDescription)) {
            googleTasksAuthNeedsRenewal = true;
            console.error('❌ Google Tasks authorization expired or was revoked. Run `node auth-tasks.js` to reconnect it.');
            return false;
        }
        console.error(`❌ Failed to add "${item}" to Google Tasks:`, taskError.message || taskError);
        return false;
    }
}

// --- Vegetarian Suggestion Helpers ---

async function getDailyLogs() {
    try {
        const sheets = createSheetsClient({ version: 'v4', auth });
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'Sheet1!A:H',
        });
        const rows = res.data.values || [];
        if (rows.length <= 1) return [];

        const todayDateStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }).split(',')[0].trim();

        const dailyLogs = [];
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || !row[0]) continue;
            const rowDateStr = row[0].split(',')[0].trim();
            if (rowDateStr === todayDateStr) {
                dailyLogs.push({
                    time: row[0],
                    item: row[1] || '',
                    quantity: row[2] || '',
                    calories: parseFloat(row[3]) || 0,
                    protein: parseFloat(row[4]) || 0,
                    carbs: parseFloat(row[5]) || 0,
                    fat: parseFloat(row[6]) || 0,
                    fiber: parseFloat(row[7]) || 0,
                });
            }
        }
        return dailyLogs;
    } catch (e) {
        console.error("❌ Failed to fetch daily food logs from Google Sheets:", e);
        return [];
    }
}

async function getUserGoal() {
    if (process.env.USER_GOAL && process.env.USER_GOAL.trim() !== '') {
        return process.env.USER_GOAL.trim();
    }

    try {
        const sheets = createSheetsClient({ version: 'v4', auth });
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'Goal!A1:B10',
        });
        const rows = res.data.values || [];
        if (rows.length > 0) {
            return rows.map(r => r.join(': ')).join('\n');
        }
    } catch (e) {
        // Goal sheet doesn't exist
    }

    return "Daily target: 2000 calories, 130g protein, 180g carbs, 65g fat. Goal is muscle building and staying fit.";
}

async function generateSuggestions(mealType, dailyLogs, overallGoal) {
    const totalToday = dailyLogs.reduce((acc, log) => {
        acc.calories += log.calories;
        acc.protein += log.protein;
        acc.carbs += log.carbs;
        acc.fat += log.fat;
        acc.fiber += log.fiber;
        return acc;
    }, { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });

    const foodListStr = dailyLogs.length > 0
        ? dailyLogs.map(log => `- ${log.item} (${log.quantity}): ${log.calories} kcal, ${log.protein}g P, ${log.carbs}g C, ${log.fat}g F, ${log.fiber}g Fi`).join('\n')
        : "No food logged yet today.";

    const prompt = `
        You are an expert nutritional advisor.
        The user is requesting exactly 5 vegetarian food options/suggestions for their upcoming meal: *${mealType}*.
        
        Here is the user's information:
        - *Overall Fitness/Diet Goal*:
        ${overallGoal}
        
        - *Food consumed today so far*:
        ${foodListStr}
        
        - *Total nutritional intake today so far*:
        Calories: ${totalToday.calories.toFixed(1)} kcal | Protein: ${totalToday.protein.toFixed(1)}g | Carbs: ${totalToday.carbs.toFixed(1)}g | Fat: ${totalToday.fat.toFixed(1)}g | Fiber: ${totalToday.fiber.toFixed(1)}g

        Your task is to recommend exactly 5 delicious, high-quality, and realistic Indian vegetarian options for their *${mealType}*.
        The options should complement what they have already eaten today and align with their overall goal.
        
        Format the message beautifully for WhatsApp using emojis and bold text.
        To minimize tokens and keep it extremely direct:
        - Output ONLY the 5 recommended options and their macros.
        - NO greeting, conversational filler, summaries of today's eaten foods, or verbose intros/outros.
        - For each option, list:
          1. Emojis and catchy Name (e.g. 🍛 *Paneer Tikka Salad*)
          2. Portion/Quantity
          3. Extremely brief reason it fits (1 sentence max)
          4. Macros (kcal, P, C, F, Fi)
    `;

    try {
        const { response } = await generateWithGeminiFallback({
            models: textModels,
            contents: [prompt],
            operation: 'meal suggestions'
        });
        return response.response.text().trim();
    } catch (error) {
        console.error("❌ Failed to generate suggestions with Gemini:", error);
        return `⚠️ Sorry, I encountered an issue generating food suggestions for you. Please try again!`;
    }
}

function jidsMatch(jid1, jid2) {
    if (!jid1 || !jid2) return false;
    const [firstUser, firstDomain = ''] = String(jid1).trim().toLowerCase().split('@');
    const [secondUser, secondDomain = ''] = String(jid2).trim().toLowerCase().split('@');
    if (!firstUser || firstUser !== secondUser) return false;
    if (firstDomain === secondDomain) return true;
    // A direct WhatsApp identity can appear as phone-number or LID form. Never
    // equate either form with a group/broadcast/status domain.
    return ['c.us', 'lid'].includes(firstDomain) && ['c.us', 'lid'].includes(secondDomain);
}

async function generateDailySummary(dailyLogs, overallGoal) {
    const totalToday = dailyLogs.reduce((acc, log) => {
        acc.calories += log.calories;
        acc.protein += log.protein;
        acc.carbs += log.carbs;
        acc.fat += log.fat;
        acc.fiber += log.fiber;
        return acc;
    }, { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });

    const foodListStr = dailyLogs.length > 0
        ? dailyLogs.map(log => `- ${log.item} (${log.quantity}): ${log.calories} kcal, ${log.protein}g P, ${log.fiber}g Fi`).join('\n')
        : "None.";

    const prompt = `
        You are a concise macro calculator.
        Summarize what the user ate today and how it compares to their overall goals.
        
        Information:
        - Goal: ${overallGoal}
        - Food Eaten Today:
        ${foodListStr}
        
        - Totals Today:
        Calories: ${totalToday.calories.toFixed(1)} kcal | Protein: ${totalToday.protein.toFixed(1)}g | Carbs: ${totalToday.carbs.toFixed(1)}g | Fat: ${totalToday.fat.toFixed(1)}g | Fiber: ${totalToday.fiber.toFixed(1)}g

        Your task is to generate a highly concise daily summary for WhatsApp.
        Output ONLY:
        1. List of eaten food items today
        2. Today's Totals (kcal, P, C, F, Fi)
        3. Remaining to hit overall goals
        
        Absolutely no greeting, conversational intro/outro, or verbose comments. Make it extremely direct, compact, and brief to save tokens.
    `;

    try {
        const { response } = await generateWithGeminiFallback({
            models: textModels,
            contents: [prompt],
            operation: 'daily nutrition summary'
        });
        return response.response.text().trim();
    } catch (error) {
        console.error("❌ Failed to generate daily summary with Gemini:", error);
        return `⚠️ Sorry, I encountered an issue generating your daily summary. Please try again!`;
    }
}

async function initializeWhatsApp(attempt = 1) {
    writeAgentStatus('initializing_whatsapp', { attempt });
    console.log(`⏳ Starting WhatsApp in the background (attempt ${attempt})...`);
    console.log('   Stock, budget, and SMS services will start automatically after WhatsApp is ready.');
    const waitingLog = setTimeout(() => {
        console.warn('⏳ WhatsApp is still initializing. Keep this terminal open; a QR code or a specific error will be shown here if action is required.');
    }, 30000);
    try {
        await client.initialize();
        clearTimeout(waitingLog);
    } catch (error) {
        clearTimeout(waitingLog);
        whatsappReadinessWatchdog.reset();
        const message = error?.message || String(error);
        const transientNavigationError = /execution context|navigation|runtime\.callfunctionon|protocol error/i.test(message);
        console.error(`❌ WhatsApp initialization attempt ${attempt} failed:`, message);

        if (transientNavigationError && attempt < 4) {
            const retryDelayMs = attempt * 15000;
            writeAgentStatus('initialization_retry', {
                attempt,
                retryInSeconds: retryDelayMs / 1000,
                error: message
            });
            try {
                await client.destroy();
            } catch (_) {
                // A partially initialized browser may already be closed.
            }
            setTimeout(() => initializeWhatsApp(attempt + 1), retryDelayMs);
            return;
        }

        writeAgentStatus('initialization_failed', { attempt, error: message });
        // Exit the foreground npm process after cleanup. The user can run
        // `npm start` again; no external supervisor is installed.
        try {
            await client.destroy();
        } catch (_) {
            // The browser may already be gone after an initialization failure.
        }
        setTimeout(() => process.exit(1), 500);
    }
}

let shutdownStarted = false;
async function shutdownAgent(signal) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    whatsappReadinessWatchdog.stop();
    writeAgentStatus('stopping', { signal });
    console.log(`Stopping WhatsApp agent (${signal})...`);
    for (const task of [stockSchedule, budgetSchedule, budgetCatchUpSchedule, swiggyOrderSyncSchedule]) {
        try {
            task?.stop?.();
        } catch (error) {
            console.warn('Could not stop an in-process schedule:', error.message || error);
        }
    }
    if (smsIngestionService) {
        try {
            await smsIngestionService.close();
        } catch (error) {
            console.warn('Could not close SMS ingestion cleanly:', error.message || error);
        }
        smsIngestionService = null;
    }
    try {
        await client.destroy();
    } catch (error) {
        console.warn('Could not close WhatsApp cleanly:', error.message || error);
    }
    writeAgentStatus('stopped', { signal });
    process.exit(0);
}

process.once('SIGINT', () => void shutdownAgent('SIGINT'));
process.once('SIGTERM', () => void shutdownAgent('SIGTERM'));

initializeWhatsApp();
