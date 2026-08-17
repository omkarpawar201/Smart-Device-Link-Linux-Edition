const BasePlugin = require('./BasePlugin');

function getFriendlyAppName(pkg) {
    if (!pkg) return 'Android App';
    const mappings = {
        'com.apple.android.music': 'Apple Music',
        'com.spotify.music': 'Spotify',
        'com.google.android.youtube': 'YouTube',
        'com.google.android.apps.youtube.music': 'YouTube Music',
        'com.amazon.mp3': 'Amazon Music',
        'com.soundcloud.android': 'SoundCloud',
        'com.pandora.android': 'Pandora',
        'org.videolan.vlc': 'VLC',
        'com.miui.player': 'Mi Music',
        'com.sec.android.app.music': 'Samsung Music',
        'com.jio.myjio': 'MyJio',
        'com.whatsapp': 'WhatsApp',
        'com.instagram.android': 'Instagram',
        'com.facebook.katana': 'Facebook',
        'com.facebook.orca': 'Messenger',
        'com.twitter.android': 'Twitter / X',
        'com.snapchat.android': 'Snapchat',
        'com.reddit.frontpage': 'Reddit',
        'com.android.chrome': 'Chrome',
        'org.mozilla.firefox': 'Firefox',
        'com.google.android.gm': 'Gmail',
        'com.google.android.apps.messaging': 'Google Messages',
        'com.android.phone': 'Phone',
        'com.android.server.telecom': 'Phone Call'
    };
    if (mappings[pkg]) return mappings[pkg];
    if (pkg.includes('.')) {
        const parts = pkg.split('.');
        const last = parts[parts.length - 1];
        if (last === 'myjio') return 'MyJio';
        return last.charAt(0).toUpperCase() + last.slice(1);
    }
    return pkg;
}

class NotificationPlugin extends BasePlugin {
    constructor(eventEmitter) {
        super('NotificationPlugin');
        this.emitter = eventEmitter;
        this.notifications = new Map(); // id -> notification object
        this.dismissedSignatures = new Map(); // notifId -> "title|text"
    }

    getCapabilities() {
        return ['kdeconnect.notification', 'kdeconnect.notification.request', 'kdeconnect.notification.action'];
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

            const packageName = body.packageName || '';
            let appName = body.appName || '';
            if (!appName || appName === packageName || appName.includes('.')) {
                appName = getFriendlyAppName(packageName);
            }

            const notifData = {
                id: notifId,
                deviceId: device.info.id,
                appName: appName,
                packageName: packageName,
                title: title,
                text: text,
                ticker: body.ticker || '',
                time: Date.now(),
                requestReplyId: body.requestReplyId || null,
                // Non-reply action buttons (like / archive / mark-read, etc.) as
                // [{key,label}] — rendered on the notification card (Phase 7).
                actions: Array.isArray(body.actions) ? body.actions : [],
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

    // Trigger one of the phone's notification action buttons (Phase 7).
    sendNotificationAction(device, requestId, actionKey) {
        if (!device || !requestId || !actionKey) return false;

        const actionPacket = {
            id: Date.now(),
            type: 'kdeconnect.notification.action',
            body: {
                requestId: requestId,
                actionKey: actionKey
            }
        };

        console.log(`[NotificationPlugin] Sending notification action "${actionKey}" to ${device.info.name}`);
        return device.sendPacket(actionPacket);
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
