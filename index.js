const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const fs = require('fs');
require('dotenv').config();

// --- Initialization & State Management ---

// 1. Startup Guard & Chat Identification (initialized to current time, populated on ready)
let clientReadyTime = Math.floor(Date.now() / 1000);
let myPrivateChatId = null;

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
// Plain text model for conversational and formatted responses (such as meal suggestions)
const textModel = genAI.getGenerativeModel({
    model: "gemini-2.5-flash"
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
    clientReadyTime = Math.floor(Date.now() / 1000);
    myPrivateChatId = client.info?.wid?._serialized;
    console.log('🚀 Agent is online! Watching for NEW messages only...');
    console.log('🔑 Established private DM JID:', myPrivateChatId);
});

client.on('message_create', async (msg) => {
    // --- GUARD: Ignore bot's own generated responses to avoid loops ---
    const body = msg.body || "";
    if (body.startsWith("✨ *Personalized Meal Suggestions*") || 
        body.startsWith("✅ *Meals Logged*") || 
        body.startsWith("🛒 *Added to Shopping List*") ||
        body.startsWith("📊 *Daily Summary*")) {
        return;
    }

    // --- GUARD 0: Prevent Duplicate Processing ---
    if (processedMessageIds.has(msg.id._serialized)) return;

    const cookChatId = process.env.COOK_CHAT_ID;
    const personalChatId = process.env.PERSONAL_CHAT_ID || client.info?.wid?._serialized;

    // --- GUARD 1 & 2: Time and Target Chat ---
    if (msg.timestamp < clientReadyTime - 10) return;

    // JID suffix-agnostic checking using jidsMatch
    const isCookChat = jidsMatch(msg.from, cookChatId) || jidsMatch(msg.to, cookChatId);
    const isPrivateChat = personalChatId && (jidsMatch(msg.from, personalChatId) || jidsMatch(msg.to, personalChatId));

    // Log ignored chats
    if (!isCookChat && !isPrivateChat) {
        return; // Ignore silently
    }

    // Mark as processed & manage cache size
    processedMessageIds.add(msg.id._serialized);
    if (processedMessageIds.size > 200) {
        const oldestId = processedMessageIds.values().next().value;
        processedMessageIds.delete(oldestId);
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
            const media = await msg.downloadMedia();
            inputData = media.data;
            mimeType = media.mimetype;
            console.log("✅ Voice note download completed successfully!");
        } else {
            // Handle Text
            inputData = msg.body;
            if (!inputData || inputData.trim() === "") return;
            console.log(`📝 Text message read: "${inputData}"`);
        }

        console.log("🤖 Processing intent with Gemini...");
        const result = await processWithGemini(inputData, mimeType);
        console.log(`🔍 Gemini intent resolved: intent="${result.intent}"`);

        // Target ID for Private DMs (Your own number)
        const myPrivateChatId = client.info?.wid?._serialized;

        // Execute Action: LOG FOOD
        if (result.intent === 'log_food' && result.items && result.items.length > 0) {
            if (!isCookChat) {
                console.log("⏭️ Ignoring log_food: Feature restricted to Cook's chat.");
                return;
            }

            console.log("📊 Logging food items to Google Sheets...");
            const sheetRows = [];
            let summaryMessage = `✅ *Meals Logged*\n\n`;

            for (const food of result.items) {
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

            if (myPrivateChatId) {
                console.log("📨 Sending log summary confirmation to private DM...");
                await client.sendMessage(myPrivateChatId, summaryMessage.trim());
            }
        }
        // Execute Action: ADD REMINDER
        else if (result.intent === 'add_reminder' && result.items && result.items.length > 0) {
            if (!isCookChat) {
                console.log("⏭️ Ignoring add_reminder: Feature restricted to Cook's chat.");
                return;
            }

            console.log("🛒 Creating Google Task for shopping list...");
            let reminderMessage = `🛒 *Added to Shopping List:*\n`;

            for (const req of result.items) {
                await addToGoogleTasks(req.item);
                console.log(`✅ Google Task created for: "${req.item}"`);
                reminderMessage += `- ${req.item}\n`;
            }

            if (myPrivateChatId) {
                console.log("📨 Sending shopping list confirmation to private DM...");
                await client.sendMessage(myPrivateChatId, reminderMessage);
            }
        }
        // Execute Action: SUGGEST MEAL
        else if (result.intent === 'suggest_meal') {
            if (!isPrivateChat) {
                console.log("⏭️ Ignoring suggest_meal: Feature restricted to Private Self-Chat.");
                return;
            }

            console.log("🥗 Generating vegetarian meal suggestions...");
            const targetMeal = (result.meal_type && result.meal_type !== "Unknown")
                ? result.meal_type
                : getMealType();

            console.log(`Target meal for suggestions: ${targetMeal}`);

            const dailyLogs = await getDailyLogs();
            const overallGoal = await getUserGoal();
            const suggestions = await generateSuggestions(targetMeal, dailyLogs, overallGoal);
            const finalSuggestionsText = `✨ *Personalized Meal Suggestions*\n\n` + suggestions;

            console.log("✅ Suggestions generated successfully!");
            console.log("📨 Replying to user's private message with meal suggestions...");
            await msg.reply(finalSuggestionsText);
        }
        // Execute Action: SUMMARIZE DAY
        else if (result.intent === 'summarize_day') {
            if (!isPrivateChat) {
                console.log("⏭️ Ignoring summarize_day: Feature restricted to Private Self-Chat.");
                return;
            }

            console.log("📊 Generating daily macro summary...");
            const dailyLogs = await getDailyLogs();
            const overallGoal = await getUserGoal();
            const summary = await generateDailySummary(dailyLogs, overallGoal);
            const finalSummaryText = `📊 *Daily Summary*\n\n` + summary;

            console.log("✅ Daily summary generated successfully!");
            console.log("📨 Replying to user's private message with daily summary...");
            await msg.reply(finalSummaryText);
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
        - If the user instructs to cook or eat something, or is logging consumed food, intent is 'log_food'.
        - If someone says we need to buy, bring, or get something, or instructs to buy/bring/purchase/get something (e.g. "buy milk", "dudh le aana", "vegetables kharidna", "eggs lana hai", "get some onions"), intent is 'add_reminder'.
        - If the user asks for suggestions, recommendations, or options of what to eat or cook (e.g., "suggest", "suggest dinner", "what should I eat", "recommend some breakfast options", "vegetarians option suggest"), intent is 'suggest_meal'.
        - If the user asks to summarize what they ate today, requests a daily report, or asks for macro totals (e.g., "summarize for the day", "summarize", "daily summary", "what did I eat today"), intent is 'summarize_day'.
        
        If 'log_food' or 'add_reminder':
        1. Extract EACH distinct food/grocery item (in English) and its quantity separately.
        2. For 'log_food', determine the specific meal for EACH item if mentioned (e.g., Breakfast, Lunch, Dinner, Snack). If not explicitly mentioned, output "Unknown". For 'add_reminder', set meal_type to "Unknown".
        3. For 'log_food', provide a realistic nutritional estimate for EACH distinct item. For 'add_reminder', set the nutritional numbers (calories, protein, carbs, fat, fiber) to 0.
        
        Return a JSON object with this exact structure:
        {
            "intent": "log_food" | "add_reminder" | "suggest_meal" | "summarize_day" | "none",
            "meal_type": "string", // ONLY for 'suggest_meal'. Specify the meal type they asked for (e.g., "Breakfast", "Lunch", "Dinner", "Snack"). If not specified or clear, output "Unknown".
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
        
        If 'suggest_meal' or 'summarize_day', set "items" to an empty array.
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
    try {
        const tasks = google.tasks({ version: 'v1', auth: oauth2Client });
        await tasks.tasks.insert({
            tasklist: '@default',
            requestBody: {
                title: `Buy ${item}`,
                notes: 'Added via WhatsApp Cook Agent'
            },
        });
        console.log(`📝 Successfully added ${item} to Google Tasks.`);
    } catch (taskError) {
        console.error(`❌ Failed to add "${item}" to Google Tasks:`, taskError.message || taskError);
    }
}

// --- Vegetarian Suggestion Helpers ---

async function getDailyLogs() {
    try {
        const sheets = google.sheets({ version: 'v4', auth });
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
        const sheets = google.sheets({ version: 'v4', auth });
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
        const response = await textModel.generateContent([prompt]);
        return response.response.text().trim();
    } catch (error) {
        console.error("❌ Failed to generate suggestions with Gemini:", error);
        return `⚠️ Sorry, I encountered an issue generating food suggestions for you. Please try again!`;
    }
}

function jidsMatch(jid1, jid2) {
    if (!jid1 || !jid2) return false;
    return jid1.split('@')[0] === jid2.split('@')[0];
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
        const response = await textModel.generateContent([prompt]);
        return response.response.text().trim();
    } catch (error) {
        console.error("❌ Failed to generate daily summary with Gemini:", error);
        return `⚠️ Sorry, I encountered an issue generating your daily summary. Please try again!`;
    }
}

client.initialize();