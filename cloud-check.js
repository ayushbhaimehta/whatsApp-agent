const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cloudEnvPath = path.resolve(process.env.CLOUD_ENV_FILE || '.env.cloud');
if (fs.existsSync(cloudEnvPath)) {
    require('dotenv').config({ path: cloudEnvPath, quiet: true });
} else {
    require('dotenv').config({ quiet: true });
}

const {
    findWhatsAppBrowserExecutable,
    getAgentDataDirectory,
    resolveRuntimePath
} = require('./runtime-paths');
const { hasSwiggyAuthState } = require('./swiggy-orders');
const { assertBudgetChatConfiguration } = require('./budget-access-policy');

function isConfigured(name) {
    return Boolean(String(process.env[name] || '').trim());
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function commandResult(command, args) {
    return spawnSync(command, args, {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true
    });
}

function runCloudPreflight({ logger = console } = {}) {
    const results = [];
    const add = (level, label, detail = '') => results.push({ level, label, detail });

    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (nodeMajor >= 24) add('ok', `Node ${process.versions.node}`);
    else add('error', `Node ${process.versions.node}`, 'The cloud image requires a supported Node 24 or newer release.');

    for (const name of ['GEMINI_API_KEY', 'SPREADSHEET_ID']) {
        if (isConfigured(name)) add('ok', `${name} is configured`);
        else add('error', `${name} is missing`, 'Set it in .env.cloud.');
    }
    if (isConfigured('COOK_CHAT_ID')) add('ok', 'COOK_CHAT_ID is configured');
    else add('warn', 'COOK_CHAT_ID is blank', 'Cook-chat food and shopping commands will be unavailable.');
    try {
        assertBudgetChatConfiguration({
            personalChatId: process.env.PERSONAL_CHAT_ID,
            cookChatId: process.env.COOK_CHAT_ID
        });
        add('ok', 'PERSONAL_CHAT_ID is a valid private budget destination');
    } catch (error) {
        add('error', 'Budget personal-chat guardrail is not configured', error.message || String(error));
    }

    const dataDirectory = getAgentDataDirectory();
    try {
        fs.accessSync(dataDirectory, fs.constants.R_OK | fs.constants.W_OK);
        add('ok', 'Persistent data directory is readable and writable', dataDirectory);
    } catch {
        add('error', 'Persistent data directory is not writable', dataDirectory);
    }

    const browser = findWhatsAppBrowserExecutable();
    if (!browser) {
        add('error', 'Chromium/Chrome executable was not found', 'Set WHATSAPP_BROWSER_EXECUTABLE.');
    } else {
        try {
            // Do not launch the user's desktop browser during a preflight. On
            // Linux, X_OK also confirms the container can execute Chromium.
            fs.accessSync(browser, fs.constants.R_OK | fs.constants.X_OK);
            add('ok', 'WhatsApp browser executable is accessible', browser);
        } catch {
            add('error', 'WhatsApp browser executable is not accessible', browser);
        }
    }

    const python = String(process.env.PYTHON_EXECUTABLE || (process.platform === 'win32' ? 'python' : 'python3')).trim();
    const pythonCheck = commandResult(python, [
        '-c',
        'import google.genai, pandas, requests, yfinance; print("Python stock dependencies are ready")'
    ]);
    if (!pythonCheck.error && pythonCheck.status === 0) {
        add('ok', 'Python stock engine dependencies are importable', python);
    } else {
        add('error', 'Python stock engine dependencies failed', String(pythonCheck.stderr || pythonCheck.error?.message || python).trim());
    }

    const serviceAccountPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS || 'service-account.json');
    const serviceAccount = readJson(serviceAccountPath);
    if (serviceAccount?.client_email && serviceAccount?.private_key) {
        add('ok', 'Google Sheets service account file is valid', serviceAccountPath);
    } else {
        add('error', 'Google Sheets service account file is missing or invalid', serviceAccountPath);
    }

    const tasksTokenPath = resolveRuntimePath({
        envKey: 'GOOGLE_TASKS_TOKEN_PATH',
        relativeSegments: ['secrets', 'google-tasks-token.json'],
        legacyPath: path.join(__dirname, 'google-tasks-token.json')
    });
    const tasksToken = readJson(tasksTokenPath);
    if (tasksToken?.client_id && tasksToken?.client_secret && (tasksToken?.tokens?.refresh_token || tasksToken?.tokens?.access_token)) {
        add('ok', 'Google Tasks OAuth token is present', tasksTokenPath);
    } else {
        add('warn', 'Google Tasks OAuth token is not ready', 'Run npm run auth:tasks through the SSH tunnel.');
    }

    const gmailTokenPath = path.resolve(
        process.env.BUDGET_GMAIL_TOKEN_PATH || path.join(dataDirectory, 'google-budget-token.json')
    );
    const gmailToken = readJson(gmailTokenPath);
    if (gmailToken?.tokens?.refresh_token || gmailToken?.tokens?.access_token) {
        add('ok', 'Optional Gmail receipt token is present', gmailTokenPath);
    } else {
        add('warn', 'Optional Gmail receipt token is absent', 'SMS-only budget reports still work; run npm run auth:budget to enable Gmail receipts.');
    }

    if (process.env.SMS_INGESTION_ENABLED !== 'false') {
        const host = String(process.env.SMS_INGESTION_HOST || '127.0.0.1').trim();
        if (['127.0.0.1', 'localhost', '::1'].includes(host)) {
            add('ok', 'SMS receiver is restricted to loopback', host);
        } else {
            add('error', 'SMS receiver is not restricted to loopback', 'Use 127.0.0.1 with Tailscale Serve.');
        }

        const smsSecretPath = path.resolve(
            process.env.SMS_INGESTION_SECRET_FILE || path.join(dataDirectory, 'secrets', 'sms-ingestion-secret.txt')
        );
        let smsSecret = '';
        try {
            smsSecret = fs.readFileSync(smsSecretPath, 'utf8').trim();
        } catch {
            // Report a safe error below without exposing secret material.
        }
        const inlineSmsSecret = String(process.env.SMS_INGESTION_SECRET || '').trim();
        if (inlineSmsSecret.length >= 32 || smsSecret.length >= 32) {
            add('ok', 'SMS ingestion secret is present');
        } else {
            add('error', 'SMS ingestion secret is missing or too short', smsSecretPath);
        }
    } else {
        add('warn', 'SMS ingestion is disabled', 'Monthly budget reports require a complete Android SMS scan.');
    }

    if (process.env.SWIGGY_ORDER_HISTORY_ENABLED !== 'false') {
        const swiggyAuthDirectory = path.resolve(
            process.env.SWIGGY_MCP_AUTH_DIR || path.join(dataDirectory, 'secrets', 'swiggy-mcp-auth')
        );
        if (hasSwiggyAuthState(swiggyAuthDirectory)) {
            add('ok', 'Optional Swiggy authorization state is present and within its local age limit', swiggyAuthDirectory);
        } else {
            const condition = fs.existsSync(swiggyAuthDirectory) ? 'incomplete or locally expired' : 'absent';
            add('warn', `Optional Swiggy auth is ${condition}`, 'Run npm run auth:swiggy through the SSH tunnel, or set SWIGGY_ORDER_HISTORY_ENABLED=false.');
        }
    }

    for (const result of results) {
        const prefix = result.level === 'ok' ? 'OK' : result.level === 'warn' ? 'WARN' : 'ERROR';
        logger.log(`[${prefix}] ${result.label}${result.detail ? ` - ${result.detail}` : ''}`);
    }

    const errorCount = results.filter(result => result.level === 'error').length;
    const warningCount = results.filter(result => result.level === 'warn').length;
    if (errorCount) {
        logger.error(`Cloud preflight failed: ${errorCount} error(s), ${warningCount} warning(s).`);
    } else {
        logger.log(`Cloud preflight passed${warningCount ? ` with ${warningCount} warning(s)` : ''}.`);
    }
    return { results, errorCount, warningCount };
}

if (require.main === module) {
    const result = runCloudPreflight();
    if (result.errorCount) process.exitCode = 1;
}

module.exports = { runCloudPreflight };
