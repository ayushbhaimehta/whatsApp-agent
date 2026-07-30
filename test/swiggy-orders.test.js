const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
    SWIGGY_ENDPOINTS,
    assertAllowedSwiggyTool,
    authorizeSwiggy,
    hasSwiggyAuthState,
    loadSwiggyOrderCache,
    syncSwiggyOrderCache,
    filterSwiggyOrdersForWindow
} = require('../swiggy-orders');

function result(payload, useText = false) {
    return useText
        ? { content: [{ type: 'text', text: `\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` }] }
        : { structuredContent: payload, content: [] };
}

function makeFakeClientFactory({ failProvider = null, calls = [] } = {}) {
    return async (provider) => {
        if (provider === failProvider) {
            const error = new Error('service unavailable');
            error.code = 'ECONNRESET';
            throw error;
        }
        return {
            async callTool(request) {
                calls.push({ provider, name: request.name, arguments: request.arguments });
                if (provider === 'swiggy_instamart' && request.name === 'get_orders') {
                    return result({
                        data: {
                            orders: [
                                {
                                    orderId: 'IM-PRIVATE-123',
                                    orderStatus: 'DELIVERED',
                                    orderedAt: '2026-07-29T13:00:00.000Z',
                                    totalAmount: 625.5
                                },
                                {
                                    orderId: 'IM-CANCELLED-999',
                                    orderStatus: 'CANCELLED',
                                    orderedAt: '2026-07-28T13:00:00.000Z',
                                    totalAmount: 100
                                }
                            ]
                        }
                    });
                }
                if (provider === 'swiggy_instamart' && request.name === 'get_order_details') {
                    if (request.arguments.orderId === 'IM-CANCELLED-999') {
                        return result({ order: { orderId: request.arguments.orderId, status: 'CANCELLED' } });
                    }
                    return result({
                        order: {
                            orderId: request.arguments.orderId,
                            orderStatus: 'DELIVERED',
                            orderedAt: '2026-07-29T13:00:00.000Z',
                            totalAmount: '₹625.50',
                            storeName: 'Instamart Store, call 9876543210',
                            deliveryAddress: 'Private home address',
                            paymentDetails: { upiId: 'private@okbank' },
                            items: [
                                { productName: 'Fresh Paneer', quantity: 2, itemTotal: 240 },
                                { productName: 'Diet Coke', qty: 1, itemTotalPaise: 12500 }
                            ],
                            charges: [{ label: 'Delivery fee', amount: 20 }]
                        }
                    }, true);
                }
                if (provider === 'swiggy_food' && request.name === 'get_addresses') {
                    return result({
                        addresses: [{ addressId: 'ADDRESS-PRIVATE-1', phone: '9999999999', line1: 'Private home address' }]
                    });
                }
                if (provider === 'swiggy_food' && request.name === 'get_food_orders') {
                    assert.equal(request.arguments.addressId, 'ADDRESS-PRIVATE-1');
                    assert.equal(Object.hasOwn(request.arguments, 'activeOnly'), false);
                    return result({
                        orders: [{
                            order_id: 'FOOD-PRIVATE-456',
                            orderStatus: 'DELIVERED',
                            orderedTime: '2026-07-29T14:00:00.000Z',
                            orderTotal: '310'
                        }]
                    }, true);
                }
                if (provider === 'swiggy_food' && request.name === 'get_food_order_details') {
                    return result({
                        orderDetails: {
                            orderId: request.arguments.orderId,
                            status: 'DELIVERED',
                            orderedTime: '2026-07-29T14:00:00.000Z',
                            totalPaid: 310,
                            restaurantName: 'Poha Corner',
                            items: [{ name: 'Indori Poha', quantity: 2, price: 140, subtotal: 280 }],
                            fees: [{ name: 'Platform fee', amount: 30 }]
                        }
                    });
                }
                throw new Error(`Unexpected fake call: ${provider}/${request.name}`);
            },
            async listTools() {
                const names = provider === 'swiggy_instamart'
                    ? ['get_orders', 'get_order_details']
                    : ['get_addresses', 'get_food_orders', 'get_food_order_details'];
                return { tools: names.map(name => ({ name })) };
            },
            async close() {}
        };
    };
}

async function temporaryPaths(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swiggy-orders-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return {
        directory,
        cachePath: path.join(directory, 'private-cache.enc.json'),
        authDirectory: path.join(directory, 'auth')
    };
}

test('syncs only allowlisted read-only tools and normalizes both Swiggy providers', async (t) => {
    const paths = await temporaryPaths(t);
    const calls = [];
    const synced = await syncSwiggyOrderCache({
        ...paths,
        cacheSecret: 'unit-test-cache-secret',
        now: '2026-07-31T10:00:00.000Z',
        allowInteractiveAuth: true,
        clientFactory: makeFakeClientFactory({ calls })
    });

    assert.deepEqual(synced.fetchedProviders, ['swiggy_instamart', 'swiggy_food']);
    assert.equal(synced.orders.length, 2);
    assert.equal(synced.orders.some((order) => order.status === 'CANCELLED'), false);
    assert.deepEqual(calls.map((call) => call.name), [
        'get_orders',
        'get_order_details',
        'get_addresses',
        'get_food_orders',
        'get_food_order_details'
    ]);
    assert.deepEqual(calls[0].arguments, { count: 20, orderType: 'INSTAMART', activeOnly: false });
    assert.equal(synced.orders.every((order) => !Object.hasOwn(order, 'orderId')), true);
    assert.equal(synced.orders.find((order) => order.provider === 'swiggy_instamart').payablePaise, 62550);
    assert.equal(synced.orders.find((order) => order.provider === 'swiggy_food').items[0].name, 'Indori Poha');
    assert.deepEqual(calls.at(-1).arguments, { orderId: 'FOOD-PRIVATE-456' });
});

test('encrypted cache contains neither raw order data nor credentials and public loader omits order IDs', async (t) => {
    const paths = await temporaryPaths(t);
    await syncSwiggyOrderCache({
        ...paths,
        cacheSecret: 'another-cache-secret',
        now: '2026-07-31T10:00:00.000Z',
        allowInteractiveAuth: true,
        clientFactory: makeFakeClientFactory()
    });

    const serialized = await fs.readFile(paths.cachePath, 'utf8');
    assert.doesNotMatch(serialized, /IM-PRIVATE-123|FOOD-PRIVATE-456|Private home address|private@okbank|Fresh Paneer/);
    assert.match(serialized, /aes-256-gcm/);

    const loaded = await loadSwiggyOrderCache(paths.cachePath, 'another-cache-secret');
    assert.equal(loaded.length, 2);
    assert.equal(loaded.every((order) => !Object.hasOwn(order, 'orderId')), true);
    assert.equal(loaded.every((order) => /^[a-f0-9]{24}$/.test(order.orderIdHash)), true);
    assert.doesNotMatch(JSON.stringify(loaded), /Private home address|private@okbank|9876543210/);
});

test('non-interactive sync never creates a client when auth state is absent and falls back to cache', async (t) => {
    const paths = await temporaryPaths(t);
    const cacheSecret = 'fallback-cache-secret';
    await syncSwiggyOrderCache({
        ...paths,
        cacheSecret,
        now: '2026-07-31T10:00:00.000Z',
        allowInteractiveAuth: true,
        clientFactory: makeFakeClientFactory()
    });

    let factoryCalls = 0;
    const resultFromCache = await syncSwiggyOrderCache({
        ...paths,
        cacheSecret,
        now: '2026-07-31T11:00:00.000Z',
        clientFactory: async () => {
            factoryCalls += 1;
            throw new Error('must not be reached');
        }
    });
    assert.equal(factoryCalls, 0);
    assert.equal(resultFromCache.orders.length, 2);
    assert.equal(resultFromCache.reauthRequired, true);
    assert.deepEqual(resultFromCache.providerStatus, {
        swiggy_instamart: 'authorization_required',
        swiggy_food: 'authorization_required'
    });
});

test('provider failures retain its encrypted cached orders while another provider can update', async (t) => {
    const paths = await temporaryPaths(t);
    const cacheSecret = 'provider-failure-secret';
    await syncSwiggyOrderCache({
        ...paths,
        cacheSecret,
        now: '2026-07-31T10:00:00.000Z',
        allowInteractiveAuth: true,
        clientFactory: makeFakeClientFactory()
    });
    const resultFromCache = await syncSwiggyOrderCache({
        ...paths,
        cacheSecret,
        now: '2026-07-31T12:00:00.000Z',
        allowInteractiveAuth: true,
        clientFactory: makeFakeClientFactory({ failProvider: 'swiggy_instamart' })
    });

    assert.equal(resultFromCache.orders.some((order) => order.provider === 'swiggy_instamart'), true);
    assert.equal(resultFromCache.orders.some((order) => order.provider === 'swiggy_food'), true);
    assert.equal(resultFromCache.providerStatus.swiggy_instamart, 'unavailable');
    assert.match(resultFromCache.warnings.join(' '), /existing encrypted cache was used/i);
});

test('hasSwiggyAuthState recognizes endpoint-specific mcp-remote state', async (t) => {
    const paths = await temporaryPaths(t);
    const version = require('mcp-remote/package.json').version;
    const versionDirectory = path.join(paths.authDirectory, `mcp-remote-${version}`);
    await fs.mkdir(versionDirectory, { recursive: true });
    for (const [provider, endpoint] of Object.entries(SWIGGY_ENDPOINTS)) {
        const hash = crypto.createHash('md5').update(endpoint).digest('hex');
        await fs.writeFile(path.join(versionDirectory, `${hash}_tokens.json`), JSON.stringify({ access_token: `${provider}-token` }));
        await fs.writeFile(path.join(versionDirectory, `${hash}_client_info.json`), JSON.stringify({ client_id: `${provider}-client` }));
        assert.equal(hasSwiggyAuthState(paths.authDirectory, provider), true);
    }
    assert.equal(hasSwiggyAuthState(paths.authDirectory), true);
});

test('rejects every non-allowlisted or cross-provider MCP tool locally', () => {
    assert.doesNotThrow(() => assertAllowedSwiggyTool('swiggy_instamart', 'get_orders'));
    assert.throws(
        () => assertAllowedSwiggyTool('swiggy_instamart', 'get_addresses'),
        { code: 'SWIGGY_TOOL_NOT_ALLOWED' }
    );
    assert.throws(
        () => assertAllowedSwiggyTool('swiggy_food', 'place_order'),
        { code: 'SWIGGY_TOOL_NOT_ALLOWED' }
    );
});

test('filters by a half-open reporting window and never exposes a raw ID', () => {
    const filtered = filterSwiggyOrdersForWindow([
        { provider: 'swiggy_food', orderId: 'secret-1', orderIdHash: 'a'.repeat(24), occurredAt: '2026-07-01T00:00:00Z', status: 'DELIVERED', merchant: 'Swiggy', payablePaise: 10000, refundPaise: 0, items: [], fees: [], fetchedAt: '2026-07-31T00:00:00Z' },
        { provider: 'swiggy_food', orderId: 'secret-2', orderIdHash: 'b'.repeat(24), occurredAt: '2026-08-01T00:00:00Z', status: 'DELIVERED', merchant: 'Swiggy', payablePaise: 20000, refundPaise: 0, items: [], fees: [], fetchedAt: '2026-07-31T00:00:00Z' }
    ], { start: '2026-07-01T00:00:00Z', end: '2026-08-01T00:00:00Z' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].orderIdHash, 'a'.repeat(24));
    assert.equal(Object.hasOwn(filtered[0], 'orderId'), false);
});

test('authorization helper visits both endpoints with interactive auth but never calls an order tool', async (t) => {
    const paths = await temporaryPaths(t);
    const observed = [];
    const output = await authorizeSwiggy({
        authDirectory: paths.authDirectory,
        clientFactory: async (provider, options) => {
            observed.push({ provider, options });
            return {
                async listTools() {
                    const names = provider === 'swiggy_instamart'
                        ? ['get_orders', 'get_order_details']
                        : ['get_addresses', 'get_food_orders', 'get_food_order_details'];
                    return { tools: names.map((name) => ({ name })) };
                },
                async callTool() {
                    throw new Error('authorization must not read orders');
                },
                async close() {}
            };
        }
    });
    assert.equal(output.complete, true);
    assert.deepEqual(observed.map((entry) => entry.provider), ['swiggy_instamart', 'swiggy_food']);
    assert.equal(observed.every((entry) => entry.options.allowInteractiveAuth === true), true);
});

test('treats the live Instamart details-tool gap as optional and uses list items', async (t) => {
    const paths = await temporaryPaths(t);
    const calls = [];
    const synced = await syncSwiggyOrderCache({
        ...paths,
        cacheSecret: 'optional-details-test-secret',
        now: '2026-07-31T10:00:00.000Z',
        allowInteractiveAuth: true,
        clientFactory: async (provider) => ({
            async listTools() {
                const names = provider === 'swiggy_instamart'
                    ? ['get_orders']
                    : ['get_addresses', 'get_food_orders', 'get_food_order_details'];
                return { tools: names.map(name => ({ name })) };
            },
            async callTool(request) {
                calls.push({ provider, name: request.name });
                if (provider === 'swiggy_instamart') return result({
                    orders: [{
                        orderId: 'IM-LIST-ONLY', status: 'DELIVERED', orderedAt: '2026-07-30T08:00:00Z',
                        totalAmount: 180, items: [{ productName: 'Paneer', quantity: 1, itemTotal: 180 }]
                    }]
                });
                if (request.name === 'get_addresses') return result({ addresses: [] });
                throw new Error(`Unexpected call ${request.name}`);
            },
            async close() {}
        })
    });
    assert.equal(calls.some(call => call.name === 'get_order_details'), false);
    assert.equal(synced.orders.find(order => order.provider === 'swiggy_instamart').items[0].name, 'Paneer');
    assert.ok(synced.warnings.some(warning => /optional order-details tool/i.test(warning)));

    const authorization = await authorizeSwiggy({
        authDirectory: paths.authDirectory,
        clientFactory: async (provider) => ({
            async listTools() {
                const names = provider === 'swiggy_instamart'
                    ? ['get_orders']
                    : ['get_addresses', 'get_food_orders', 'get_food_order_details'];
                return { tools: names.map(name => ({ name })) };
            },
            async close() {}
        })
    });
    assert.equal(authorization.complete, true);
    assert.deepEqual(authorization.results.swiggy_instamart.missingOptionalTools, ['get_order_details']);
});
