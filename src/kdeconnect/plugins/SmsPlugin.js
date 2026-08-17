const BasePlugin = require('./BasePlugin');
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

class SmsPlugin extends BasePlugin {
    constructor(eventEmitter) {
        super('SmsPlugin');
        this.emitter = eventEmitter;
        this.threads = new Map(); // thread_id -> { threadId, contactName, address, lastMessage, messages: [] }
        this.cacheFile = path.join(app.getPath('userData'), 'sms-cache.json');
        this.loadCache();
    }

    getCapabilities() {
        // Note: kdeconnect.notification is intentionally NOT registered here. SmsPlugin only
        // turns SMS-app notifications into threads, and those arrive already-filtered via the
        // bridge's smsNotificationReceived forwarding. Registering for the raw packet would
        // create a fake thread for every notification (Google Photos, etc.).
        return ['kdeconnect.sms.messages', 'kdeconnect.sms.request'];
    }

    handlePacket(device, packet) {
        console.log(`[SmsPlugin] Packet received: ${packet.type} (keys: ${Object.keys(packet.body || {}).join(', ')})`);

        if (packet.type === 'kdeconnect.sms.messages' || packet.type === 'kdeconnect.sms.request') {
            const body = packet.body || {};
            const rawMessages = body.messages || body.conversations || body.threads || [];

            if (rawMessages.length > 0) {
                console.log(`[SmsPlugin] Processing ${rawMessages.length} SMS items from ${device.info.name}`);

                rawMessages.forEach((msg) => {
                    const threadId = (msg.thread_id !== undefined && msg.thread_id !== null)
                        ? msg.thread_id
                        : ((msg.threadId !== undefined && msg.threadId !== null)
                            ? msg.threadId
                            : (msg.addresses && msg.addresses[0] ? (msg.addresses[0].address || msg.addresses[0]) : 'default'));
                    const address = (msg.addresses && msg.addresses[0]) ? (msg.addresses[0].address || msg.addresses[0]) : (msg.address || 'Unknown');
                    const text = msg.body || msg.messageBody || '';
                    const timestamp = msg.date || msg.time || Date.now();
                    const type = msg.type || 1; // 1 = Received, 2 = Sent

                    if (!this.threads.has(threadId)) {
                        this.threads.set(threadId, {
                            threadId: threadId,
                            address: String(address),
                            contactName: String(address),
                            lastMessage: text,
                            lastDate: timestamp,
                            messages: []
                        });
                    }

                    const thread = this.threads.get(threadId);
                    if (timestamp >= thread.lastDate) {
                        thread.lastDate = timestamp;
                        thread.lastMessage = text;
                    }

                    const msgObj = {
                        id: msg._id || msg.id || `sms_${timestamp}_${Math.random().toString(36).substr(2, 4)}`,
                        threadId: threadId,
                        address: String(address),
                        body: text,
                        date: timestamp,
                        type: type
                    };

                    if (!thread.messages.some((m) => m.id === msgObj.id || (m.body === msgObj.body && m.date === msgObj.date))) {
                        thread.messages.push(msgObj);
                        thread.messages.sort((a, b) => a.date - b.date);
                    }
                });

                if (this.emitter) {
                    this.emitter.emit('smsThreadsUpdated', this.getThreadsList());
                }
                this.saveCache();
            }
        } else if (packet.type === 'kdeconnect.notification') {
            const body = packet.body || {};
            const appName = (body.appName || '').toLowerCase();
            const packageName = (body.packageName || '').toLowerCase();
            const isSmsApp = appName.includes('message') || appName.includes('sms') || appName.includes('messaging')
                || packageName.includes('messaging') || packageName.includes('mms') || packageName.includes('sms') || packageName.includes('messages');

            // Only SMS/Messaging apps may create threads in the Messages view.
            if (!isSmsApp) return;

            if (!body.isCancel && body.text) {
                const contactOrNum = body.title || 'SMS Contact';
                const threadId = `thread_${contactOrNum.replace(/\s+/g, '_')}`;
                const timestamp = Date.now();
                const text = body.text;

                console.log(`[SmsPlugin] Incoming SMS notification: ${contactOrNum} - "${text}"`);

                if (!this.threads.has(threadId)) {
                    this.threads.set(threadId, {
                        threadId: threadId,
                        address: contactOrNum,
                        contactName: contactOrNum,
                        lastMessage: text,
                        lastDate: timestamp,
                        messages: []
                    });
                }

                const thread = this.threads.get(threadId);
                thread.lastMessage = text;
                thread.lastDate = timestamp;

                const msgObj = {
                    id: body.id || `sms_${timestamp}`,
                    threadId: threadId,
                    address: contactOrNum,
                    body: text,
                    date: timestamp,
                    type: 1 // Incoming
                };

                if (!thread.messages.some((m) => m.id === msgObj.id || (m.body === msgObj.body && Math.abs(m.date - msgObj.date) < 2000))) {
                    thread.messages.push(msgObj);
                    thread.messages.sort((a, b) => a.date - b.date);
                }

                if (this.emitter) {
                    this.emitter.emit('smsThreadsUpdated', this.getThreadsList());
                }
                this.saveCache();
            }
        }
    }

    sendSms(device, phoneNumber, messageText) {
        if (!device || !phoneNumber || !messageText) return false;

        const smsPacket = {
            id: Date.now(),
            type: 'kdeconnect.sms.request',
            body: {
                sendSms: true,
                phoneNumber: phoneNumber,
                messageBody: messageText
            }
        };

        const threadId = `thread_${phoneNumber.replace(/\s+/g, '_')}`;
        const timestamp = Date.now();

        if (!this.threads.has(threadId)) {
            this.threads.set(threadId, {
                threadId: threadId,
                address: phoneNumber,
                contactName: phoneNumber,
                lastMessage: messageText,
                lastDate: timestamp,
                messages: []
            });
        }

        const thread = this.threads.get(threadId);
        thread.lastMessage = messageText;
        thread.lastDate = timestamp;

        thread.messages.push({
            id: `sms_sent_${timestamp}`,
            threadId: threadId,
            address: phoneNumber,
            body: messageText,
            date: timestamp,
            type: 2 // Outgoing
        });

        if (this.emitter) {
            this.emitter.emit('smsThreadsUpdated', this.getThreadsList());
        }
        this.saveCache();

        console.log(`[SmsPlugin] Sending SMS to ${phoneNumber} via ${device.info.name}: "${messageText}"`);
        return device.sendPacket(smsPacket);
    }

    requestAllThreads(device) {
        if (!device) return false;

        console.log(`[SmsPlugin] Requesting SMS conversation list from ${device.info.name}`);

        // Modern KDE Connect protocol: "request the most-recent message in every conversation".
        // Current kdeconnect-android builds no longer answer "requestConversationTable" packets
        // (they treat every kdeconnect.sms.request as a send request), so this dedicated packet
        // type is required.
        return device.sendPacket({
            id: Date.now(),
            type: 'kdeconnect.sms.request_conversations',
            body: {}
        });
    }

    requestThreadMessages(device, threadId) {
        if (!device || threadId === undefined || threadId === null) return false;

        // Only real phone threads (numeric thread ids) can be fetched. Synthetic threads
        // created from SMS notifications / optimistic sends have no counterpart on the device.
        const numericThreadId = Number(threadId);
        if (!Number.isFinite(numericThreadId)) return false;

        const requestPacket = {
            id: Date.now(),
            type: 'kdeconnect.sms.request_conversation',
            body: {
                threadID: numericThreadId
            }
        };

        console.log(`[SmsPlugin] Requesting full thread history for thread ${numericThreadId} from ${device.info.name}`);
        return device.sendPacket(requestPacket);
    }

    saveCache() {
        try {
            const data = JSON.stringify(Array.from(this.threads.entries()));
            fs.writeFileSync(this.cacheFile, data, 'utf8');
        } catch (e) {
            console.error('[SmsPlugin] Failed to save SMS cache:', e.message);
        }
    }

    loadCache() {
        try {
            if (fs.existsSync(this.cacheFile)) {
                const data = fs.readFileSync(this.cacheFile, 'utf8');
                const entries = JSON.parse(data);
                this.threads = new Map(entries);
                console.log(`[SmsPlugin] Loaded ${this.threads.size} threads from persistent cache.`);
            }
        } catch (e) {
            console.warn('[SmsPlugin] Failed to load SMS cache:', e.message);
        }
    }

    getThreadsList() {
        const list = Array.from(this.threads.values());
        list.sort((a, b) => b.lastDate - a.lastDate);
        return list;
    }
}

module.exports = SmsPlugin;
