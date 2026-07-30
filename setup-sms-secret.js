const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config();

const privateRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'WhatsAppFoodAgent')
    : path.join(os.homedir(), '.whatsapp-food-agent');
const secretPath = process.env.SMS_INGESTION_SECRET_FILE || path.join(privateRoot, 'secrets', 'sms-ingestion-secret.txt');

fs.mkdirSync(path.dirname(secretPath), { recursive: true });
if (!fs.existsSync(secretPath)) {
    const file = fs.openSync(secretPath, 'wx', 0o600);
    try {
        fs.writeFileSync(file, `${crypto.randomBytes(32).toString('hex')}\n`, 'utf8');
    } finally {
        fs.closeSync(file);
    }
}

const secret = fs.readFileSync(secretPath, 'utf8').trim();
if (secret.length < 32) throw new Error(`The secret stored at ${secretPath} is too short.`);
console.log(`SMS ingestion secret path: ${secretPath}`);
console.log('Enter this value once in the Android companion:');
console.log(secret);
