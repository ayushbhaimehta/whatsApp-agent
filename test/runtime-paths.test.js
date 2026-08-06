const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    browserCandidates,
    findWhatsAppBrowserExecutable,
    getAgentDataDirectory,
    resolveRuntimePath
} = require('../runtime-paths');

test('keeps the existing LOCALAPPDATA root by default on Windows', () => {
    const localAppData = 'C:\\Users\\example\\AppData\\Local';
    assert.equal(
        getAgentDataDirectory({
            env: { LOCALAPPDATA: localAppData },
            platform: 'win32',
            homedir: 'C:\\Users\\example'
        }),
        path.join(localAppData, 'WhatsAppFoodAgent')
    );
});

test('uses a private home directory fallback on non-Windows systems', () => {
    assert.equal(
        getAgentDataDirectory({ env: {}, platform: 'linux', homedir: '/home/example' }),
        path.join('/home/example', '.whatsapp-food-agent')
    );
});

test('AGENT_DATA_DIR overrides platform defaults', () => {
    const configured = path.join('persistent', 'agent-data');
    assert.equal(
        getAgentDataDirectory({
            env: { AGENT_DATA_DIR: configured, LOCALAPPDATA: 'C:\\legacy' },
            platform: 'win32',
            homedir: 'C:\\Users\\example'
        }),
        path.resolve(configured)
    );
});

test('runtime paths retain legacy locations until cloud storage is configured', () => {
    const legacyPath = path.join('legacy', 'chat-events.log');
    assert.equal(
        resolveRuntimePath({
            envKey: 'WHATSAPP_AUDIT_LOG_PATH',
            relativeSegments: ['chat-events.log'],
            legacyPath,
            env: {},
            platform: 'win32',
            homedir: 'C:\\Users\\example'
        }),
        path.resolve(legacyPath)
    );
});

test('runtime paths derive from AGENT_DATA_DIR and allow a specific override', () => {
    const dataRoot = path.join('persistent', 'agent-data');
    const specificPath = path.join('other', 'audit.log');
    const commonOptions = {
        envKey: 'WHATSAPP_AUDIT_LOG_PATH',
        relativeSegments: ['chat-events.log'],
        legacyPath: path.join('legacy', 'chat-events.log'),
        platform: 'linux',
        homedir: '/home/example'
    };

    assert.equal(
        resolveRuntimePath({ ...commonOptions, env: { AGENT_DATA_DIR: dataRoot } }),
        path.join(path.resolve(dataRoot), 'chat-events.log')
    );
    assert.equal(
        resolveRuntimePath({
            ...commonOptions,
            env: {
                AGENT_DATA_DIR: dataRoot,
                WHATSAPP_AUDIT_LOG_PATH: specificPath
            }
        }),
        path.resolve(specificPath)
    );
});

test('configured WhatsApp browser takes precedence over discovery', () => {
    assert.equal(
        findWhatsAppBrowserExecutable({
            env: {
                WHATSAPP_BROWSER_EXECUTABLE: '/custom/chrome',
                PUPPETEER_EXECUTABLE_PATH: '/secondary/chrome'
            },
            platform: 'linux',
            existsSync: () => false
        }),
        '/custom/chrome'
    );
});

test('browser discovery preserves Brave first on Windows and finds Chromium on Linux', () => {
    const windowsCandidates = browserCandidates({ env: {}, platform: 'win32' });
    assert.equal(
        windowsCandidates[0],
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    );
    assert.equal(
        findWhatsAppBrowserExecutable({
            env: {},
            platform: 'win32',
            existsSync: candidate => candidate === windowsCandidates[0]
        }),
        windowsCandidates[0]
    );
    assert.equal(
        findWhatsAppBrowserExecutable({
            env: {},
            platform: 'linux',
            existsSync: candidate => candidate === '/usr/bin/chromium'
        }),
        '/usr/bin/chromium'
    );
});

test('browser discovery can defer to Puppeteer when no system browser exists', () => {
    assert.equal(
        findWhatsAppBrowserExecutable({ env: {}, platform: 'linux', existsSync: () => false }),
        null
    );
});
