const BasePlugin = require('./BasePlugin');
const { shell } = require('electron');

class SharePlugin extends BasePlugin {
    constructor(eventEmitter) {
        super('SharePlugin');
        this.emitter = eventEmitter;
    }

    getCapabilities() {
        return ['kdeconnect.share.request'];
    }

    handlePacket(device, packet) {
        if (packet.type === 'kdeconnect.share.request') {
            const body = packet.body || {};
            const url = body.url;
            const text = body.text;

            if (url) {
                console.log(`[SharePlugin] Received shared URL from ${device.info.name}: ${url}`);

                // Open web page in Windows default browser
                try {
                    if (shell) {
                        shell.openExternal(url);
                    }
                } catch (e) {
                    console.warn('[SharePlugin] Failed to open external URL:', e.message);
                }

                if (this.emitter) {
                    this.emitter.emit('linkReceived', { url, source: device.info.name });
                }
            } else if (text) {
                console.log(`[SharePlugin] Received shared text from ${device.info.name}: "${text}"`);
                if (this.emitter) {
                    this.emitter.emit('textShared', { text, source: device.info.name });
                }
            }
        }
    }

    shareUrlToPhone(device, url) {
        if (!device || !url) return false;

        const sharePacket = {
            id: Date.now(),
            type: 'kdeconnect.share.request',
            body: {
                url: url
            }
        };

        console.log(`[SharePlugin] Sharing URL to ${device.info.name}: ${url}`);
        return device.sendPacket(sharePacket);
    }

    shareTextToPhone(device, text) {
        if (!device || !text) return false;

        const sharePacket = {
            id: Date.now(),
            type: 'kdeconnect.share.request',
            body: {
                text: text
            }
        };

        return device.sendPacket(sharePacket);
    }
}

module.exports = SharePlugin;
