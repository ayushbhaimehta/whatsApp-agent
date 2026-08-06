const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { resolveRuntimePath } = require('./runtime-paths');
require('dotenv').config();

const PORT = Number(process.env.GOOGLE_TASKS_OAUTH_PORT || 3000);
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const TOKEN_PATH = resolveRuntimePath({
    envKey: 'GOOGLE_TASKS_TOKEN_PATH',
    relativeSegments: ['secrets', 'google-tasks-token.json'],
    legacyPath: path.join(__dirname, 'google-tasks-token.json')
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

async function main() {
    console.log('\n====================================================');
    console.log('🔑  Google Tasks OAuth 2.0 Authorization Setup');
    console.log('====================================================\n');

    let clientId = process.env.GOOGLE_CLIENT_ID;
    let clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    // Load existing config if available
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            const existing = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
            clientId = clientId || existing.client_id;
            clientSecret = clientSecret || existing.client_secret;
            console.log('ℹ️  Found existing token file configuration.');
        } catch (e) {
            // Ignore parse errors
        }
    }

    if (!clientId) {
        clientId = await askQuestion('👉 Enter your Google OAuth 2.0 Client ID: ');
        clientId = clientId.trim();
    } else {
        console.log(`✅ Using Client ID: ${clientId.substring(0, 15)}...`);
    }

    if (!clientSecret) {
        clientSecret = await askQuestion('👉 Enter your Google OAuth 2.0 Client Secret: ');
        clientSecret = clientSecret.trim();
    } else {
        console.log(`✅ Using Client Secret: ********`);
    }

    if (!clientId || !clientSecret) {
        console.error('❌ Error: Both Client ID and Client Secret are required!');
        rl.close();
        process.exit(1);
    }

    // Initialize OAuth2 client
    const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        REDIRECT_URI
    );

    // Bind the browser response to this one authorization attempt and use
    // PKCE so an intercepted authorization code cannot be exchanged elsewhere.
    const oauthState = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(64).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    // Generate authorization URL
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Critical: gets refresh_token
        prompt: 'consent',       // Force consent to ensure we always get refresh_token
        state: oauthState,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        scope: ['https://www.googleapis.com/auth/tasks']
    });

    // Start local server to capture redirect
    const server = http.createServer(async (req, res) => {
        try {
            if (req.url.startsWith('/oauth2callback')) {
                const q = url.parse(req.url, true).query;
                if (q.state !== oauthState) {
                    throw new Error('Google authorization state did not match. Please restart authorization.');
                }
                if (q.error) {
                    console.error(`\n❌ Authorization failed: ${q.error}`);
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end('<h1>Authorization Failed!</h1><p>' + q.error + '</p>');
                    server.close();
                    rl.close();
                    process.exit(1);
                }

                if (q.code) {
                    console.log('\n📥 Authorization code received. Exchanging code for tokens...');
                    const { tokens } = await oauth2Client.getToken({ code: q.code, codeVerifier });
                    
                    const tokenData = {
                        client_id: clientId,
                        client_secret: clientSecret,
                        tokens: tokens
                    };

                    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
                    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2), { encoding: 'utf8', mode: 0o600 });
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<h1>Google Tasks connected</h1><p>You can close this tab. The WhatsApp agent will load the new token automatically.</p>');
                    console.log(`\n🎉 Success! Credentials & tokens saved to ${TOKEN_PATH}`);
                    console.log('✅ Google Tasks is now fully configured.\n');
                    
                    server.close();
                    rl.close();
                    process.exit(0);
                }
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            }
        } catch (err) {
            console.error('❌ Error processing request:', err);
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>Google Tasks authorization failed</h1><p>Return to the agent console for details.</p>');
            server.close();
            rl.close();
            process.exitCode = 1;
        }
    });

    // Keep the temporary OAuth callback private. Cloud authorization reaches
    // this loopback socket through an explicit SSH tunnel.
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`\n⚡ Temporary server listening on http://localhost:${PORT}`);
        console.log('\n🔗 Please open the following URL in your web browser to authorize the app:');
        console.log('----------------------------------------------------------------------');
        console.log(authUrl);
        console.log('----------------------------------------------------------------------\n');
        console.log('⌛ Waiting for authorization in browser...');
    });
}

main().catch(err => {
    console.error('❌ Unexpected error:', err);
    rl.close();
    process.exit(1);
});
