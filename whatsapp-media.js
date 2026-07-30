function jidString(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return value._serialized || value.user || '';
}

function buildSerializedMessageId(message) {
    const id = message?.id;
    if (!id) return null;
    if (typeof id === 'string') return id;
    if (id._serialized) return id._serialized;
    if (!id.id) return null;

    const remote = jidString(id.remote) || (message.fromMe ? message.to : message.from);
    if (!remote) return null;

    const parts = [Boolean(id.fromMe ?? message.fromMe), remote, id.id];
    const participant = jidString(id.participant) || message.author;
    if (participant && remote.endsWith('@g.us')) parts.push(participant);
    return parts.join('_');
}

async function repairMessageForMedia(client, message) {
    if (!message?.id || typeof message.id === 'string') return message;

    let serializedId = message.id._serialized || null;
    const fallbackId = buildSerializedMessageId(message);

    if (!serializedId && client?.pupPage?.evaluate) {
        const identity = {
            id: message.id.id,
            fromMe: Boolean(message.id.fromMe ?? message.fromMe),
            remote: jidString(message.id.remote) || (message.fromMe ? message.to : message.from),
            participant: jidString(message.id.participant) || message.author || ''
        };

        try {
            serializedId = await client.pupPage.evaluate((needle) => {
                const collection = window.require('WAWebCollections').Msg;
                const models = Array.isArray(collection.models) ? collection.models : [];
                const asString = value => {
                    if (!value) return '';
                    if (typeof value === 'string') return value;
                    return value._serialized || value.user || '';
                };
                const exact = models.find(candidate => {
                    const candidateId = candidate?.id;
                    if (!candidateId || candidateId.id !== needle.id) return false;
                    if (Boolean(candidateId.fromMe) !== needle.fromMe) return false;
                    const candidateRemote = asString(candidateId.remote);
                    return !needle.remote || !candidateRemote || candidateRemote === needle.remote;
                });
                if (!exact?.id) return null;
                if (exact.id._serialized) return exact.id._serialized;

                const remote = asString(exact.id.remote) || needle.remote;
                if (!remote) return null;
                const parts = [Boolean(exact.id.fromMe), remote, exact.id.id];
                const participant = asString(exact.id.participant) || needle.participant;
                if (participant && remote.endsWith('@g.us')) parts.push(participant);
                return parts.join('_');
            }, identity);
        } catch (_) {
            // If WhatsApp refreshed its execution context, the Node-side ID
            // components below can still reconstruct the serialized value.
        }
    }

    serializedId ||= fallbackId;
    if (!serializedId) return message;

    let refreshedMessage = null;
    if (typeof client?.getMessageById === 'function') {
        try {
            refreshedMessage = await client.getMessageById(serializedId);
        } catch (_) {
            // The original event message is still usable after repairing its ID.
        }
    }

    const target = refreshedMessage || message;
    if (target.id && typeof target.id === 'object' && !target.id._serialized) {
        target.id._serialized = serializedId;
    }
    return target;
}

async function downloadVoiceMediaDirect(client, message) {
    if (!client?.pupPage?.evaluate || !message?.id?.id) return null;

    const identity = {
        id: message.id.id,
        fromMe: Boolean(message.id.fromMe ?? message.fromMe),
        remote: jidString(message.id.remote) || (message.fromMe ? message.to : message.from),
        participant: jidString(message.id.participant) || message.author || ''
    };

    return client.pupPage.evaluate(async (needle) => {
        const asString = value => {
            if (!value) return '';
            if (typeof value === 'string') return value;
            return value._serialized || value.user || '';
        };
        const matches = candidate => {
            const candidateId = candidate?.id;
            if (!candidateId || candidateId.id !== needle.id) return false;
            if (Boolean(candidateId.fromMe) !== needle.fromMe) return false;
            const candidateRemote = asString(candidateId.remote);
            if (needle.remote && candidateRemote && candidateRemote !== needle.remote) return false;
            const candidateParticipant = asString(candidateId.participant);
            return !needle.participant || !candidateParticipant || candidateParticipant === needle.participant;
        };

        const collection = window.require('WAWebCollections').Msg;
        let liveMessage = (collection.models || []).find(matches);

        // Current WhatsApp builds may omit id._serialized from event models and
        // may also keep the model only in the chat collection. Load that chat
        // explicitly and match on the stable raw ID fields instead.
        if (!liveMessage && needle.remote) {
            const chat = await window.WWebJS.getChat(needle.remote, { getAsModel: false });
            if (chat) {
                liveMessage = chat.msgs.getModelsArray().find(matches);
                if (!liveMessage) {
                    const earlier = await window
                        .require('WAWebChatLoadMessages')
                        .loadEarlierMsgs({ chat });
                    liveMessage = (earlier || []).find(matches);
                }
            }
        }

        if (!liveMessage?.mediaData || !liveMessage.directPath || !liveMessage.mediaKey) {
            return null;
        }

        if (liveMessage.mediaData.mediaStage !== 'RESOLVED') {
            await liveMessage.downloadMedia({
                downloadEvenIfExpensive: true,
                rmrReason: 1
            });
        }

        // Some WhatsApp Web builds return from downloadMedia while the media is
        // still transitioning. Wait briefly for the encrypted path to resolve.
        for (let poll = 0; poll < 20; poll += 1) {
            const stage = liveMessage.mediaData?.mediaStage;
            if (stage === 'RESOLVED') break;
            if (String(stage || '').includes('ERROR')) return null;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (liveMessage.mediaData?.mediaStage !== 'RESOLVED') return null;

        const mockQpl = {
            addAnnotations() { return this; },
            addPoint() { return this; }
        };
        const decryptedMedia = await window
            .require('WAWebDownloadManager')
            .downloadManager.downloadAndMaybeDecrypt({
                directPath: liveMessage.directPath,
                encFilehash: liveMessage.encFilehash,
                filehash: liveMessage.filehash,
                mediaKey: liveMessage.mediaKey,
                mediaKeyTimestamp: liveMessage.mediaKeyTimestamp,
                type: liveMessage.type,
                signal: new AbortController().signal,
                downloadQpl: mockQpl
            });

        return {
            data: await window.WWebJS.arrayBufferToBase64Async(decryptedMedia),
            mimetype: liveMessage.mimetype,
            filename: liveMessage.filename,
            filesize: liveMessage.size
        };
    }, identity);
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function downloadVoiceMediaWithRetry({
    client,
    message,
    delaysMs = [1200, 2500, 5000, 8000],
    waitFn = wait,
    logger = console
}) {
    let lastError;
    const totalAttempts = delaysMs.length + 1;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        if (attempt > 1) await waitFn(delaysMs[attempt - 2]);

        try {
            let media = await downloadVoiceMediaDirect(client, message);
            if (!media?.data) {
                const currentMessage = await repairMessageForMedia(client, message);
                media = await currentMessage.downloadMedia();
            }
            if (media?.data) {
                if (attempt > 1) logger.info(`WhatsApp voice-note download succeeded on attempt ${attempt}.`);
                return media;
            }
            lastError = new Error('WhatsApp returned an empty voice-note download.');
        } catch (error) {
            lastError = error;
        }

        logger.warn(
            `WhatsApp voice-note download attempt ${attempt}/${totalAttempts} failed: ` +
            `${lastError?.message || lastError}`
        );
    }

    const finalError = new Error(
        `WhatsApp could not download the voice note after ${totalAttempts} attempts: ` +
        `${lastError?.message || lastError || 'unknown media error'}`
    );
    finalError.code = 'WHATSAPP_MEDIA_DOWNLOAD_FAILED';
    finalError.cause = lastError;
    throw finalError;
}

module.exports = {
    buildSerializedMessageId,
    repairMessageForMedia,
    downloadVoiceMediaDirect,
    downloadVoiceMediaWithRetry
};
