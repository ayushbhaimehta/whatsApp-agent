const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const fs = require('fs');
require('dotenv').config();

// --- Initialization & State Management ---

// 1. Startup Guard: Ignore old sync messages
const SCRIPT_START_TIME = Math.floor(Date.now() / 1000);

// 2. Message Cache: Prevent duplicate processing (Max 200 items to save RAM)
const processedMessageIds = new Set();

// 3. Gemini Setup (v2.5 Flash with strict JSON mode)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
        responseMimeType: "application/json",
    }
});

// 4. WhatsApp Setup (Using Brave Browser)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: false, // Change to true once everything is running perfectly
        executablePath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// 5. Google API Setup
const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/tasks'
    ],
});

// 6. Google Tasks OAuth 2.0 Setup
const tokenPath = './google-tasks-token.json';
let oauth2Client = null;

if (fs.existsSync(tokenPath)) {
    try {
        const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
        oauth2Client = new google.auth.OAuth2(
            tokenData.client_id,
            tokenData.client_secret
        );
        oauth2Client.setCredentials(tokenData.tokens);

        // Auto-save refreshed tokens back to disk
        oauth2Client.on('tokens', (tokens) => {
            try {
                const currentData = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
                currentData.tokens = { ...currentData.tokens, ...tokens };
                fs.writeFileSync(tokenPath, JSON.stringify(currentData, null, 2), 'utf-8');
                console.log("🔄 Google Tasks OAuth 2.0 access token auto-refreshed and saved.");
            } catch (saveError) {
                console.error("❌ Failed to auto-save refreshed Google Tasks tokens:", saveError);
            }
        });
        console.log("🔑 Google Tasks OAuth 2.0 client loaded successfully!");
    } catch (err) {
        console.error("❌ Error loading Google Tasks token file:", err);
    }
} else {
    console.warn("⚠️  WARNING: 'google-tasks-token.json' not found! Google Tasks will not be available.");
    console.warn("👉 Please run 'node auth-tasks.js' to authorize Google Tasks access.");
}

// --- WhatsApp Events ---

client.on('qr', (qr) => {
    console.log('⚠️  QR CODE RECEIVED. SCAN IT WITH WHATSAPP:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('🚀 Agent is online! Watching for NEW messages only...');
});

client.on('message_create', async (msg) => {
    // --- GUARD 0: Prevent Duplicate Processing ---
    if (processedMessageIds.has(msg.id._serialized)) return;

    const cookChatId = process.env.COOK_CHAT_ID;

    // --- GUARD 1 & 2: Time and Target Chat ---
    if (msg.timestamp < SCRIPT_START_TIME) return;
    const isTargetChat = (msg.from === cookChatId) || (msg.to === cookChatId);
    if (!isTargetChat) return;

    // Mark as processed & manage cache size
    processedMessageIds.add(msg.id._serialized);
    if (processedMessageIds.size > 200) {
        const oldestId = processedMessageIds.values().next().value;
        processedMessageIds.delete(oldestId);
    }

    console.log(`-------------------------------------------`);
    console.log(`📩 NEW Message Captured [${new Date(msg.timestamp * 1000).toLocaleTimeString()}]`);
    console.log(`Direction: ${msg.fromMe ? 'Outgoing (You)' : 'Incoming (Cook)'}`);
    console.log(`-------------------------------------------`);

    try {
        let inputData;
        let mimeType = "text/plain";

        // Handle Audio/Voice Notes
        if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')) {
            console.log("🎙️  Voice note detected. Downloading...");
            const media = await msg.downloadMedia();
            inputData = media.data;
            mimeType = media.mimetype;
        } else {
            // Handle Text
            inputData = msg.body;
            if (!inputData || inputData.trim() === "") return;
            console.log(`📝 Text received: "${inputData}"`);
        }

        // Process with Gemini
        const result = await processWithGemini(inputData, mimeType);

        // Target ID for Private DMs (Your own number)
        const myPrivateChatId = client.info.wid._serialized;

        // Execute Action: LOG FOOD
        if (result.intent === 'log_food' && result.items && result.items.length > 0) {
            const sheetRows = [];
            let summaryMessage = `✅ *Meals Logged*\n\n`;

            for (const food of result.items) {
                // Smart Meal Routing: Use LLM's text extraction, fallback to IST time if missing
                const finalMealType = (food.meal_type && food.meal_type !== "Unknown")
                    ? food.meal_type
                    : getMealType();

                // Prepare row for Google Sheets
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

                // Append to WhatsApp summary sent to your DM
                summaryMessage += `*[${finalMealType}]* 🍲 ${food.item} (${food.quantity})\n`;
                summaryMessage += `📊 ${food.protein}g P | ${food.fiber}g F | ${food.calories} kcal\n\n`;
            }

            await logToSheets(sheetRows);
            await client.sendMessage(myPrivateChatId, summaryMessage.trim()); // Private DM
        }
        // Execute Action: ADD REMINDER
        else if (result.intent === 'add_reminder' && result.items && result.items.length > 0) {
            let reminderMessage = `🛒 *Added to Shopping List:*\n`;

            for (const req of result.items) {
                await addToGoogleTasks(req.item);
                reminderMessage += `- ${req.item}\n`;
            }

            await client.sendMessage(myPrivateChatId, reminderMessage); // Private DM
        }

    } catch (error) {
        console.error("❌ Error processing message:", error);
    }
});

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
        You are a nutritional assistant. The input is either text or a Hindi/English voice note.
        Transcribe the audio if necessary.
        Analyze the intent:
        - If the user instructs to cook something, intent is 'log_food'.
        - If someone says we need to buy/bring something, intent is 'add_reminder'.
        
        If 'log_food':
        1. Extract EACH distinct food item (in English) and its quantity separately.
        2. Determine the specific meal for EACH item if mentioned (e.g., Breakfast, Lunch, Dinner, Snack). If not explicitly mentioned, output "Unknown".
        3. Provide a realistic nutritional estimate for EACH distinct item.
        
        Return a JSON object with this exact structure:
        {
            "intent": "log_food" | "add_reminder" | "none",
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
        
        If 'add_reminder', set the nutritional numbers to 0 and meal_type to "Unknown".
    `;

    const contents = mimeType === "text/plain"
        ? [prompt, input]
        : [{ inlineData: { data: input, mimeType } }, prompt];

    const response = await model.generateContent(contents);
    const text = response.response.text();

    try {
        return JSON.parse(text.trim());
    } catch (parseError) {
        console.error("❌ JSON Parse Failed. Raw Response:", text);
        return { intent: 'none', items: [] };
    }
}

async function logToSheets(rows) {
    const sheets = google.sheets({ version: 'v4', auth });
    const range = 'Sheet1!A:H';

    await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range,
        valueInputOption: 'USER_ENTERED',
        resource: { values: rows },
    });
    console.log(`📊 Successfully logged ${rows.length} items to Google Sheets.`);
}

async function addToGoogleTasks(item) {
    if (!oauth2Client) {
        console.warn(`⚠️ Google Tasks is not configured. Could not add "${item}". Please run 'node auth-tasks.js'.`);
        return;
    }
    const tasks = google.tasks({ version: 'v1', auth: oauth2Client });
    await tasks.tasks.insert({
        tasklist: '@default',
        requestBody: {
            title: `Buy ${item}`,
            notes: 'Added via WhatsApp Cook Agent'
        },
    });
    console.log(`📝 Successfully added ${item} to Google Tasks.`);
}

client.initialize();