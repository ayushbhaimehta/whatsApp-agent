const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildSerializedMessageId,
    repairMessageForMedia,
    downloadVoiceMediaDirect,
    downloadVoiceMediaWithRetry
} = require('../whatsapp-media');

const quietLogger = { info() {}, warn() {} };

test('reconstructs the serialized ID missing from current outgoing WhatsApp messages', () => {
    const message = {
        fromMe: true,
        from: '919000000001@c.us',
        to: '123456789012345@lid',
        id: {
            fromMe: true,
            remote: '123456789012345@lid',
            id: 'AC5601C0D8C84A03784EA00985082C9A'
        }
    };

    assert.equal(
        buildSerializedMessageId(message),
        'true_123456789012345@lid_AC5601C0D8C84A03784EA00985082C9A'
    );
});

test('includes the participant when reconstructing a group message ID', () => {
    const message = {
        fromMe: false,
        author: '919999999999@c.us',
        id: { fromMe: false, remote: '120363000000@g.us', id: 'ABC123' }
    };

    assert.equal(
        buildSerializedMessageId(message),
        'false_120363000000@g.us_ABC123_919999999999@c.us'
    );
});

test('repairs the ID and refetches a fresh message before downloading media', async () => {
    const eventMessage = {
        fromMe: true,
        to: 'self@lid',
        id: { fromMe: true, remote: 'self@lid', id: 'VOICE1' }
    };
    const refreshedMessage = {
        id: { fromMe: true, remote: 'self@lid', id: 'VOICE1' },
        async downloadMedia() { return { data: 'audio-data', mimetype: 'audio/ogg' }; }
    };
    let requestedId;
    const client = {
        pupPage: { evaluate: async () => 'true_self@lid_VOICE1' },
        async getMessageById(id) {
            requestedId = id;
            return refreshedMessage;
        }
    };

    const repaired = await repairMessageForMedia(client, eventMessage);
    assert.equal(requestedId, 'true_self@lid_VOICE1');
    assert.equal(repaired, refreshedMessage);
    assert.equal(repaired.id._serialized, 'true_self@lid_VOICE1');
});

test('uses the direct WhatsApp decryption result when serialized lookup is broken', async () => {
    const expectedMedia = {
        data: 'direct-decrypted-audio',
        mimetype: 'audio/ogg; codecs=opus',
        filesize: 16425
    };
    let receivedIdentity;
    const client = {
        pupPage: {
            async evaluate(_browserFunction, identity) {
                receivedIdentity = identity;
                return expectedMedia;
            }
        }
    };
    const message = {
        fromMe: true,
        to: 'self@lid',
        id: { fromMe: true, remote: 'self@lid', id: 'VOICE-DIRECT' }
    };

    const media = await downloadVoiceMediaDirect(client, message);
    assert.equal(media, expectedMedia);
    assert.deepEqual(receivedIdentity, {
        id: 'VOICE-DIRECT',
        fromMe: true,
        remote: 'self@lid',
        participant: ''
    });
});

test('prefers direct decryption and does not call the broken Message.downloadMedia path', async () => {
    let libraryCalls = 0;
    const client = {
        pupPage: {
            async evaluate() {
                return { data: 'direct-audio', mimetype: 'audio/ogg' };
            }
        }
    };
    const message = {
        fromMe: true,
        to: 'self@lid',
        id: { fromMe: true, remote: 'self@lid', id: 'VOICE-DIRECT-ONLY' },
        async downloadMedia() {
            libraryCalls += 1;
            return undefined;
        }
    };

    const media = await downloadVoiceMediaWithRetry({
        client,
        message,
        delaysMs: [],
        waitFn: async () => {},
        logger: quietLogger
    });

    assert.equal(media.data, 'direct-audio');
    assert.equal(libraryCalls, 0);
});

test('retries temporary WhatsApp media failures without sending a real message', async () => {
    let attempts = 0;
    const message = {
        id: { _serialized: 'true_self@lid_VOICE2', id: 'VOICE2' },
        async downloadMedia() {
            attempts += 1;
            if (attempts < 3) throw new Error('r: r');
            return { data: 'base64-audio', mimetype: 'audio/ogg; codecs=opus' };
        }
    };

    const media = await downloadVoiceMediaWithRetry({
        client: {},
        message,
        delaysMs: [1, 1, 1],
        waitFn: async () => {},
        logger: quietLogger
    });

    assert.equal(attempts, 3);
    assert.equal(media.data, 'base64-audio');
});

test('returns a specific error after all WhatsApp media retries fail', async () => {
    const message = {
        id: { _serialized: 'true_self@lid_VOICE3', id: 'VOICE3' },
        async downloadMedia() { return undefined; }
    };

    await assert.rejects(
        downloadVoiceMediaWithRetry({
            client: {},
            message,
            delaysMs: [1],
            waitFn: async () => {},
            logger: quietLogger
        }),
        error => error.code === 'WHATSAPP_MEDIA_DOWNLOAD_FAILED'
    );
});
