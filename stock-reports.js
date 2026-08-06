const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveRuntimePath } = require('./runtime-paths');

const PROJECT_DIR = __dirname;
const SCRIPT_PATH = path.join(PROJECT_DIR, 'gemini-code.py');
const REPORTS_DIR = resolveRuntimePath({
    envKey: 'STOCK_REPORTS_DIR',
    relativeSegments: ['stock-reports'],
    legacyPath: path.join(PROJECT_DIR, 'reports')
});
const RESULT_MARKER = 'REPORT_RESULT_JSON=';

const STOCK_WORDS = /\b(?:stocks?|tickers?|shares?|equities|equity|valuations?|reports?|analysis|analyse|analyze)\b/i;
const REQUEST_WORDS = /\b(?:reports?|analysis|analyse|analyze|valuations?|run|generate|create|give|show)\b/i;
const STOCK_RESPONSE_HEADER = /\*(?:Stock report (?:status|ready|failed)|Scheduled stock reports?(?: ready| failed)?|Complete stock reports?(?: ready| failed)?)\b/i;
const TICKER_STOP_WORDS = new Set([
    'A', 'ALL', 'AN', 'ANALYSIS', 'ANALYSE', 'ANALYZE', 'BATCH', 'COMPLETE', 'CREATE',
    'DAILY', 'DAY', 'EQUITIES', 'EQUITY', 'FOR', 'FULL', 'GIVE', 'LIST', 'ME', 'MY',
    'OF', 'ON', 'OVERALL', 'PLEASE', 'PORTFOLIO', 'REPORT', 'REPORTS', 'RUN', 'SHARE',
    'SHARES', 'SHOW', 'STOCK', 'STOCKS', 'THE', 'TICKER', 'TICKERS', 'TODAY', 'TODAYS',
    'COMPLETED', 'FAILED', 'HTML', 'OPEN', 'QUEUED', 'READY', 'STATUS', 'VALUATION', 'ZIP'
]);

function isValidTicker(value) {
    return /^[A-Z^][A-Z0-9.\-=^]{0,14}$/.test(value) && !TICKER_STOP_WORDS.has(value);
}

/**
 * Recognize deliberately stock-related self-chat requests without sending ordinary
 * nutrition messages to the expensive Python report engine.
 */
function extractTickerRequest(text) {
    if (typeof text !== 'string' || STOCK_RESPONSE_HEADER.test(text) || !STOCK_WORDS.test(text) || !REQUEST_WORDS.test(text)) {
        return null;
    }

    const hasExplicitStockNoun = /\b(?:stock|ticker|share|equity|valuation)\b/i.test(text);

    const patterns = [
        /\b(?:report|analysis|analyse|analyze|valuation)\s+(?:of|for|on)?\s*\$?([A-Za-z^][A-Za-z0-9.\-=^]{0,14})\b/i,
        /\b(?:stock|ticker|share|equity)\s+(?:report|analysis|analyse|analyze|valuation)?\s*(?:of|for|on)?\s*\$?([A-Za-z^][A-Za-z0-9.\-=^]{0,14})\b/i,
        /\$([A-Za-z][A-Za-z0-9.\-=^]{0,14})\b/
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        const rawTicker = match?.[1];
        const ticker = rawTicker?.toUpperCase();
        const deliberatelyTickerShaped = rawTicker && (rawTicker === rawTicker.toUpperCase() || match?.[0]?.includes('$'));
        if (ticker && isValidTicker(ticker) && (hasExplicitStockNoun || deliberatelyTickerShaped)) return ticker;
    }

    // Natural requests such as "please run a stock report for AMD" are best
    // handled by looking at the final ticker-like token after intent is established.
    const candidates = text.match(/[A-Za-z^][A-Za-z0-9.\-=^]{0,14}/g) || [];
    const candidate = candidates.reverse().find(value => {
        const normalized = value.toUpperCase();
        // Nearby lowercase words in a generic request ("day", "today's",
        // "morning") are prose, not symbols. Lowercase tickers are already
        // accepted by the explicit stock/report patterns above.
        return isValidTicker(normalized) && value === normalized;
    });
    return candidate?.toUpperCase() || null;
}

/**
 * Distinguish a report for one explicit ticker from a request for the complete
 * configured batch. Generic phrases such as "stock report of the day" must not
 * turn ordinary words such as DAY into ticker symbols.
 */
function parseStockReportRequest(text) {
    if (typeof text !== 'string' || STOCK_RESPONSE_HEADER.test(text) || !STOCK_WORDS.test(text) || !REQUEST_WORDS.test(text)) {
        return null;
    }

    const ticker = extractTickerRequest(text);
    if (ticker) return { scope: 'ticker', ticker };

    const hasExplicitStockNoun = /\b(?:stocks?|tickers?|shares?|equities|equity|valuation)\b/i.test(text);
    if (hasExplicitStockNoun) return { scope: 'all', ticker: null };
    return null;
}

function pythonCandidates() {
    const candidates = [];
    if (process.env.PYTHON_EXECUTABLE) candidates.push(process.env.PYTHON_EXECUTABLE);

    if (process.platform === 'win32') {
        const localPrograms = process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python')
            : null;
        if (localPrograms && fs.existsSync(localPrograms)) {
            const installations = fs.readdirSync(localPrograms, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && /^Python\d+$/i.test(entry.name))
                .map(entry => path.join(localPrograms, entry.name, 'python.exe'))
                .sort()
                .reverse();
            candidates.push(...installations);
        }
        candidates.push('py', 'python');
    } else {
        candidates.push('python3', 'python');
    }

    return [...new Set(candidates)];
}

function findPythonExecutable() {
    for (const candidate of pythonCandidates()) {
        const args = path.basename(candidate).toLowerCase() === 'py' ? ['-3', '--version'] : ['--version'];
        const check = spawnSync(candidate, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        if (!check.error && check.status === 0 && /Python 3\./i.test(`${check.stdout}\n${check.stderr}`)) {
            return {
                command: candidate,
                prefixArgs: path.basename(candidate).toLowerCase() === 'py' ? ['-3'] : []
            };
        }
    }
    throw new Error('Python 3 was not found. Set PYTHON_EXECUTABLE in .env to a working Python 3 executable.');
}

function runStockReports(tickers = null) {
    const python = findPythonExecutable();
    fs.mkdirSync(REPORTS_DIR, { recursive: true });

    const args = [
        ...python.prefixArgs,
        SCRIPT_PATH,
        '--output-dir', REPORTS_DIR,
        '--json'
    ];
    if (tickers) {
        const tickerValue = Array.isArray(tickers) ? tickers.join(',') : String(tickers);
        args.push('--tickers', tickerValue);
    }

    const timeoutMinutes = Math.max(5, Number(process.env.STOCK_REPORT_TIMEOUT_MINUTES) || 180);
    const maxOutputBytes = 2 * 1024 * 1024;

    return new Promise((resolve, reject) => {
        console.log(`Starting stock report engine with ${python.command}${tickers ? ` for ${tickers}` : ' for the configured batch'}...`);
        const child = spawn(python.command, args, {
            cwd: PROJECT_DIR,
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
            windowsHide: true
        });

        let output = '';
        const record = chunk => {
            const value = chunk.toString();
            process.stdout.write(value);
            output = (output + value).slice(-maxOutputBytes);
        };
        child.stdout.on('data', record);
        child.stderr.on('data', record);

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Stock report generation exceeded ${timeoutMinutes} minutes.`));
        }, timeoutMinutes * 60 * 1000);

        child.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) {
                const tail = output.split(/\r?\n/).slice(-20).join('\n');
                reject(new Error(`Stock report engine exited with code ${code}.\n${tail}`));
                return;
            }

            const markerIndex = output.lastIndexOf(RESULT_MARKER);
            if (markerIndex < 0) {
                reject(new Error('Stock report engine finished without returning its result manifest.'));
                return;
            }
            const jsonLine = output.slice(markerIndex + RESULT_MARKER.length).split(/\r?\n/, 1)[0];
            try {
                resolve(JSON.parse(jsonLine));
            } catch (error) {
                reject(new Error(`Could not parse stock report result: ${error.message}`));
            }
        });
    });
}

function stockHealth() {
    const python = findPythonExecutable();
    return {
        python: python.command,
        script: SCRIPT_PATH,
        reportsDirectory: REPORTS_DIR,
        hostname: os.hostname()
    };
}

module.exports = {
    extractTickerRequest,
    parseStockReportRequest,
    runStockReports,
    stockHealth
};
