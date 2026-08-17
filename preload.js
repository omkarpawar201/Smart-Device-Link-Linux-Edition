const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Expose protected window.api object to React renderer process
contextBridge.exposeInMainWorld('api', {
    // Window Control Actions
    minimizeWindow: () => ipcRenderer.send('window-minimize'),
    maximizeWindow: () => ipcRenderer.send('window-maximize'),
    closeWindow: () => ipcRenderer.send('window-close'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // Event Listeners for Device/System Events
    onDeviceStatusChanged: (callback) => {
        ipcRenderer.on('device-status-changed', (event, data) => callback(data));
    },
    onDiscoveredDevicesChanged: (callback) => {
        ipcRenderer.on('discovered-devices-changed', (event, data) => callback(data));
    },
    onPairingRequested: (callback) => {
        ipcRenderer.on('pairing-requested', (event, data) => callback(data));
    },
    onNotificationReceived: (callback) => {
        ipcRenderer.on('notification-received', (event, data) => callback(data));
    },
    onNotificationDismissed: (callback) => {
        ipcRenderer.on('notification-dismissed', (event, data) => callback(data));
    },
    onClipboardReceived: (callback) => {
        ipcRenderer.on('clipboard-received', (event, data) => callback(data));
    },
    onMediaStateChanged: (callback) => {
        ipcRenderer.on('media-state-changed', (event, data) => callback(data));
    },
    onPcMediaRequest: (callback) => {
        ipcRenderer.on('pc-media-request', (event, data) => callback(data));
    },
    onPcMediaState: (callback) => {
        ipcRenderer.on('pc-media-state', (event, data) => callback(data));
    },
    onIncomingCall: (callback) => {
        ipcRenderer.on('incoming-call', (event, data) => callback(data));
    },
    onCallIncoming: (callback) => {
        ipcRenderer.on('call:incoming', (event, data) => callback(data));
    },
    onCallState: (callback) => {
        ipcRenderer.on('call:state', (event, data) => callback(data));
    },
    onPhoneLinkState: (callback) => {
        ipcRenderer.on('phone-link:state', (event, data) => callback(data));
    },
    onPhoneLinkReady: (callback) => {
        ipcRenderer.on('phone-link:ready', (event, data) => callback(data));
    },
    onPhoneLinkError: (callback) => {
        ipcRenderer.on('phone-link:error', (event, data) => callback(data));
    },
    onPhoneLinkPong: (callback) => {
        ipcRenderer.on('phone-link:pong', (event, data) => callback(data));
    },
    onCallTalking: (callback) => {
        ipcRenderer.on('call-talking', (event, data) => callback(data));
    },
    onCallEnded: (callback) => {
        ipcRenderer.on('call-ended', (event, data) => callback(data));
    },
    onMissedCall: (callback) => {
        ipcRenderer.on('missed-call', (event, data) => callback(data));
    },
    onSmsThreadsUpdated: (callback) => {
        ipcRenderer.on('sms-threads-updated', (event, data) => callback(data));
    },
    onContactsUpdated: (callback) => {
        ipcRenderer.on('contacts-updated', (event, data) => callback(data));
    },
    onPhotosUpdated: (callback) => {
        ipcRenderer.on('photos-updated', (event, data) => callback(data));
    },
    onUploadProgress: (callback) => {
        ipcRenderer.on('upload-progress', (event, data) => callback(data));
    },
    onMirrorStatus: (callback) => {
        ipcRenderer.on('mirror:status', (event, data) => callback(data));
    },
    onWebcamStatus: (callback) => {
        ipcRenderer.on('webcam:status', (event, data) => callback(data));
    },
    onWebcamFrame: (callback) => {
        ipcRenderer.on('webcam:frame', (event, data) => callback(data));
    },
    onWebcamDriverStatus: (callback) => {
        ipcRenderer.on('webcam:driver-status', (event, data) => callback(data));
    },
    onSystemWarning: (callback) => {
        ipcRenderer.on('system-warning', (event, data) => callback(data));
    },

    // Resolve an absolute filesystem path for a File object from a drag/drop or file input
    // (Electron removed File.path; this is the supported replacement).
    getPathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file);
        } catch (e) {
            return '';
        }
    },

    // General IPC Send / Invoke Bridge
    send: (channel, data) => {
        const validChannels = [
            'send-reply',
            'send-notification-action',
            'dismiss-notification',
            'clear-all-notifications',
            'send-clipboard',
            'set-clipboard-auto-sync',
            'clear-clipboard-history',
            'remove-clipboard-item',
            'set-pc-clipboard',
            'media-control',
            'pc-media-state-changed',
            'pc-media-command',
            'ring-phone',
            'send-sms',
            'fetch-sms-threads',
            'fetch-sms-thread-messages',
            'fetch-contacts',
            'share-url',
            'dial-number',
            'mute-ringer',
            'simulate-call',
            'download-file',
            'upload-file',
            'delete-file',
            'scan-photos',
            'answer-call-audio',
            'hangup-call-audio',
            'toggle-mute-audio',
            'transfer-call-audio',
            'audio:set-mic-source',
            'audio:set-mic-gain',
            'phone-link:connect',
            'phone-link:disconnect',
            'phone-link:ping',
            'mirror:start',
            'mirror:stop',
            'mirror:move-window',
            'mirror:focus-window',
            'webcam:start',
            'webcam:stop'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        }
    },
    invoke: (channel, data) => {
        const validChannels = [
            'get-discovered-devices',
            'pair-device',
            'accept-pair',
            'unpair-device',
            'fetch-files',
            'list-storage-roots',
            'create-directory',
            'get-notifications',
            'get-sms-threads',
            'get-contacts',
            'get-photos',
            'get-clipboard-history',
            'get-clipboard-auto-sync',
            'phone-link:list-devices',
            'mirror:list-devices',
            'mirror:status',
            'mirror:embed-window',
            'mirror:get-size',
            'mirror:get-rect',
            'mirror:screenshot',
            'webcam:driver-status',
            'webcam:install-driver',
            'webcam:uninstall-driver',
            'webcam:status',
            'webcam:snapshot',
            'webcam:toggle-camera',
            'audio:list-mic-sources',
            'audio:get-mic-state',
            'get-settings',
            'save-settings'
        ];
        if (validChannels.includes(channel)) {
            return ipcRenderer.invoke(channel, data);
        }
        return Promise.reject(new Error(`Invalid IPC invoke channel: ${channel}`));
    }
});
