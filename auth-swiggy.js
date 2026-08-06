const path = require('node:path');
require('dotenv').config();
const {
    authorizeSwiggy,
    getDefaultSwiggyAuthDirectory
} = require('./swiggy-orders');

async function main() {
    const requestedDirectory = process.argv[2] || process.env.SWIGGY_MCP_AUTH_DIR || getDefaultSwiggyAuthDirectory();
    const authDirectory = path.resolve(requestedDirectory);

    console.log('Starting one-time Swiggy authorization for Instamart and Food...');
    console.log('Complete the phone/OTP flow in the browser window when prompted.');
    const result = await authorizeSwiggy({ authDirectory });

    for (const [provider, status] of Object.entries(result.results)) {
        const label = provider === 'swiggy_instamart' ? 'Swiggy Instamart' : 'Swiggy Food';
        if (!status.authorized) {
            console.error(`${label}: authorization failed (${status.failure}).`);
        } else if (status.missingRequiredTools?.length) {
            console.error(`${label}: connected, but required read-only tool(s) were unavailable: ${status.missingRequiredTools.join(', ')}.`);
        } else if (status.missingOptionalTools?.length) {
            console.log(`${label}: authorized. Optional tool(s) not exposed by Swiggy: ${status.missingOptionalTools.join(', ')}; available order-list data will be used.`);
        } else {
            console.log(`${label}: authorized and read-only order tools are available.`);
        }
    }

    if (!result.complete) {
        process.exitCode = 1;
        console.error('Swiggy authorization is incomplete. Run this command again to retry.');
        return;
    }
    console.log('Swiggy authorization is complete. The regular agent can now sync in the background.');
}

if (require.main === module) {
    main().catch(() => {
        process.exitCode = 1;
        console.error('Swiggy authorization failed before it could complete.');
    });
}

module.exports = { main };
