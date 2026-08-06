const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { google } = require('googleapis');
const { getAgentDataDirectory, resolveRuntimePath } = require('./runtime-paths');
require('dotenv').config();

const PORT = Number(process.env.BUDGET_OAUTH_PORT || 3001);
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const PRIVATE_DATA_ROOT = getAgentDataDirectory();
const TOKEN_PATH = process.env.BUDGET_GMAIL_TOKEN_PATH || path.join(PRIVATE_DATA_ROOT, 'google-budget-token.json');
const TASKS_TOKEN_PATH = resolveRuntimePath({
    envKey: 'GOOGLE_TASKS_TOKEN_PATH',
    relativeSegments: ['secrets', 'google-tasks-token.json'],
    legacyPath: path.join(__dirname, 'google-tasks-token.json')
});

function loadClientCredentials() {
    let clientId = process.env.GOOGLE_CLIENT_ID;
    let clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if ((!clientId || !clientSecret) && fs.existsSync(TASKS_TOKEN_PATH)) {
        const existing = JSON.parse(fs.readFileSync(TASKS_TOKEN_PATH, 'utf8'));
        clientId ||= existing.client_id;
        clientSecret ||= existing.client_secret;
    }
    if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required (or reconnect Google Tasks first).');
    }
    return { clientId, clientSecret };
}

async function main() {
    const { clientId, clientSecret } = loadClientCredentials();
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
    const oauthState = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(64).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/gmail.readonly'],
        state: oauthState,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
    });

    const server = http.createServer(async (request, response) => {
        if (!request.url?.startsWith('/oauth2callback')) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }

        try {
            const callbackUrl = new URL(request.url, REDIRECT_URI);
            const oauthError = callbackUrl.searchParams.get('error');
            if (oauthError) throw new Error(`Google authorization failed: ${oauthError}`);
            if (callbackUrl.searchParams.get('state') !== oauthState) throw new Error('Google authorization state did not match. Please restart authorization.');
            const code = callbackUrl.searchParams.get('code');
            if (!code) throw new Error('The Google callback did not contain an authorization code.');
            const { tokens } = await oauth2Client.getToken({ code, codeVerifier });
            if (!tokens.refresh_token) throw new Error('Google did not return an offline refresh token. Re-run with consent.');
            fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
            fs.writeFileSync(TOKEN_PATH, JSON.stringify({ client_id: clientId, client_secret: clientSecret, tokens }, null, 2), { encoding: 'utf8', mode: 0o600 });
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end('<h1>Budget receipt access connected</h1><p>You may close this tab. Only Gmail receipt/payment searches are performed by the local agent.</p>');
            console.log(`Budget Gmail token saved to ${TOKEN_PATH}`);
            server.close(() => process.exit(0));
        } catch (error) {
            console.error(error);
            response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(`<h1>Authorization failed</h1><p>${String(error.message || error).replace(/[<>&]/g, '')}</p>`);
            server.close(() => process.exit(1));
        }
    });

    server.listen(PORT, '127.0.0.1', () => {
        console.log('Google Gmail receipt authorization');
        console.log(`Callback listening at ${REDIRECT_URI}`);
        console.log('Open this URL on this Windows computer:');
        console.log(authUrl);
    });
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
