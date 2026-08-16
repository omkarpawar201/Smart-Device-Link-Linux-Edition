const BasePlugin = require('./BasePlugin');
const { clipboard } = require('electron');

class ClipboardPlugin extends BasePlugin {
    constructor(eventEmitter) {
        super('ClipboardPlugin');
        this.emitter = eventEmitter;
        this.lastContent = '';
        this.history = [];
    }

    getCapabilities() {
        return ['kdeconnect.clipboard'];
    }

    handlePacket(device, packet) {
        if (packet.type === 'kdeconnect.clipboard') {
            const body = packet.body || {};
            const content = body.content || '';

            if (content && content !== this.lastContent) {
                this.lastContent = content;

                // Copy received text to Windows OS Clipboard
                try {
                    if (clipboard) {
                        clipboard.writeText(content);
                    }
                } catch (e) {
                    console.warn('[ClipboardPlugin] Electron clipboard write fallback:', e.message);
                }

                const item = {
                    id: `clip_${Date.now()}`,
                    content: content,
                    source: device.info.name || 'Phone',
                    time: Date.now()
                };

                this.history.unshift(item);
                if (this.history.length > 20) this.history.pop();

                console.log(`[ClipboardPlugin] Received & Copied to Windows Clipboard: "${content.substring(0, 30)}..."`);

                if (this.emitter) {
                    this.emitter.emit('clipboardReceived', item);
                }
            }
        }
    }

    sendClipboard(device, text) {
        if (!device || !text) return false;

        this.lastContent = text;

        const clipboardPacket = {
            id: Date.now(),
            type: 'kdeconnect.clipboard',
            body: {
                content: text
            }
        };

        console.log(`[ClipboardPlugin] Sending PC Clipboard to ${device.info.name}: "${text.substring(0, 30)}..."`);
        return device.sendPacket(clipboardPacket);
    }

    getHistory() {
        return this.history;
    }

    clearHistory() {
        this.history = [];
    }

    removeFromHistory(id) {
        this.history = this.history.filter((h) => h.id !== id);
    }

    addSentFromPc(content, source) {
        if (!content) return null;
        this.lastContent = content;
        const item = {
            id: `pc_${Date.now()}`,
            content,
            source: source || 'PC',
            time: Date.now()
        };
        this.history.unshift(item);
        if (this.history.length > 20) this.history.pop();
        return item;
    }
}

module.exports = ClipboardPlugin;
