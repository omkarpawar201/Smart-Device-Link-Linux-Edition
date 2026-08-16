const BasePlugin = require('./BasePlugin');

class NotificationPlugin extends BasePlugin {
    constructor(eventEmitter) {
        super('NotificationPlugin');
        this.emitter = eventEmitter;
        this.notifications = new Map(); // id -> notification object
        this.dismissedSignatures = new Map(); // notifId -> "title|text"
    }

    getCapabilities() {
        return ['kdeconnect.notification', 'kdeconnect.notification.request'];
    }

    handlePacket(device, packet) {
        if (packet.type === 'kdeconnect.notification') {
            const body = packet.body || {};

            if (body.isCancel) {
                // Notification dismissed on phone
                this.notifications.delete(body.id);
                if (body.id) this.dismissedSignatures.delete(body.id);
                if (this.emitter) {
                    this.emitter.emit('notificationDismissed', { id: body.id, deviceId: device.info.id });
                }
                return;
            }

            const notifId = body.id || `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            const title = body.title || 'Notification';
            const text = body.text || body.ticker || '';
            const signature = `${title}|${text}`;

            // If this exact notification content was already dismissed, ignore duplicate re-sync
            if (this.dismissedSignatures.get(notifId) === signature) {
                return;
            }

            // Fresh content or updated text: clear old signature
            this.dismissedSignatures.delete(notifId);

            const notifData = {
                id: notifId,
                deviceId: device.info.id,
                appName: body.appName || 'Android App',
                packageName: body.packageName || '',
                title: title,
                text: text,
                ticker: body.ticker || '',
                time: Date.now(),
                requestReplyId: body.requestReplyId || null,
                isClearable: body.isClearable !== false,
                silent: body.silent || false
            };

            this.notifications.set(notifData.id, notifData);

            if (this.emitter) {
                this.emitter.emit('notificationReceived', notifData);
                const appLower = (notifData.appName || '').toLowerCase();
                const pkgLower = (notifData.packageName || '').toLowerCase();
                const isSmsApp = appLower.includes('message') || appLower.includes('sms') || appLower.includes('messaging')
                    || pkgLower.includes('messaging') || pkgLower.includes('mms') || pkgLower.includes('sms') || pkgLower.includes('messages');
                if (isSmsApp) {
                    this.emitter.emit('smsNotificationReceived', notifData);
                }
            }
        }
    }

    replyToNotification(device, requestReplyId, replyText) {
        if (!device || !requestReplyId || !replyText) return false;

        const replyPacket = {
            id: Date.now(),
            type: 'kdeconnect.notification.reply',
            body: {
                requestReplyId: requestReplyId,
                message: replyText
            }
        };

        console.log(`[NotificationPlugin] Sending inline reply to ${device.info.name}: "${replyText}"`);
        return device.sendPacket(replyPacket);
    }

    dismissNotification(device, notificationId) {
        if (!notificationId) return false;

        const notif = this.notifications.get(notificationId);
        if (notif) {
            this.dismissedSignatures.set(notificationId, `${notif.title}|${notif.text}`);
        }
        this.notifications.delete(notificationId);

        if (device) {
            const dismissPacket = {
                id: Date.now(),
                type: 'kdeconnect.notification',
                body: {
                    id: notificationId,
                    isCancel: true
                }
            };
            console.log(`[NotificationPlugin] Dismissing notification ${notificationId} on ${device.info.name}`);
            return device.sendPacket(dismissPacket);
        }
        return true;
    }

    clearAllNotifications(device) {
        for (const [notifId, notif] of this.notifications.entries()) {
            this.dismissedSignatures.set(notifId, `${notif.title}|${notif.text}`);
            if (device) {
                const dismissPacket = {
                    id: Date.now(),
                    type: 'kdeconnect.notification',
                    body: { id: notifId, isCancel: true }
                };
                device.sendPacket(dismissPacket);
            }
        }
        this.notifications.clear();
    }

    requestAllNotifications(device) {
        if (!device) return false;

        const requestPacket = {
            id: Date.now(),
            type: 'kdeconnect.notification.request',
            body: { request: true }
        };

        return device.sendPacket(requestPacket);
    }

    getNotifications() {
        return Array.from(this.notifications.values());
    }
}

module.exports = NotificationPlugin;
