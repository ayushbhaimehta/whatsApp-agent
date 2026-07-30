const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const SWIGGY_ENDPOINTS = Object.freeze({
    swiggy_instamart: 'https://mcp.swiggy.com/im',
    swiggy_food: 'https://mcp.swiggy.com/food'
});

const SWIGGY_TOOL_ALLOWLIST = Object.freeze({
    swiggy_instamart: Object.freeze(['get_orders', 'get_order_details']),
    swiggy_food: Object.freeze(['get_addresses', 'get_food_orders', 'get_food_order_details'])
});
const SWIGGY_REQUIRED_TOOLS = Object.freeze({
    // The live Instamart endpoint currently omits get_order_details even though
    // its reference page documents it. get_orders itself includes basic items.
    swiggy_instamart: Object.freeze(['get_orders']),
    swiggy_food: Object.freeze(['get_addresses', 'get_food_orders', 'get_food_order_details'])
});

const PROVIDERS = Object.freeze(Object.keys(SWIGGY_ENDPOINTS));
const CACHE_VERSION = 1;
const MCP_REMOTE_VERSION = require('mcp-remote/package.json').version;
const MAX_ORDERS_PER_PROVIDER = 60;
const MAX_ITEMS_PER_ORDER = 200;
const MAX_ADDRESSES = 12;
const CACHE_RETENTION_DAYS = 90;
// Swiggy currently documents a five-day access-token lifetime without refresh
// tokens. Stop before that boundary so a background `npm start` never initiates
// an interactive OAuth browser flow on an ordinary expiry.
const RUNTIME_AUTH_MAX_AGE_MS = 114 * 60 * 60 * 1000;

function getDefaultSwiggyAuthDirectory() {
    const localData = process.env.LOCALAPPDATA || os.homedir();
    return path.join(localData, 'WhatsAppFoodAgent', 'secrets', 'swiggy-mcp-auth');
}

function resolveProvider(providerOrEndpoint) {
    if (PROVIDERS.includes(providerOrEndpoint)) return providerOrEndpoint;
    return PROVIDERS.find((provider) => SWIGGY_ENDPOINTS[provider] === providerOrEndpoint) || null;
}

function authStatePaths(authDirectory, provider) {
    const endpoint = SWIGGY_ENDPOINTS[provider];
    const endpointHash = crypto.createHash('md5').update(endpoint).digest('hex');
    const versionDirectory = path.join(authDirectory, `mcp-remote-${MCP_REMOTE_VERSION}`);
    return {
        tokens: path.join(versionDirectory, `${endpointHash}_tokens.json`),
        client: path.join(versionDirectory, `${endpointHash}_client_info.json`)
    };
}

function hasUsableJsonFile(filePath, requiredField, maximumAgeMs = null) {
    try {
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!value || typeof value !== 'object' || typeof value[requiredField] !== 'string' || !value[requiredField]) return false;
        if (maximumAgeMs != null && Date.now() - fs.statSync(filePath).mtimeMs > maximumAgeMs) return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * Returns true only when mcp-remote has stored both client registration and an
 * access token. With no provider argument, both Swiggy services must be ready.
 */
function hasSwiggyAuthState(authDirectory = getDefaultSwiggyAuthDirectory(), providerOrEndpoint = null) {
    const requestedProvider = providerOrEndpoint ? resolveProvider(providerOrEndpoint) : null;
    if (providerOrEndpoint && !requestedProvider) return false;
    const providers = requestedProvider ? [requestedProvider] : PROVIDERS;
    return providers.every((provider) => {
        const files = authStatePaths(path.resolve(authDirectory), provider);
        return hasUsableJsonFile(files.tokens, 'access_token', RUNTIME_AUTH_MAX_AGE_MS) && hasUsableJsonFile(files.client, 'client_id');
    });
}

function assertAllowedSwiggyTool(provider, toolName) {
    const allowed = SWIGGY_TOOL_ALLOWLIST[provider];
    if (!allowed || !allowed.includes(toolName)) {
        const error = new Error(`Swiggy MCP tool is not allowed for ${provider || 'unknown provider'}.`);
        error.code = 'SWIGGY_TOOL_NOT_ALLOWED';
        throw error;
    }
}

function timeoutAfter(milliseconds, label) {
    let timer;
    const promise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`${label} timed out.`);
            error.code = 'SWIGGY_MCP_TIMEOUT';
            reject(error);
        }, milliseconds);
        timer.unref?.();
    });
    return { promise, cancel: () => clearTimeout(timer) };
}

async function withTimeout(operation, milliseconds, label) {
    const timeout = timeoutAfter(milliseconds, label);
    try {
        return await Promise.race([operation, timeout.promise]);
    } finally {
        timeout.cancel();
    }
}

async function createSwiggyMcpClient(provider, options = {}) {
    if (!PROVIDERS.includes(provider)) {
        throw new TypeError(`Unsupported Swiggy provider: ${provider}`);
    }

    const authDirectory = path.resolve(options.authDirectory || getDefaultSwiggyAuthDirectory());
    const allowInteractiveAuth = options.allowInteractiveAuth === true;
    if (!allowInteractiveAuth && !hasSwiggyAuthState(authDirectory, provider)) {
        const error = new Error(`Swiggy ${provider === 'swiggy_food' ? 'Food' : 'Instamart'} authorization is required.`);
        error.code = 'SWIGGY_REAUTH_REQUIRED';
        throw error;
    }

    const proxyPath = require.resolve('mcp-remote/dist/proxy.js');
    const args = [proxyPath, SWIGGY_ENDPOINTS[provider], '--transport', 'http-first'];
    if (allowInteractiveAuth) args.push('--auth-timeout', '240');

    let intentionallyClosing = false;
    const transport = new StdioClientTransport({
        command: process.execPath,
        args,
        env: {
            ...process.env,
            MCP_REMOTE_CONFIG_DIR: authDirectory
        },
        // Keep stderr piped so expected AbortError noise can be suppressed when
        // the short-lived authorization connection is intentionally closed.
        stderr: 'pipe'
    });
    if (allowInteractiveAuth) {
        transport.stderr?.on('data', chunk => {
            if (!intentionallyClosing) process.stderr.write(chunk);
        });
    }
    const client = new Client(
        { name: 'whatsapp-food-agent-swiggy', version: '1.0.0' },
        { capabilities: {} }
    );
    // Drain non-interactive proxy diagnostics without printing OAuth material.
    transport.stderr?.resume?.();

    try {
        await withTimeout(
            client.connect(transport),
            allowInteractiveAuth ? 300_000 : 30_000,
            'Swiggy MCP connection'
        );
    } catch (error) {
        await transport.close().catch(() => {});
        throw error;
    }

    return {
        provider,
        async listTools() {
            return client.listTools(undefined, { timeout: 30_000 });
        },
        async callTool(request) {
            assertAllowedSwiggyTool(provider, request?.name);
            return client.callTool(request, undefined, { timeout: 30_000 });
        },
        async close() {
            intentionallyClosing = true;
            await client.close().catch(() => transport.close().catch(() => {}));
        }
    };
}

function makeCacheKey(cacheSecret) {
    if ((!Buffer.isBuffer(cacheSecret) && typeof cacheSecret !== 'string') || cacheSecret.length === 0) {
        throw new TypeError('A non-empty cacheSecret is required for the Swiggy order cache.');
    }
    return crypto.createHash('sha256')
        .update('whatsapp-food-agent:swiggy-order-cache:aes-256-gcm:v1\0', 'utf8')
        .update(cacheSecret)
        .digest();
}

function encryptCachePayload(payload, cacheSecret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', makeCacheKey(cacheSecret), iv);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
        version: CACHE_VERSION,
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64')
    };
}

function decryptCacheEnvelope(envelope, cacheSecret) {
    if (!envelope || envelope.version !== CACHE_VERSION || envelope.algorithm !== 'aes-256-gcm') {
        throw new Error('Unsupported Swiggy cache format.');
    }
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        makeCacheKey(cacheSecret),
        Buffer.from(envelope.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final()
    ]);
    return JSON.parse(plaintext.toString('utf8'));
}

function orderIdHash(orderId) {
    return crypto.createHash('sha256').update(String(orderId).trim().toUpperCase()).digest('hex').slice(0, 24);
}

function sanitizeLabel(value, maximumLength = 160) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted]')
        .replace(/\b[\w.+-]+@[a-z][a-z0-9.-]{1,30}\b/gi, '[redacted]')
        .replace(/(?:\+?91[-\s]?)?[6-9]\d{9}\b/g, '[redacted]')
        .replace(/\b\d{12,19}\b/g, '[redacted]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maximumLength);
}

function cleanInteger(value, fallback = 0) {
    const number = typeof value === 'number' ? value : Number.parseFloat(String(value || '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback;
}

function publicOrder(order) {
    return {
        provider: PROVIDERS.includes(order?.provider) ? order.provider : 'swiggy_food',
        orderIdHash: /^[a-f0-9]{16,64}$/i.test(String(order?.orderIdHash || ''))
            ? String(order.orderIdHash).toLowerCase()
            : '',
        occurredAt: normalizeDate(order?.occurredAt),
        status: sanitizeLabel(order?.status || 'COMPLETED', 40),
        merchant: sanitizeLabel(order?.merchant || defaultMerchant(order?.provider)),
        payablePaise: cleanInteger(order?.payablePaise),
        refundPaise: cleanInteger(order?.refundPaise),
        items: normalizeCachedItems(order?.items),
        fees: normalizeCachedFees(order?.fees),
        fetchedAt: normalizeDate(order?.fetchedAt)
    };
}

function normalizePrivateCacheOrder(order) {
    if (!order || !PROVIDERS.includes(order.provider)) return null;
    const rawOrderId = typeof order.orderId === 'string' || typeof order.orderId === 'number'
        ? String(order.orderId).slice(0, 200)
        : '';
    const hash = /^[a-f0-9]{16,64}$/i.test(String(order.orderIdHash || ''))
        ? String(order.orderIdHash).toLowerCase()
        : (rawOrderId ? orderIdHash(rawOrderId) : '');
    const occurredAt = normalizeDate(order.occurredAt);
    const fetchedAt = normalizeDate(order.fetchedAt) || new Date().toISOString();
    if (!hash || !occurredAt) return null;
    return {
        provider: order.provider,
        ...(rawOrderId ? { orderId: rawOrderId } : {}),
        orderIdHash: hash,
        occurredAt,
        status: sanitizeLabel(order.status || 'COMPLETED', 40),
        merchant: sanitizeLabel(order.merchant || defaultMerchant(order.provider)),
        payablePaise: cleanInteger(order.payablePaise),
        refundPaise: cleanInteger(order.refundPaise),
        items: normalizeCachedItems(order.items),
        fees: normalizeCachedFees(order.fees),
        fetchedAt
    };
}

function normalizeCachedItems(items) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, MAX_ITEMS_PER_ORDER).map((item) => {
        const name = sanitizeLabel(item?.name);
        if (!name) return null;
        return {
            name,
            quantity: Math.max(0, Number(item.quantity) || 1),
            lineAmountPaise: cleanInteger(item.lineAmountPaise)
        };
    }).filter(Boolean);
}

function normalizeCachedFees(fees) {
    if (!Array.isArray(fees)) return [];
    return fees.slice(0, 30).map((fee) => {
        const name = sanitizeLabel(fee?.name, 80);
        if (!name) return null;
        return { name, amountPaise: cleanInteger(fee.amountPaise) };
    }).filter(Boolean);
}

async function readPrivateSwiggyOrderCache(cachePath, cacheSecret) {
    try {
        const envelope = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
        const payload = decryptCacheEnvelope(envelope, cacheSecret);
        if (!payload || !Array.isArray(payload.orders)) throw new Error('Invalid Swiggy cache payload.');
        return payload.orders.map(normalizePrivateCacheOrder).filter(Boolean);
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        const wrapped = new Error('Could not decrypt the Swiggy order cache.');
        wrapped.code = 'SWIGGY_CACHE_READ_FAILED';
        wrapped.cause = error;
        throw wrapped;
    }
}

/** Loads decrypted records but deliberately omits raw Swiggy order identifiers. */
async function loadSwiggyOrderCache(cachePath, cacheSecret) {
    return (await readPrivateSwiggyOrderCache(cachePath, cacheSecret)).map(publicOrder);
}

async function writePrivateSwiggyOrderCache(cachePath, cacheSecret, orders, now) {
    const absolutePath = path.resolve(cachePath);
    await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
    const envelope = encryptCachePayload({
        version: CACHE_VERSION,
        savedAt: new Date(now).toISOString(),
        orders
    }, cacheSecret);
    const temporaryPath = `${absolutePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        await fsp.writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fsp.rename(temporaryPath, absolutePath);
    } catch (error) {
        await fsp.unlink(temporaryPath).catch(() => {});
        throw error;
    }
}

function normalizeDate(value) {
    if (value === null || value === undefined || value === '') return null;
    let timestamp;
    if (typeof value === 'number') {
        timestamp = value < 10_000_000_000 ? value * 1000 : value;
    } else if (/^\d{10,13}$/.test(String(value).trim())) {
        const number = Number(value);
        timestamp = String(value).trim().length === 10 ? number * 1000 : number;
    } else {
        timestamp = Date.parse(String(value));
    }
    if (!Number.isFinite(timestamp)) return null;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizedKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findNamedValue(root, names, maximumDepth = 4) {
    const wanted = new Set(names.map(normalizedKey));
    const queue = [{ value: root, depth: 0 }];
    const visited = new Set();
    while (queue.length) {
        const { value, depth } = queue.shift();
        if (!value || typeof value !== 'object' || visited.has(value)) continue;
        visited.add(value);
        for (const [key, child] of Object.entries(value)) {
            if (wanted.has(normalizedKey(key)) && child !== null && child !== undefined && child !== '') return { value: child, key };
        }
        if (depth < maximumDepth) {
            for (const child of Object.values(value)) {
                if (child && typeof child === 'object' && !Array.isArray(child)) queue.push({ value: child, depth: depth + 1 });
            }
        }
    }
    return null;
}

function findNamedArrays(root, names, maximumDepth = 6) {
    const wanted = new Set(names.map(normalizedKey));
    const found = [];
    const queue = [{ value: root, depth: 0 }];
    const visited = new Set();
    while (queue.length && visited.size < 800) {
        const { value, depth } = queue.shift();
        if (!value || typeof value !== 'object' || visited.has(value)) continue;
        visited.add(value);
        if (Array.isArray(value)) {
            if (depth === 0) found.push(value);
            if (depth < maximumDepth) value.forEach((child) => queue.push({ value: child, depth: depth + 1 }));
            continue;
        }
        for (const [key, child] of Object.entries(value)) {
            if (Array.isArray(child) && wanted.has(normalizedKey(key))) found.push(child);
            if (depth < maximumDepth && child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
        }
    }
    return found;
}

function parseJsonText(text) {
    if (typeof text !== 'string' || text.length > 2_000_000) return null;
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
        return JSON.parse(trimmed);
    } catch {
        const starts = [trimmed.indexOf('{'), trimmed.indexOf('[')].filter((index) => index >= 0).sort((a, b) => a - b);
        if (!starts.length) return null;
        const start = starts[0];
        const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
        if (end <= start) return null;
        try {
            return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
            return null;
        }
    }
}

function parseMcpResult(result) {
    if (!result || result.isError) {
        const error = new Error('Swiggy MCP tool returned an error.');
        error.code = 'SWIGGY_MCP_TOOL_FAILED';
        throw error;
    }
    if (result.structuredContent && typeof result.structuredContent === 'object') {
        if (result.structuredContent.success === false) {
            const error = new Error('Swiggy MCP tool reported a failure.');
            error.code = 'SWIGGY_MCP_TOOL_FAILED';
            throw error;
        }
        return result.structuredContent;
    }
    const payloads = (Array.isArray(result.content) ? result.content : [])
        .filter((part) => part?.type === 'text')
        .map((part) => parseJsonText(part.text))
        .filter((part) => part !== null);
    if (!payloads.length) return {};
    const payload = payloads.length === 1 ? payloads[0] : payloads;
    if ((payload && !Array.isArray(payload) && payload.success === false)
        || (Array.isArray(payload) && payload.some((entry) => entry?.success === false))) {
        const error = new Error('Swiggy MCP tool reported a failure.');
        error.code = 'SWIGGY_MCP_TOOL_FAILED';
        throw error;
    }
    return payload;
}

function extractOrderId(order) {
    const found = findNamedValue(order, ['orderId', 'order_id', 'orderID']);
    if (found) return String(found.value).slice(0, 200);
    const directId = order && typeof order === 'object' && !Array.isArray(order) ? order.id : null;
    return directId === null || directId === undefined ? '' : String(directId).slice(0, 200);
}

function looksLikeOrder(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Boolean(extractOrderId(value) && findNamedValue(value, [
        'status', 'orderStatus', 'totalAmount', 'payableAmount', 'orderTotal', 'totalPaid',
        'orderTime', 'orderedTime', 'orderedAt', 'createdAt', 'items'
    ], 2));
}

function extractOrders(payload) {
    const named = findNamedArrays(payload, ['orders', 'orderList', 'orderHistory', 'pastOrders', 'data']);
    const candidates = named.flat().filter(looksLikeOrder);
    if (!candidates.length && Array.isArray(payload)) candidates.push(...payload.filter(looksLikeOrder));
    const seen = new Set();
    return candidates.filter((order) => {
        const id = extractOrderId(order);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
    }).slice(0, MAX_ORDERS_PER_PROVIDER);
}

function extractAddressIds(payload) {
    const arrays = findNamedArrays(payload, ['addresses', 'addressList', 'savedAddresses', 'data']);
    const ids = [];
    for (const value of arrays.flat()) {
        if (!value || typeof value !== 'object') continue;
        const found = findNamedValue(value, ['addressId', 'address_id'], 2);
        const direct = found?.value ?? value.id;
        if (direct !== null && direct !== undefined && direct !== '') ids.push(String(direct).slice(0, 200));
    }
    return [...new Set(ids)].slice(0, MAX_ADDRESSES);
}

function moneyToPaise(found) {
    if (!found) return 0;
    let value = found.value;
    const key = normalizedKey(found.key || '');
    if (value && typeof value === 'object') {
        const nested = findNamedValue(value, ['amountInPaise', 'paise', 'amount', 'value'], 2);
        if (!nested) return 0;
        value = nested.value;
        if (normalizedKey(nested.key).includes('paise')) return cleanInteger(value);
    }
    if (typeof value === 'string') {
        const normalized = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
        if (!normalized) return 0;
        const number = Number(normalized[0]);
        if (!Number.isFinite(number)) return 0;
        return Math.max(0, Math.round(key.includes('paise') ? number : number * 100));
    }
    if (!Number.isFinite(Number(value))) return 0;
    return Math.max(0, Math.round(key.includes('paise') ? Number(value) : Number(value) * 100));
}

function extractItems(root) {
    const arrays = findNamedArrays(root, ['items', 'orderItems', 'cartItems', 'products', 'itemList']);
    const source = arrays.find((array) => array.some((item) => item && typeof item === 'object')) || [];
    return source.slice(0, MAX_ITEMS_PER_ORDER).map((item) => {
        if (!item || typeof item !== 'object') return null;
        const nameValue = findNamedValue(item, ['itemName', 'productName', 'dishName', 'name', 'title'], 2)?.value;
        const name = sanitizeLabel(nameValue);
        if (!name) return null;
        const quantityValue = findNamedValue(item, ['quantity', 'qty', 'count'], 2)?.value;
        const quantityMatch = String(quantityValue ?? '1').match(/\d+(?:\.\d+)?/);
        const quantity = quantityMatch ? Math.max(0, Number(quantityMatch[0])) : 1;
        const amount = findNamedValue(item, [
            'lineAmountPaise', 'totalPaise', 'itemTotalPaise', 'lineAmount', 'itemTotal', 'subtotal', 'totalPrice', 'price'
        ], 3);
        return { name, quantity: quantity || 1, lineAmountPaise: moneyToPaise(amount) };
    }).filter(Boolean);
}

function extractFees(root) {
    const arrays = findNamedArrays(root, ['fees', 'charges', 'feeBreakdown', 'chargesBreakdown']);
    const fees = [];
    for (const fee of arrays.flat()) {
        if (!fee || typeof fee !== 'object') continue;
        const name = sanitizeLabel(findNamedValue(fee, ['name', 'label', 'title', 'type'], 2)?.value, 80);
        const amount = findNamedValue(fee, ['amountPaise', 'feePaise', 'amount', 'value', 'fee'], 2);
        if (name) fees.push({ name, amountPaise: moneyToPaise(amount) });
        if (fees.length >= 30) break;
    }
    return fees;
}

function defaultMerchant(provider) {
    return provider === 'swiggy_instamart' ? 'Swiggy Instamart' : 'Swiggy';
}

function statusShouldBeSkipped(status) {
    return /cancel|fail|pending|payment\s*pending|reject|incomplete/i.test(String(status || ''));
}

function selectOrderObject(payload, expectedOrderId) {
    const orders = extractOrders(payload);
    return orders.find((order) => extractOrderId(order) === String(expectedOrderId)) || orders[0] || payload;
}

function normalizeFetchedOrder(summary, detailPayload, provider, fetchedAt) {
    const summaryId = extractOrderId(summary);
    if (!summaryId) return null;
    const detail = selectOrderObject(detailPayload, summaryId);
    const roots = [detail, summary].filter(Boolean);
    const get = (names, depth = 4) => roots.map((root) => findNamedValue(root, names, depth)).find(Boolean);
    const occurredAt = normalizeDate(get([
        'orderedAt', 'orderedTime', 'orderTime', 'orderDate', 'createdAt', 'created_at', 'orderPlacedAt', 'orderPlacedTime', 'timestamp'
    ])?.value);
    const status = sanitizeLabel(get(['orderStatus', 'status', 'state'])?.value || 'COMPLETED', 40);
    if (!occurredAt || statusShouldBeSkipped(status)) return null;

    const items = extractItems(detail).length ? extractItems(detail) : extractItems(summary);
    const fees = extractFees(detail).length ? extractFees(detail) : extractFees(summary);
    const merchant = sanitizeLabel(get([
        'restaurantName', 'storeName', 'merchantName', 'outletName', 'vendorName'
    ])?.value || defaultMerchant(provider));
    const payable = get([
        'payableAmountPaise', 'totalAmountPaise', 'orderTotalPaise', 'payableAmount', 'totalAmount', 'orderTotal', 'grandTotal', 'amountPaid', 'totalPaid'
    ]);
    const refund = get(['refundAmountPaise', 'refundedAmountPaise', 'refundAmount', 'refundedAmount', 'refundTotal']);

    return {
        provider,
        orderId: summaryId,
        orderIdHash: orderIdHash(summaryId),
        occurredAt,
        status,
        merchant: merchant || defaultMerchant(provider),
        payablePaise: moneyToPaise(payable),
        refundPaise: moneyToPaise(refund),
        items,
        fees,
        fetchedAt: new Date(fetchedAt).toISOString()
    };
}

async function callSwiggyTool(client, provider, name, args = {}) {
    assertAllowedSwiggyTool(provider, name);
    const result = await client.callTool({ name, arguments: args });
    return parseMcpResult(result);
}

async function collectInstamartOrders(client, fetchedAt) {
    const toolsResponse = typeof client.listTools === 'function' ? await client.listTools() : null;
    const availableTools = new Set((toolsResponse?.tools || []).map(tool => tool?.name).filter(Boolean));
    const detailsAvailable = toolsResponse == null || availableTools.has('get_order_details');
    const listPayload = await callSwiggyTool(client, 'swiggy_instamart', 'get_orders', {
        count: 20,
        orderType: 'INSTAMART',
        activeOnly: false
    });
    const summaries = extractOrders(listPayload).slice(0, 20);
    const orders = [];
    let detailFailures = 0;
    for (const summary of summaries) {
        const id = extractOrderId(summary);
        const summaryStatus = findNamedValue(summary, ['orderStatus', 'status', 'state'], 3)?.value;
        if (statusShouldBeSkipped(summaryStatus)) continue;
        if (!detailsAvailable) {
            const normalized = normalizeFetchedOrder(summary, summary, 'swiggy_instamart', fetchedAt);
            if (normalized) orders.push(normalized);
            continue;
        }
        try {
            const detail = await callSwiggyTool(client, 'swiggy_instamart', 'get_order_details', { orderId: id });
            const normalized = normalizeFetchedOrder(summary, detail, 'swiggy_instamart', fetchedAt);
            if (normalized) orders.push(normalized);
        } catch {
            detailFailures += 1;
            const normalized = normalizeFetchedOrder(summary, summary, 'swiggy_instamart', fetchedAt);
            if (normalized) orders.push(normalized);
        }
    }
    return { orders, detailFailures, detailsAvailable };
}

async function collectFoodOrders(client, fetchedAt) {
    const addressPayload = await callSwiggyTool(client, 'swiggy_food', 'get_addresses', {});
    const addressIds = extractAddressIds(addressPayload);
    const summariesById = new Map();
    for (const addressId of addressIds) {
        const listPayload = await callSwiggyTool(client, 'swiggy_food', 'get_food_orders', { addressId });
        for (const summary of extractOrders(listPayload)) {
            const id = extractOrderId(summary);
            if (id && !summariesById.has(id)) summariesById.set(id, { summary, addressId });
            if (summariesById.size >= MAX_ORDERS_PER_PROVIDER) break;
        }
        if (summariesById.size >= MAX_ORDERS_PER_PROVIDER) break;
    }

    const orders = [];
    let detailFailures = 0;
    for (const [id, { summary }] of [...summariesById].slice(0, MAX_ORDERS_PER_PROVIDER)) {
        const summaryStatus = findNamedValue(summary, ['orderStatus', 'status', 'state'], 3)?.value;
        if (statusShouldBeSkipped(summaryStatus)) continue;
        try {
            const detail = await callSwiggyTool(client, 'swiggy_food', 'get_food_order_details', { orderId: id });
            const normalized = normalizeFetchedOrder(summary, detail, 'swiggy_food', fetchedAt);
            if (normalized) orders.push(normalized);
        } catch {
            detailFailures += 1;
            const normalized = normalizeFetchedOrder(summary, summary, 'swiggy_food', fetchedAt);
            if (normalized) orders.push(normalized);
        }
    }
    return { orders, detailFailures, addressCount: addressIds.length };
}

function retainRecentOrders(orders, now) {
    const cutoff = new Date(now).getTime() - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    return orders.filter((order) => {
        const timestamp = Date.parse(order.occurredAt);
        return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= new Date(now).getTime() + 24 * 60 * 60 * 1000;
    });
}

function upsertOrders(existing, incoming, now) {
    const merged = new Map();
    for (const order of [...existing, ...incoming]) {
        const normalized = normalizePrivateCacheOrder(order);
        if (!normalized) continue;
        const key = `${normalized.provider}:${normalized.orderId || normalized.orderIdHash}`;
        const current = merged.get(key);
        if (!current || Date.parse(normalized.fetchedAt) >= Date.parse(current.fetchedAt)) merged.set(key, normalized);
    }
    return retainRecentOrders([...merged.values()], now).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

function safeFailureKind(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '');
    if (code === 'SWIGGY_REAUTH_REQUIRED' || /\b(?:401|unauthori[sz]ed|authentication|oauth)\b/i.test(message)) return 'authorization';
    if (code === 'SWIGGY_MCP_TIMEOUT') return 'timeout';
    return 'unavailable';
}

function filterSwiggyOrdersForWindow(orders, windowOrStart, optionalEnd) {
    const startValue = windowOrStart && typeof windowOrStart === 'object' && !(windowOrStart instanceof Date)
        ? windowOrStart.start
        : windowOrStart;
    const endValue = windowOrStart && typeof windowOrStart === 'object' && !(windowOrStart instanceof Date)
        ? windowOrStart.end
        : optionalEnd;
    const start = new Date(startValue).getTime();
    const end = new Date(endValue).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    return (Array.isArray(orders) ? orders : [])
        .filter((order) => {
            const timestamp = Date.parse(order.occurredAt);
            return Number.isFinite(timestamp) && timestamp >= start && timestamp < end;
        })
        .map(publicOrder)
        .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

async function syncSwiggyOrderCache(options = {}) {
    const {
        cachePath,
        cacheSecret,
        authDirectory = getDefaultSwiggyAuthDirectory(),
        now = new Date(),
        clientFactory = createSwiggyMcpClient,
        allowInteractiveAuth = false
    } = options;
    if (!cachePath) throw new TypeError('cachePath is required.');
    makeCacheKey(cacheSecret);
    const effectiveNow = new Date(now);
    if (Number.isNaN(effectiveNow.getTime())) throw new TypeError('now must be a valid date.');

    const warnings = [];
    let existing = [];
    let cacheWritable = true;
    try {
        existing = await readPrivateSwiggyOrderCache(path.resolve(cachePath), cacheSecret);
    } catch {
        cacheWritable = false;
        warnings.push('The encrypted Swiggy order cache could not be read; it was left unchanged.');
    }

    const incoming = [];
    const fetchedProviders = [];
    let reauthRequired = false;
    const providerStatus = {};

    for (const provider of PROVIDERS) {
        const label = provider === 'swiggy_instamart' ? 'Swiggy Instamart' : 'Swiggy Food';
        if (!allowInteractiveAuth && !hasSwiggyAuthState(authDirectory, provider)) {
            reauthRequired = true;
            providerStatus[provider] = 'authorization_required';
            warnings.push(`${label} authorization is required; the existing encrypted cache was used.`);
            continue;
        }

        let client;
        try {
            client = await clientFactory(provider, { authDirectory, allowInteractiveAuth });
            const result = provider === 'swiggy_instamart'
                ? await collectInstamartOrders(client, effectiveNow)
                : await collectFoodOrders(client, effectiveNow);
            incoming.push(...result.orders);
            fetchedProviders.push(provider);
            providerStatus[provider] = 'fetched';
            if (result.detailFailures) warnings.push(`${label} omitted details for ${result.detailFailures} order(s).`);
            if (provider === 'swiggy_instamart' && result.detailsAvailable === false) {
                warnings.push('Swiggy Instamart did not expose its optional order-details tool; available item data from the order-history response was used.');
            }
            if (provider === 'swiggy_food' && result.addressCount === 0) {
                warnings.push('Swiggy Food returned no saved address IDs, so no food orders could be requested.');
            }
        } catch (error) {
            const failure = safeFailureKind(error);
            if (failure === 'authorization') reauthRequired = true;
            providerStatus[provider] = failure;
            warnings.push(`${label} sync was ${failure}; the existing encrypted cache was used.`);
        } finally {
            await client?.close?.().catch(() => {});
        }
    }

    const combined = upsertOrders(existing, incoming, effectiveNow);
    let cacheUpdated = false;
    if (cacheWritable && (incoming.length > 0 || existing.length !== combined.length)) {
        try {
            await writePrivateSwiggyOrderCache(path.resolve(cachePath), cacheSecret, combined, effectiveNow);
            cacheUpdated = true;
        } catch {
            warnings.push('The Swiggy order cache could not be updated; fetched data is available for this report only.');
        }
    }

    return {
        orders: combined.map(publicOrder),
        warnings,
        reauthRequired,
        cacheUpdated,
        fetchedProviders,
        providerStatus,
        coverage: {
            swiggy_instamart: 'last_15_days',
            swiggy_food: 'best_effort_available_history',
            cacheRetentionDays: CACHE_RETENTION_DAYS
        }
    };
}

async function authorizeSwiggy(options = {}) {
    const authDirectory = path.resolve(options.authDirectory || getDefaultSwiggyAuthDirectory());
    const clientFactory = options.clientFactory || createSwiggyMcpClient;
    if (options.forceReauthorization !== false && clientFactory === createSwiggyMcpClient) {
        for (const provider of PROVIDERS) {
            const files = authStatePaths(authDirectory, provider);
            await fsp.unlink(files.tokens).catch((error) => {
                if (error?.code !== 'ENOENT') throw error;
            });
        }
    }
    const results = {};
    for (const provider of PROVIDERS) {
        let client;
        try {
            client = await clientFactory(provider, { authDirectory, allowInteractiveAuth: true });
            const response = await client.listTools();
            const available = new Set((response?.tools || []).map((tool) => tool?.name));
            const missing = SWIGGY_TOOL_ALLOWLIST[provider].filter((tool) => !available.has(tool));
            const missingRequiredTools = SWIGGY_REQUIRED_TOOLS[provider].filter((tool) => !available.has(tool));
            const missingOptionalTools = missing.filter((tool) => !missingRequiredTools.includes(tool));
            results[provider] = {
                authorized: true,
                missingTools: missing,
                missingRequiredTools,
                missingOptionalTools
            };
        } catch (error) {
            results[provider] = { authorized: false, failure: safeFailureKind(error) };
        } finally {
            await client?.close?.().catch(() => {});
        }
    }
    return {
        authDirectory,
        results,
        complete: PROVIDERS.every((provider) =>
            results[provider]?.authorized && results[provider].missingRequiredTools?.length === 0
        )
    };
}

module.exports = {
    SWIGGY_ENDPOINTS,
    SWIGGY_TOOL_ALLOWLIST,
    SWIGGY_REQUIRED_TOOLS,
    CACHE_RETENTION_DAYS,
    RUNTIME_AUTH_MAX_AGE_MS,
    getDefaultSwiggyAuthDirectory,
    hasSwiggyAuthState,
    assertAllowedSwiggyTool,
    createSwiggyMcpClient,
    authorizeSwiggy,
    syncSwiggyOrderCache,
    loadSwiggyOrderCache,
    filterSwiggyOrdersForWindow
};
