const fs = require('fs');
const os = require('os');
const path = require('path');

function environmentValue(env, name) {
    const value = String(env?.[name] || '').trim();
    return value || null;
}

/**
 * Return the private writable directory used by long-lived agent state.
 *
 * AGENT_DATA_DIR is deliberately the only cross-platform override needed for
 * cloud deployments. With no override, Windows keeps the locations used by
 * the existing application and other platforms use a private directory in the
 * current user's home folder.
 */
function getAgentDataDirectory({
    env = process.env,
    platform = process.platform,
    homedir = os.homedir()
} = {}) {
    const configured = environmentValue(env, 'AGENT_DATA_DIR');
    if (configured) return path.resolve(configured);

    const localAppData = environmentValue(env, 'LOCALAPPDATA');
    if (platform === 'win32' && localAppData) {
        return path.join(localAppData, 'WhatsAppFoodAgent');
    }

    return path.join(homedir, '.whatsapp-food-agent');
}

function getAgentDataPath(...segments) {
    return path.join(getAgentDataDirectory(), ...segments);
}

/**
 * Resolve a configurable mutable file/directory while retaining its legacy
 * path when AGENT_DATA_DIR has not been opted into.
 */
function resolveRuntimePath({
    envKey,
    relativeSegments = [],
    legacyPath = null,
    env = process.env,
    platform = process.platform,
    homedir = os.homedir()
}) {
    const configured = environmentValue(env, envKey);
    if (configured) return path.resolve(configured);

    if (environmentValue(env, 'AGENT_DATA_DIR')) {
        return path.join(getAgentDataDirectory({ env, platform, homedir }), ...relativeSegments);
    }

    return legacyPath == null ? null : path.resolve(legacyPath);
}

function browserCandidates({ env = process.env, platform = process.platform } = {}) {
    if (platform === 'win32') {
        const programFiles = environmentValue(env, 'ProgramFiles') || 'C:\\Program Files';
        const programFilesX86 = environmentValue(env, 'ProgramFiles(x86)') || 'C:\\Program Files (x86)';
        const localAppData = environmentValue(env, 'LOCALAPPDATA');
        return [
            // This was the application's original browser path and remains the
            // first Windows default for existing installations.
            'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
            path.win32.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            localAppData && path.win32.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            path.win32.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.win32.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.win32.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.win32.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        ].filter(Boolean);
    }

    if (platform === 'darwin') {
        return [
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        ];
    }

    return [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/snap/bin/chromium'
    ];
}

function findWhatsAppBrowserExecutable({
    env = process.env,
    platform = process.platform,
    existsSync = fs.existsSync
} = {}) {
    const configured = environmentValue(env, 'WHATSAPP_BROWSER_EXECUTABLE')
        || environmentValue(env, 'PUPPETEER_EXECUTABLE_PATH');
    if (configured) return configured;

    return browserCandidates({ env, platform }).find(candidate => existsSync(candidate)) || null;
}

module.exports = {
    browserCandidates,
    environmentValue,
    findWhatsAppBrowserExecutable,
    getAgentDataDirectory,
    getAgentDataPath,
    resolveRuntimePath
};
