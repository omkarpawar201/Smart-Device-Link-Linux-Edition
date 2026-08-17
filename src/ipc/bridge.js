const { ipcMain, app, protocol, clipboard: electronClipboard, screen } = require('electron');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const CryptoHelper = require('../kdeconnect/CryptoHelper');
const DeviceManager = require('../kdeconnect/DeviceManager');
const Device = require('../kdeconnect/Device');
const PacketRouter = require('../kdeconnect/PacketRouter');
const PairingManager = require('../kdeconnect/PairingManager');

// Phase 3 Plugins
const NotificationPlugin = require('../kdeconnect/plugins/NotificationPlugin');
const BatteryPlugin = require('../kdeconnect/plugins/BatteryPlugin');
const ConnectivityPlugin = require('../kdeconnect/plugins/ConnectivityPlugin');
const ClipboardPlugin = require('../kdeconnect/plugins/ClipboardPlugin');
const MprisPlugin = require('../kdeconnect/plugins/MprisPlugin');
const FindMyPhonePlugin = require('../kdeconnect/plugins/FindMyPhonePlugin');
const RunCommandPlugin = require('../kdeconnect/plugins/RunCommandPlugin');

// Phase 4 Plugins
const TelephonyPlugin = require('../kdeconnect/plugins/TelephonyPlugin');
const SmsPlugin = require('../kdeconnect/plugins/SmsPlugin');
const ContactsPlugin = require('../kdeconnect/plugins/ContactsPlugin');
const SharePlugin = require('../kdeconnect/plugins/SharePlugin');

// Phase 5 Plugins
const SftpPlugin = require('../kdeconnect/plugins/SftpPlugin');

// Real PC media session control (system media keys + master volume)
const PcMediaController = require('../system/PcMediaController');

// Phase 6 Custom RFCOMM Link Engine & Audio Bridge
const RfcommClient = require('../bluetooth/RfcommClient');
const RfcommProtocol = require('../bluetooth/RfcommProtocol');
const AudioBridge = require('../audio/AudioBridge');

// Phase 7 Screen Mirroring (scrcpy wrapper)
const ScrcpyMirrorManager = require('../mirror/ScrcpyMirrorManager');

// Phase 7 Phone-as-webcam (IP Webcam + UnityCapture virtual camera)
const WebcamManager = require('../webcam/WebcamManager');
const adb = require('../webcam/adb');

let cryptoHelper = null;
let deviceManager = null;
let packetRouter = null;
let pairingManager = null;
let activeDeviceConnections = new Map(); // deviceId -> Device instance
let currentMainWindow = null;

// Phase 6 Engine Instances
let rfcommClient = null;
let rfcommProtocol = null;
let audioBridge = null;

// Phase 7 Mirror Engine
let scrcpyMirror = null;
let mirrorEmbeddedMode = false;

// Phase 7 Webcam Engine
let webcam = null;
let webcamForwardPort = null; // USB source: host port forwarded to the phone

// Authoritative CSS-px -> physical-px scale for the main window's display.
// Prefer Electron's screen module over the renderer-reported devicePixelRatio,
// which can be stale/wrong in mixed-DPI setups.
function windowScale(win) {
    try {
        if (!win || win.isDestroyed()) return null;
        const bounds = win.getBounds();
        const display = screen.getDisplayMatching(bounds);
        return (display && display.scaleFactor) || null;
    } catch (e) {
        return null;
    }
}

function parentHwndOf(win) {
    try {
        const raw = win.getNativeWindowHandle();
        return raw.length >= 8 ? raw.readBigUInt64LE(0).toString() : raw.readUInt32LE(0).toString();
    } catch (e) {
        return null;
    }
}

// Reads the phone-model "hole" rect straight from the renderer DOM. Runs via
// executeJavaScript so it is not affected by renderer timer throttling while
// scrcpy's window has focus.
async function holeRectFromRenderer(webContents) {
    try {
        if (!webContents || webContents.isDestroyed()) return null;
        const rect = await webContents.executeJavaScript(
            `(() => {
                const el = document.querySelector('[data-mirror-hole]');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.left, y: r.top, width: r.width, height: r.height };
            })()`,
            true
        );
        return rect && Number.isFinite(rect.x) ? rect : null;
    } catch (e) {
        return null;
    }
}

// On Linux the borderless scrcpy window is positioned in ABSOLUTE screen
// coordinates (no Win32 SetParent), so a renderer viewport rect must be offset
// by the app window's own origin. Returns physical px, consistent with the
// Windows path which multiplies the viewport rect by the display scale.
function toLinuxScreenRect(win, rect, dpr) {
    try {
        const sf = windowScale(win) || dpr || 1;
        const bounds = win.getContentBounds();
        const px = (v) => Math.max(0, Math.round((v || 0) * sf));
        return {
            x: px((bounds ? bounds.x : 0) + (rect && rect.x || 0)),
            y: px((bounds ? bounds.y : 0) + (rect && rect.y || 0)),
            width: px(rect && rect.width),
            height: px(rect && rect.height)
        };
    } catch (e) {
        return null;
    }
}

// Viewport rect -> physical px for the Windows parent-relative path.
function toWindowRect(win, rect, dpr) {
    const scale = windowScale(win) || dpr || 1;
    const px = (v) => Math.max(0, Math.round((v || 0) * scale));
    return {
        x: px(rect && rect.x),
        y: px(rect && rect.y),
        width: Math.max(1, px(rect && rect.width)),
        height: Math.max(1, px(rect && rect.height))
    };
}

// Resolves a renderer viewport rect into the coordinate space the scrcpy
// window is positioned in (parent-relative on Windows, absolute on Linux).
function resolveMirrorRect(win, rect, dpr) {
    if (scrcpyMirror && scrcpyMirror._linux) {
        return toLinuxScreenRect(win, rect, dpr) || toWindowRect(win, rect, dpr);
    }
    return toWindowRect(win, rect, dpr);
}

// Docks the borderless scrcpy window into the phone-model hole. Called from the
// main process so it works regardless of renderer focus/throttling, and again on
// every running status so auto-restarts get re-docked too. Retries because the
// scrcpy window can appear later than the running status (esp. at higher FPS).
async function autoDockMirror() {
    if (!scrcpyMirror || !currentMainWindow) return;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let attempt = 1; attempt <= 4; attempt++) {
        if (!scrcpyMirror.running) return;
        try {
            const rect = await holeRectFromRenderer(currentMainWindow.webContents);
            if (!rect) {
                console.warn(`[Bridge] auto-dock: no hole rect (attempt ${attempt})`);
                await sleep(1500);
                continue;
            }
            const target = resolveMirrorRect(currentMainWindow, rect, null);
            const hwnd = await scrcpyMirror.embedWindow(parentHwndOf(currentMainWindow), target);
            if (hwnd) {
                console.log(`[Bridge] auto-dock: docked scrcpy window ${hwnd}`);
                // Tell the renderer the mirror is docked so it can stop showing
                // the "Docking live mirror…" placeholder.
                if (currentMainWindow && !currentMainWindow.isDestroyed()) {
                    currentMainWindow.webContents.send('mirror:status', scrcpyMirror.getStatus());
                }
                return;
            }
            console.warn(`[Bridge] auto-dock: window not found yet (attempt ${attempt})`);
        } catch (e) {
            console.warn(`[Bridge] auto-dock attempt ${attempt} failed:`, e.message);
        }
        await sleep(1500);
    }
    console.warn('[Bridge] auto-dock: gave up after 4 attempts');
}

// Plugin Instances
let notificationPlugin = null;
let batteryPlugin = null;
let connectivityPlugin = null;
let clipboardPlugin = null;
let mprisPlugin = null;
let findMyPhonePlugin = null;
let runCommandPlugin = null;
let telephonyPlugin = null;
let smsPlugin = null;
let contactsPlugin = null;
let sharePlugin = null;
let sftpPlugin = null;

// Real PC media session controller (win32 only)
let pcMediaController = null;
let lastPcVolume = null;

function setMainWindow(win) {
    currentMainWindow = win;
}

function initKDEConnectBridge(mainWindow) {
    currentMainWindow = mainWindow;
    console.log('[KDEConnect Bridge] Initializing Protocol Engine & All Feature Plugins...');

    const pluginEvents = new EventEmitter();

    cryptoHelper = new CryptoHelper();
    deviceManager = new DeviceManager(cryptoHelper);
    packetRouter = new PacketRouter();
    pairingManager = new PairingManager(packetRouter, cryptoHelper);

    // Phase 6 Bluetooth & Audio Setup
    const rfcommBridge = process.platform === 'win32'
        ? path.join(__dirname, '..', 'bluetooth', 'rfcomm-bridge.ps1')
        : path.join(__dirname, '..', 'bluetooth', 'rfcomm-listen.py');
    rfcommClient = new RfcommClient({
        bridgeScript: rfcommBridge,
        configPath: path.join(app.getPath('userData'), 'phone-link.json')
    });
    rfcommProtocol = new RfcommProtocol(rfcommClient);
    audioBridge = new AudioBridge();
    // HFP audio routing (Linux) needs the phone's Bluetooth MAC; pull it from
    // the RFCOMM link config and keep it updated as the phone reconnects.
    audioBridge.setPhoneMac(rfcommClient.getPhoneMac());
    rfcommClient.on('connected', ({ mac } = {}) => {
        if (mac) audioBridge.setPhoneMac(mac);
    });
    scrcpyMirror = new ScrcpyMirrorManager();
    webcam = new WebcamManager();

    // Phone-link presence: engine is only alive while the RFCOMM link is up
    rfcommProtocol.on('linkUp', () => {
        console.log('[RfcommProtocol] Link established');
        currentMainWindow?.webContents.send('phone-link:state', { connected: true });
        currentMainWindow?.webContents.send('presence:update');
    });
    rfcommProtocol.on('linkDown', () => {
        console.log('[RfcommProtocol] Link down');
        currentMainWindow?.webContents.send('phone-link:state', { connected: false });
        currentMainWindow?.webContents.send('presence:update');
    });
    rfcommProtocol.on('linkReady', () => {
        currentMainWindow?.webContents.send('phone-link:ready');
    });
    rfcommClient.on('error', ({ code, message }) => {
        console.warn(`[RfcommClient] error ${code}:`, message);
        currentMainWindow?.webContents.send('phone-link:error', { code, message });
    });

    // Real PC media session control (Windows-only; falls back to optimistic state if unavailable)
    if (process.platform === 'win32' || process.platform === 'linux') pcMediaController = new PcMediaController();

    // Instantiate Plugins
    notificationPlugin = new NotificationPlugin(pluginEvents);
    batteryPlugin = new BatteryPlugin(pluginEvents);
    connectivityPlugin = new ConnectivityPlugin(pluginEvents);
    clipboardPlugin = new ClipboardPlugin(pluginEvents);
    mprisPlugin = new MprisPlugin(pluginEvents);
    findMyPhonePlugin = new FindMyPhonePlugin(pluginEvents);
    runCommandPlugin = new RunCommandPlugin(pluginEvents);
    telephonyPlugin = new TelephonyPlugin(pluginEvents);
    smsPlugin = new SmsPlugin(pluginEvents);
    contactsPlugin = new ContactsPlugin(pluginEvents);
    sharePlugin = new SharePlugin(pluginEvents);
    sftpPlugin = new SftpPlugin(pluginEvents);

    // Register Plugins in PacketRouter
    packetRouter.registerPlugin(notificationPlugin);
    packetRouter.registerPlugin(batteryPlugin);
    packetRouter.registerPlugin(connectivityPlugin);
    packetRouter.registerPlugin(clipboardPlugin);
    packetRouter.registerPlugin(mprisPlugin);
    packetRouter.registerPlugin(findMyPhonePlugin);
    packetRouter.registerPlugin(runCommandPlugin);
    packetRouter.registerPlugin(telephonyPlugin);
    packetRouter.registerPlugin(smsPlugin);
    packetRouter.registerPlugin(contactsPlugin);
    packetRouter.registerPlugin(sharePlugin);
    packetRouter.registerPlugin(sftpPlugin);

    // Start UDP discovery
    deviceManager.startDiscovery();

    // Surface fatal engine problems (e.g. port 1716 held by the native KDE Connect
    // daemon on Linux) to the renderer so the user sees an actionable warning.
    deviceManager.on('fatalError', (info) => {
        console.error('[Bridge] ' + (info.message || info.code));
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('system-warning', info);
        }
    });

    // Some phone players (e.g. Apple Music) don't push volume changes to KDE Connect,
    // so poll the current player's now-playing + volume so the PC app's volume bar stays
    // in sync even when the volume is changed on the phone itself.
    setInterval(() => {
        const activeDev = getFirstActiveDevice();
        if (activeDev && mprisPlugin) mprisPlugin.refreshCurrentPlayer(activeDev);
    }, 4000);

    // Forward Discovered Devices to UI
    const outboundRetryWindow = new Map(); // deviceId -> last outbound attempt (ms)

    const autoConnectPairedDevice = (deviceInfo) => {
        if (!deviceInfo || !deviceInfo.id) return;
        if (pairingManager.isPaired(deviceInfo.id) !== true) return;

        // Nudge the phone to open a connection to us: the phone's udpPacketReceived
        // reacts to ANY identity packet (broadcast or unicast). A unicast to its IP
        // is more reliable than a subnet broadcast, which some routers drop.
        if (deviceManager.sendIdentityToIp) {
            deviceManager.sendIdentityToIp(deviceInfo.ip);
        }

        if (activeDeviceConnections.has(deviceInfo.id)) return;

        // The phone normally connects to us on its own whenever it receives our
        // UDP broadcast. Give it a moment to do that before we try the outbound
        // fallback, and never retry outbound more often than every 10s.
        const lastAttempt = outboundRetryWindow.get(deviceInfo.id) || 0;
        if (Date.now() - lastAttempt < 10000) return;
        outboundRetryWindow.set(deviceInfo.id, Date.now());

        setTimeout(() => {
            if (activeDeviceConnections.has(deviceInfo.id)) return;
            const latest = deviceManager.discoveredDevices.get(deviceInfo.id);
            if (!latest) return;
            console.log(`[Bridge] Connecting to paired device ${latest.name}...`);
            connectToDevice(latest, currentMainWindow);
        }, 3000);
    };

    deviceManager.on('deviceDiscovered', (deviceInfo) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('discovered-devices-changed', deviceManager.getDiscoveredDevices());
        }
        autoConnectPairedDevice(deviceInfo);
    });

    // Self-heal reconnects: after a disconnect (e.g. Wi-Fi drop), the phone keeps
    // broadcasting its identity over UDP. Whenever we hear from a paired device
    // that isn't connected, actively re-establish the link instead of waiting
    // passively for the phone to connect to us.
    deviceManager.on('deviceUpdated', (deviceInfo) => {
        autoConnectPairedDevice(deviceInfo);
    });


    // Handle incoming connections initiated from phone
    deviceManager.on('incomingConnection', ({ tlsSocket, identityPacket }) => {
        const deviceId = identityPacket?.body?.deviceId;
        const deviceName = identityPacket?.body?.deviceName || 'Android Device';

        if (!deviceId) {
            console.warn('[Bridge] Incoming TLS connection missing deviceId');
            return;
        }

        console.log(`[Bridge] Incoming TLS Connection accepted from ${tlsSocket.remoteAddress} (${deviceName})`);

        let tempDev = activeDeviceConnections.get(deviceId);
        const isReused = !!tempDev;

        if (tempDev) {
            console.log(`[Bridge] Reusing connection for ${deviceName} (${deviceId})`);
            const oldSocket = tempDev.socket;
            tempDev.socket = null;
            tempDev.buffer = Buffer.alloc(0);

            if (oldSocket) {
                oldSocket.removeAllListeners();
                oldSocket.on('error', () => { });
                const teardownTimer = setTimeout(() => oldSocket.destroy(), 1000);
                oldSocket.once('close', () => clearTimeout(teardownTimer));
                try {
                    oldSocket.end();
                } catch (e) {
                    oldSocket.destroy();
                }
            }
            tempDev.info.ip = tlsSocket.remoteAddress;
            tempDev.info.name = deviceName;
        } else {
            tempDev = new Device({
                id: deviceId,
                ip: tlsSocket.remoteAddress,
                port: identityPacket?.body?.tcpPort || 1716,
                name: deviceName,
                type: identityPacket?.body?.deviceType || 'phone',
                protocolVersion: identityPacket?.body?.protocolVersion || 7,
                incomingCapabilities: identityPacket?.body?.incomingCapabilities || [],
                outgoingCapabilities: identityPacket?.body?.outgoingCapabilities || []
            }, cryptoHelper);

            tempDev.on('packet', (packet, payload) => {
                if (packet.type === 'kdeconnect.identity') {
                    tempDev.info.id = packet.body.deviceId;
                    tempDev.info.name = packet.body.deviceName || 'Android Device';
                    console.log(`[Bridge] Authenticated connection from ${tempDev.info.name} (${tempDev.info.id})`);
                } else {
                    packetRouter.routePacket(tempDev, packet, payload);
                }
            });

            activeDeviceConnections.set(deviceId, tempDev);
        }

        if (!tempDev.hasDisconnectListener) {
            tempDev.hasDisconnectListener = true;
            tempDev.on('disconnected', () => {
                console.log(`[Bridge] Device ${tempDev.info.name} disconnected.`);
                activeDeviceConnections.delete(deviceId);
                if (currentMainWindow && !currentMainWindow.isDestroyed()) {
                    currentMainWindow.webContents.send('device-status-changed', {
                        connected: false,
                        wifi: false,
                        bluetooth: false,
                        signal: 0,
                        networkType: 'Offline'
                    });
                }
            });
        }

        tempDev.socket = tlsSocket;
        tempDev.connected = true;
        tempDev.lastPacketAt = Date.now();
        tempDev.isPaired = pairingManager.isPaired(deviceId);
        tempDev.cancelPendingDisconnect();
        tempDev.startHeartbeat();

        tlsSocket.setKeepAlive(true, 3000);
        tlsSocket.setEncoding('utf8');
        tlsSocket.on('data', (data) => tempDev.handleRawData(data));
        tlsSocket.on('close', () => tempDev.handleDisconnect('Socket closed'));
        tlsSocket.on('error', (err) => tempDev.handleDisconnect(err.message));

        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('device-status-changed', {
                name: tempDev.info.name,
                connected: true,
                wifi: true,
                isPaired: pairingManager.isPaired(deviceId)
            });
        }

        // Start the RFCOMM phone link alongside the incoming Wi-Fi connection
        if (rfcommClient && !rfcommClient.connected && !rfcommClient.connecting) {
            rfcommClient.connect();
        }

        // Request battery, connectivity, notifications, SMS threads, and contacts on initial connection
        if (batteryPlugin) batteryPlugin.requestBatteryStatus(tempDev);
        if (connectivityPlugin) connectivityPlugin.requestReport(tempDev);
        if (mprisPlugin) mprisPlugin.requestMediaState(tempDev);
        if (mprisPlugin) mprisPlugin.sendPcPlayerList(tempDev);
        if (!isReused) {
            if (notificationPlugin) notificationPlugin.requestAllNotifications(tempDev);
            if (smsPlugin) smsPlugin.requestAllThreads(tempDev);
            if (contactsPlugin) contactsPlugin.requestAllContacts(tempDev);
        }
    });


    const enrichDiscoveredDevices = (devicesList) => {
        if (!devicesList) return [];
        return devicesList.map((dev) => ({
            ...dev,
            isPaired: pairingManager ? pairingManager.isPaired(dev.id) : false,
            isConnected: activeDeviceConnections ? activeDeviceConnections.has(dev.id) : false
        }));
    };

    // Forward Discovered Devices to UI with paired/connected flags
    deviceManager.on('deviceDiscovered', () => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('discovered-devices-changed', enrichDiscoveredDevices(deviceManager.getDiscoveredDevices()));
        }
    });

    ipcMain.handle('get-discovered-devices', () => {
        if (deviceManager) {
            deviceManager.sendIdentityBroadcast();
            return enrichDiscoveredDevices(deviceManager.getDiscoveredDevices());
        }
        return [];
    });


    // Pairing Manager Events
    pairingManager.on('pairingRequested', (data) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('pairing-requested', data);
        }
    });

    // Keep each connection's heartbeat pairing-aware: the phone only answers
    // plugin pings (battery.request) once paired, so isPaired gates the timeout.
    pairingManager.on('devicePaired', (data) => {
        const dev = activeDeviceConnections.get(data.id);
        if (dev) dev.isPaired = true;
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('discovered-devices-changed', enrichDiscoveredDevices(deviceManager.getDiscoveredDevices()));
            currentMainWindow.webContents.send('device-status-changed', { isPaired: true });
        }
    });

    pairingManager.on('deviceUnpaired', (data) => {
        const dev = activeDeviceConnections.get(data.id);
        if (dev) dev.isPaired = false;
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('discovered-devices-changed', enrichDiscoveredDevices(deviceManager.getDiscoveredDevices()));
            currentMainWindow.webContents.send('device-status-changed', { isPaired: false });
        }
    });


    // Forward Notification Events
    pluginEvents.on('notificationReceived', (data) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('notification-received', data);
        }
    });

    pluginEvents.on('notificationDismissed', (data) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('notification-dismissed', data);
        }
    });

    ipcMain.handle('get-notifications', () => {
        return notificationPlugin ? notificationPlugin.getNotifications() : [];
    });

    ipcMain.on('clear-all-notifications', () => {
        if (notificationPlugin) {
            const activeDev = getFirstActiveDevice();
            notificationPlugin.clearAllNotifications(activeDev);
        }
    });


    pluginEvents.on('batteryStateChanged', (data) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) currentMainWindow.webContents.send('device-status-changed', { battery: data.charge, isCharging: data.isCharging });
    });

    pluginEvents.on('connectivityStateChanged', (data) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('device-status-changed', {
                signal: data.signalStrength,
                networkType: data.networkType || 'NA'
            });
        }
    });


    pluginEvents.on('clipboardReceived', (data) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) currentMainWindow.webContents.send('clipboard-received', data);
    });

    pluginEvents.on('mediaStateChanged', (data) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) currentMainWindow.webContents.send('media-state-changed', data);
    });

    pluginEvents.on('pcMediaRequest', (data) => {
        // Route phone -> PC control to the real system media session (media keys / master volume).
        const body = (data && data.body) || {};
        console.log('[bridge] phone -> PC media request:', JSON.stringify(body));
        handlePcMediaCommand(body);
        if (currentMainWindow && !currentMainWindow.isDestroyed()) currentMainWindow.webContents.send('pc-media-request', data);
        // Immediately re-read the real session so the phone sees the result of its control
        // (play/pause/track/seek) without waiting for the 2s poller.
        refreshPcMediaState();
    });

    pluginEvents.on('incomingCall', (data) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) currentMainWindow.webContents.send('incoming-call', data);
    });

    // Telephony call lifecycle events (from the phone via KDE Connect)
    pluginEvents.on('callTalking', (data) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) currentMainWindow.webContents.send('call-talking', data);
    });

    pluginEvents.on('callEnded', (data) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) currentMainWindow.webContents.send('call-ended', data);
    });

    pluginEvents.on('missedCall', (data) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) currentMainWindow.webContents.send('missed-call', data);
    });

    pluginEvents.on('smsThreadsUpdated', (data) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) currentMainWindow.webContents.send('sms-threads-updated', data);
    });

    pluginEvents.on('contactsUpdated', (data) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('contacts-updated', data);
        }
    });

    pluginEvents.on('smsNotificationReceived', (data) => {
        const activeDev = getFirstActiveDevice();
        if (smsPlugin && activeDev) {
            smsPlugin.handlePacket(activeDev, {
                type: 'kdeconnect.notification',
                body: {
                    appName: data.appName,
                    packageName: data.packageName,
                    title: data.title,
                    text: data.text,
                    id: data.id
                }
            });
        }
    });

    ipcMain.on('fetch-sms-thread-messages', (event, { threadId }) => {
        const activeDev = getFirstActiveDevice();
        if (activeDev && smsPlugin) smsPlugin.requestThreadMessages(activeDev, threadId);
    });


    // Call Control IPC Handlers (Accepts & Declines on BOTH Wi-Fi & Bluetooth)
    ipcMain.on('answer-call-audio', () => {
        const activeDev = getFirstActiveDevice();
        if (activeDev && telephonyPlugin) telephonyPlugin.acceptCall(activeDev);
        if (rfcommProtocol) rfcommProtocol.answerCall();
        if (audioBridge) audioBridge.startAudioRouting();
    });

    ipcMain.on('hangup-call-audio', () => {
        const activeDev = getFirstActiveDevice();
        if (activeDev && telephonyPlugin) telephonyPlugin.rejectCall(activeDev);
        if (rfcommProtocol) rfcommProtocol.hangupCall();
        if (audioBridge) audioBridge.stopAudioRouting();
    });

    ipcMain.on('decline-call', () => {
        const activeDev = getFirstActiveDevice();
        if (activeDev && telephonyPlugin) telephonyPlugin.rejectCall(activeDev);
        if (rfcommProtocol) rfcommProtocol.hangupCall();
        if (audioBridge) audioBridge.stopAudioRouting();
    });

    ipcMain.on('answer-call', () => {
        const activeDev = getFirstActiveDevice();
        if (activeDev && telephonyPlugin) telephonyPlugin.acceptCall(activeDev);
        if (rfcommProtocol) rfcommProtocol.answerCall();
        if (audioBridge) audioBridge.startAudioRouting();
    });

    ipcMain.on('toggle-mute-audio', (event, { muted }) => {
        audioBridge.setMicrophoneMuted(muted);
        rfcommProtocol.setMicMuted(muted);
    });

    ipcMain.handle('audio:list-mic-sources', async () => {
        if (!audioBridge) return [];
        return audioBridge.listPcMicrophones();
    });

    ipcMain.on('audio:set-mic-source', (event, { name } = {}) => {
        if (!audioBridge) return;
        audioBridge.setMicrophoneSource(name);
    });

    ipcMain.on('audio:set-mic-gain', (event, { percent } = {}) => {
        if (!audioBridge) return;
        audioBridge.setMicrophoneGain(percent);
    });

    ipcMain.handle('audio:get-mic-state', async () => {
        if (!audioBridge) return { source: null, gain: 100 };
        const gain = await audioBridge.getMicrophoneGain();
        return { source: audioBridge.getMicrophoneSource(), gain };
    });

    ipcMain.on('transfer-call-audio', (event, { target }) => {
        if (target === 'PHONE_EARPIECE') {
            audioBridge.transferCallAudioToPhone();
        } else {
            audioBridge.transferCallAudioToPc();
        }
    });

    ipcMain.on('dial-number', (event, { number }) => {
        console.log(`[Bridge] Dialing via RFCOMM: ${number}`);
        rfcommProtocol.dialNumber(number);
        audioBridge.startAudioRouting();
    });

    // New RFCOMM link engine events -> renderer (replaces HFP bridge's wires)
    rfcommProtocol.on('callRing', ({ number, name }) => {
        console.log(`[RfcommProtocol] callRing over RFCOMM: "${name || ''}" ${number || ''}`);
        currentMainWindow?.webContents.send('incoming-call', { status: 'RINGING', number, name });
        currentMainWindow?.webContents.send('call:incoming', { number, name, ringing: true });
    });
    rfcommProtocol.on('callState', ({ state, number, name }) => {
        console.log(`[RfcommProtocol] callState over RFCOMM: ${state} "${name || ''}" ${number || ''}`);
        currentMainWindow?.webContents.send('call:state', { state, number, name });
        if (state === 'talking') {
            // Drive the renderer through the same channels the KDE Connect
            // telephony path uses, so the DIY RFCOMM link works without it.
            currentMainWindow?.webContents.send('call-talking', { phoneNumber: number, contactName: name });
            audioBridge.startAudioRouting();
        } else if (state === 'ended') {
            currentMainWindow?.webContents.send('call-ended', { phoneNumber: number, contactName: name });
            audioBridge.stopAudioRouting();
        } else if (state === 'missed') {
            currentMainWindow?.webContents.send('missed-call', { phoneNumber: number, contactName: name });
            audioBridge.stopAudioRouting();
        }
    });

    // RFCOMM link control + discovery IPC
    ipcMain.on('phone-link:connect', (event, { mac, name } = {}) => {
        rfcommClient.connect({ mac, name });
    });
    ipcMain.on('phone-link:disconnect', () => {
        rfcommClient.disconnect();
        audioBridge.stopAudioRouting();
    });

    // Presence: recompute "last seen" using the phone-side link clock
    ipcMain.on('phone-link:ping', (event, { id }) => {
        let lastSeen = 0;
        if (rfcommProtocol.connected) lastSeen = rfcommProtocol.lastPongAt || Date.now();
        event.sender.send('phone-link:pong', { id, lastSeen });
    });

    // List paired classic-Bluetooth phones for the pairing UI
    ipcMain.handle('phone-link:list-devices', async () => {
        try {
            const devices = await rfcommClient.discoverPairedDevices();
            return { ok: true, devices };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // ===== Phase 7 Screen Mirroring (scrcpy) =====
    scrcpyMirror.on('status', (status) => {
        if (status.running && mirrorEmbeddedMode) {
            autoDockMirror();
        }
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('mirror:status', status);
        }
    });

    ipcMain.handle('mirror:list-devices', async () => {
        try {
            return await scrcpyMirror.listDevices();
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('mirror:status', () => {
        return scrcpyMirror.getStatus();
    });

    ipcMain.on('mirror:start', async (event, options = {}) => {
        try {
            // Embedded (docked) mode needs a unique title so embed-window.ps1 can
            // find the right scrcpy window by process + title.
            if (options.embedded && !options.windowTitle) {
                options.windowTitle = `DiyPhoneLink-Mirror-${Date.now()}`;
            }
            mirrorEmbeddedMode = !!options.embedded;
            // Pre-size scrcpy to the phone hole so its standalone window doesn't
            // flash huge before it is docked. On Linux the initial spawn is also
            // pre-positioned at the hole (absolute screen coords).
            if (options.embedded && options.embedRect) {
                const r = resolveMirrorRect(currentMainWindow, options.embedRect, null);
                options.embedWindowSize = {
                    width: Math.max(1, Math.round(r.width || 0)),
                    height: Math.max(1, Math.round(r.height || 0))
                };
                if (typeof r.x === 'number' && typeof r.y === 'number') {
                    options.windowPos = { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)) };
                }
            }
            const status = await scrcpyMirror.start(options);
            if (!event.sender.isDestroyed()) event.sender.send('mirror:status', status);
        } catch (e) {
            console.warn('[Bridge] mirror:start failed:', e.message);
            if (!event.sender.isDestroyed()) event.sender.send('mirror:status', { running: false, error: e.message });
        }
    });

    ipcMain.on('mirror:stop', () => {
        scrcpyMirror.stop();
    });

    // Docks the borderless scrcpy window into the phone-model placeholder in the renderer.
    ipcMain.handle('mirror:embed-window', async (event, { rect, dpr } = {}) => {
        if (!scrcpyMirror || !currentMainWindow) return { ok: false, error: 'mirror not ready' };
        try {
            const parentHwnd = parentHwndOf(currentMainWindow);
            if (!parentHwnd) return { ok: false, error: 'no window handle' };
            const target = resolveMirrorRect(currentMainWindow, rect, dpr);
            const hwnd = await scrcpyMirror.embedWindow(parentHwnd, target);
            return { ok: !!hwnd, hwnd };
        } catch (e) {
            console.warn('[Bridge] mirror:embed-window failed:', e.message);
            return { ok: false, error: e.message };
        }
    });

    ipcMain.on('mirror:move-window', async (event, { rect, dpr } = {}) => {
        if (!scrcpyMirror) return;
        try {
            const target = resolveMirrorRect(currentMainWindow, rect, dpr);
            await scrcpyMirror.moveWindow(target);
        } catch (e) {
            console.warn('[Bridge] mirror:move-window failed:', e.message);
        }
    });

    // Measured rect of the embedded window (parent-client PHYSICAL px) + the
    // scale used, so the renderer can overlay a diagnostic boundary.
    ipcMain.handle('mirror:get-rect', async () => {
        if (!scrcpyMirror || !currentMainWindow) return { ok: false };
        try {
            const rect = await scrcpyMirror.getWindowRect();
            if (!rect) return { ok: false };
            return {
                ok: true,
                rect,
                scale: windowScale(currentMainWindow) || 1
            };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.on('mirror:focus-window', async () => {
        if (!scrcpyMirror) return;
        try {
            await scrcpyMirror.focusWindow();
        } catch (e) {
            /* non-fatal */
        }
    });

    ipcMain.handle('mirror:get-size', async () => {
        if (!scrcpyMirror) return null;
        return await scrcpyMirror.getDeviceSize();
    });

    ipcMain.handle('mirror:screenshot', async () => {
        if (!scrcpyMirror) return { ok: false, error: 'mirror not ready' };
        try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const dest = path.join(app.getPath('pictures'), `LinkBridge_${stamp}.png`);
            await scrcpyMirror.screenshot(dest);
            return { ok: true, path: dest };
        } catch (e) {
            console.warn('[Bridge] mirror:screenshot failed:', e.message);
            return { ok: false, error: e.message };
        }
    });

    // ===== Phase 7 Phone-as-Webcam =====
    const webcamLastFrame = path.join(app.getPath('temp'), 'phonelink-webcam-last.jpg');

    webcam.on('status', (status) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('webcam:status', status);
        }
    });

    // Push each decoded preview frame to the renderer over IPC (in-memory
    // object URLs in the renderer) — faster and flash-free vs. re-reading the
    // on-disk last-frame file for every preview update.
    webcam.on('frame', (jpeg) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('webcam:frame', jpeg);
        }
    });

    // Serve the bridge's latest decoded JPEG so the renderer can show a live
    // preview alongside the DirectShow capture in meeting apps.
    protocol.handle('webcam-frame', (request) => {
        try {
            if (!fs.existsSync(webcamLastFrame)) return new Response('Not found', { status: 404 });
            const { Readable } = require('stream');
            return new Response(Readable.toWeb(fs.createReadStream(webcamLastFrame)), {
                headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }
            });
        } catch (e) {
            return new Response('Not found', { status: 404 });
        }
    });

    ipcMain.handle('webcam:driver-status', async () => {
        if (!webcam) return { ok: false, devices: [] };
        return webcam.driverStatus();
    });

    ipcMain.handle('webcam:install-driver', async (event, { name, devices } = {}) => {
        if (!webcam) return { ok: false, error: 'webcam not ready' };
        try {
            const result = await webcam.installDriver({ name, devices });
            const status = await webcam.driverStatus();
            if (!event.sender.isDestroyed()) event.sender.send('webcam:driver-status', status);
            return { ...result, ...status };
        } catch (e) {
            console.warn('[Bridge] webcam:install-driver failed:', e.message);
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('webcam:uninstall-driver', async () => {
        if (!webcam) return { ok: false, error: 'webcam not ready' };
        try {
            const result = await webcam.uninstallDriver();
            const status = await webcam.driverStatus();
            if (currentMainWindow && !currentMainWindow.isDestroyed()) {
                currentMainWindow.webContents.send('webcam:driver-status', status);
            }
            return { ...result, ...status };
        } catch (e) {
            console.warn('[Bridge] webcam:uninstall-driver failed:', e.message);
            return { ok: false, error: e.message };
        }
    });

    ipcMain.on('webcam:start', async (event, options = {}) => {
        if (!webcam) return;
        try {
            const devicePort = Number(options.port) || 8080;
            let url = options.url;
            let source = options.source || 'wifi';
            if (source === 'usb') {
                // Tunnel the phone's camera HTTP server over USB via adb forward.
                // Use a host port that is free on the PC — 8080 is commonly taken
                // by local dev servers and would otherwise hijack the forward.
                const hostPort = Number(options.hostPort) || await pickFreeForwardPort();
                await adb.forward(hostPort, devicePort);
                webcamForwardPort = hostPort;
                url = `http://127.0.0.1:${hostPort}/shot.jpg`;
            }
            if (!url) {
                const activeDev = getFirstActiveDevice();
                const ip = activeDev && activeDev.info ? activeDev.info.ip : null;
                url = ip ? `http://${ip}:${devicePort}/shot.jpg` : '';
            }
            if (!url) throw new Error('No camera URL available (phone not connected)');
            if (options.res || options.fps) {
                await configurePhoneCamera(url, options.res, options.fps);
            }
            const status = await webcam.start({
                ...options,
                source,
                url,
                lastFramePath: webcamLastFrame
            });
            if (!event.sender.isDestroyed()) event.sender.send('webcam:status', status);
        } catch (e) {
            console.warn('[Bridge] webcam:start failed:', e.message);
            await teardownWebcamForward();
            if (!event.sender.isDestroyed()) {
                event.sender.send('webcam:status', { running: false, error: e.message });
            }
        }
    });

    ipcMain.on('webcam:stop', async () => {
        if (webcam) webcam.stop();
        await teardownWebcamForward();
    });

    async function teardownWebcamForward() {
        const port = webcamForwardPort;
        webcamForwardPort = null;
        if (port != null) {
            try { await adb.unforward(port); } catch (e) { /* ignore */ }
        }
    }

    // Returns a host port that is free right now, so the adb forward doesn't
    // collide with local servers (Vite, the other app's server, etc).
    async function pickFreeForwardPort() {
        const net = require('net');
        const candidates = [18080, 18081, 18082, 18083, 18084, 18085];
        for (const p of candidates) {
            const free = await new Promise((resolve) => {
                const srv = net.createServer();
                srv.once('error', () => resolve(false));
                srv.listen(p, '127.0.0.1', () => {
                    srv.close(() => resolve(true));
                });
            });
            if (free) return p;
        }
        return 18080;
    }

    const RES_TO_SIZE = { '720p': { w: 1280, h: 720 }, '1080p': { w: 1920, h: 1080 }, '4k': { w: 3840, h: 2160 } };

    function httpGet(url, timeoutMs = 3000) {
        return new Promise((resolve, reject) => {
            const http = url.startsWith('https') ? require('https') : require('http');
            const req = http.get(url, { timeout: timeoutMs }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
                    resolve(Buffer.concat(chunks).toString('utf8'));
                });
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
        });
    }

    // Asks the phone camera server to reconfigure (GET /config), then waits for
    // /info to report the requested resolution so ffmpeg starts on the right size.
    async function configurePhoneCamera(shotUrl, res, fps) {
        const base = shotUrl.replace(/\/shot\.jpg$/, '');
        try {
            await httpGet(`${base}/config?res=${encodeURIComponent(res || '')}&fps=${encodeURIComponent(fps || '')}`);
        } catch (e) {
            console.warn('[Bridge] phone /config failed:', e.message);
            return;
        }
        const want = RES_TO_SIZE[res];
        for (let i = 0; i < 10; i++) {
            try {
                const info = JSON.parse(await httpGet(base + '/info'));
                if (!want || (info.width === want.w && info.height === want.h)) return;
            } catch (e) { /* keep polling */ }
            await sleep(500);
        }
    }

    // Asks the phone app to switch front/rear camera (GET /toggle on its stream).
    ipcMain.handle('webcam:toggle-camera', async () => {
        if (!webcam || !webcam.running) return { ok: false, error: 'webcam not running' };
        const url = webcam.config && webcam.config.url;
        if (!url) return { ok: false, error: 'no active stream URL' };
        try {
            const toggleUrl = url.replace(/\/shot\.jpg$/, '/toggle');
            const res = await fetch(toggleUrl, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
            return { ok: true };
        } catch (e) {
            console.warn('[Bridge] webcam:toggle-camera failed:', e.message);
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('webcam:status', () => {
        return webcam ? webcam.getStatus() : { running: false };
    });

    ipcMain.handle('webcam:snapshot', async () => {
        if (!webcam || !fs.existsSync(webcamLastFrame)) return { ok: false, error: 'No frame captured yet' };
        try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const dest = path.join(app.getPath('pictures'), `Webcam_${stamp}.jpg`);
            fs.copyFileSync(webcamLastFrame, dest);
            return { ok: true, path: dest };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // Silences the phone's ringer for an incoming call (KDE Connect request_mute packet)
    ipcMain.on('mute-ringer', () => {
        const activeDev = getFirstActiveDevice();
        if (activeDev && telephonyPlugin) telephonyPlugin.requestMute(activeDev);
    });

    // Diagnostic: inject a fake incoming call through the same plugin event channel the phone
    // packets use, so the renderer pipeline can be verified without a connected phone.
    ipcMain.on('simulate-call', () => {
        console.log('[Bridge] Simulating incoming call (diagnostic, no phone required)');
        pluginEvents.emit('incomingCall', {
            deviceId: 'simulated',
            phoneNumber: '+1 (555) 123-4567',
            contactName: 'Test Caller',
            phoneThumbnail: null,
            event: 'ringing',
            timestamp: Date.now()
        });
    });

    // Storage & Files Handlers
    ipcMain.handle('fetch-files', async (event, { path }) => {
        try {
            return await sftpPlugin.listDirectory(path || '/sdcard');
        } catch (e) {
            return [];
        }
    });

    // Resolves the phone's internal storage root through SFTP. SD card detection is
    // unreliable across Android versions (SFTP is often chrooted to the configured root),
    // so only internal storage is surfaced.
    ipcMain.handle('list-storage-roots', async () => {
        const activeDev = getFirstActiveDevice();
        if (!activeDev || !sftpPlugin) return [];

        const readable = async (p) => {
            try {
                await sftpPlugin.listDirectory(p);
                return true;
            } catch (e) {
                return false;
            }
        };

        // Resolve the internal storage root. The SFTP-configured root is guaranteed to
        // be readable, so it is used as a fallback if the standard paths are unavailable.
        let rootPath = null;
        for (const candidate of ['/sdcard', '/storage/emulated/0', '/storage/self/primary', '/mnt/sdcard']) {
            if (await readable(candidate)) {
                rootPath = candidate;
                break;
            }
        }
        if (!rootPath && sftpPlugin.sftpConfig && sftpPlugin.sftpConfig.path) {
            rootPath = sftpPlugin.sftpConfig.path;
        }
        if (!rootPath) return [];

        return [{ id: 'internal', name: 'Internal Storage', path: rootPath }];
    });

    ipcMain.on('upload-file', async (event, { localPath, remoteDirectory }) => {
        const activeDev = getFirstActiveDevice();
        if (activeDev) {
            const fileName = require('path').basename(localPath);
            const total = fs.statSync(localPath).size || 0;
            const remotePath = `${remoteDirectory}/${fileName}`;
            try {
                await sftpPlugin.uploadFile(localPath, remotePath, (progress) => {
                    if (!event.sender.isDestroyed()) {
                        event.sender.send('upload-progress', {
                            name: fileName,
                            path: remotePath,
                            progress,
                            total
                        });
                    }
                });
                if (!event.sender.isDestroyed()) {
                    event.sender.send('upload-progress', { name: fileName, path: remotePath, progress: 1, total, done: true });
                }
            } catch (err) {
                console.error('[Bridge] upload-file failed:', err?.message || err);
                if (!event.sender.isDestroyed()) {
                    event.sender.send('upload-progress', { name: fileName, path: remotePath, progress: 0, total, done: true, failed: true });
                }
            }
        }
    });

    ipcMain.on('delete-file', async (event, { remotePath, isDir }) => {
        const activeDev = getFirstActiveDevice();
        if (activeDev) await sftpPlugin.deleteItem(remotePath, isDir);
    });

    ipcMain.handle('create-directory', async (event, { path: remotePath }) => {
        if (!remotePath) return { ok: false, error: 'No path provided' };
        try {
            await sftpPlugin.createDirectory(remotePath);
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });


    // Photos & SFTP Handlers
    const photoCacheDir = path.join(app.getPath('temp'), 'smart_device_link_photos');
    if (!fs.existsSync(photoCacheDir)) fs.mkdirSync(photoCacheDir, { recursive: true });

    // Maps cached photo filename -> remote path, so images can be fetched lazily on demand.
    const photoRemoteMap = new Map();

    // Concurrency-limited download queue so photo thumbnails don't saturate the shared
    // SFTP session (which the file manager uses too).
    const MAX_CONCURRENT_PHOTO_DOWNLOADS = 3;
    let activePhotoDownloads = 0;
    const pendingPhotoDownloads = [];

    const pumpPhotoDownloads = () => {
        while (activePhotoDownloads < MAX_CONCURRENT_PHOTO_DOWNLOADS && pendingPhotoDownloads.length) {
            const { task, resolve, reject } = pendingPhotoDownloads.shift();
            activePhotoDownloads += 1;
            Promise.resolve()
                .then(task)
                .then(resolve, reject)
                .finally(() => {
                    activePhotoDownloads -= 1;
                    pumpPhotoDownloads();
                });
        }
    };

    const enqueuePhotoDownload = (task) => new Promise((resolve, reject) => {
        pendingPhotoDownloads.push({ task, resolve, reject });
        pumpPhotoDownloads();
    });

    const photoMimeFor = (name) => {
        const ext = path.extname(name).toLowerCase();
        if (ext === '.png') return 'image/png';
        if (ext === '.webp') return 'image/webp';
        if (ext === '.gif') return 'image/gif';
        if (ext === '.heic') return 'image/heic';
        return 'image/jpeg';
    };

    // Serve cached phone photos to the renderer. Downloads the file from the phone on
    // first request (throttled), then serves the local cache.
    protocol.handle('photo-cache', async (request) => {
        try {
            const url = new URL(request.url);
            const fileName = decodeURIComponent(path.basename(url.pathname));
            const localPath = path.join(photoCacheDir, fileName);
            if (!localPath.startsWith(photoCacheDir + path.sep)) {
                return new Response('Forbidden', { status: 403 });
            }

            if (!fs.existsSync(localPath)) {
                const remotePath = photoRemoteMap.get(fileName);
                if (!remotePath || !sftpPlugin) {
                    return new Response('Not found', { status: 404 });
                }
                await enqueuePhotoDownload(() => sftpPlugin.downloadFile(remotePath, localPath));
                if (!fs.existsSync(localPath)) {
                    return new Response('Not found', { status: 404 });
                }
            }

            const { Readable } = require('stream');
            return new Response(Readable.toWeb(fs.createReadStream(localPath)), {
                headers: { 'Content-Type': photoMimeFor(fileName) }
            });
        } catch (e) {
            console.warn('[Bridge] photo-cache request failed:', e.message);
            return new Response('Not found', { status: 404 });
        }
    });

    async function scanAndCachePhotos() {
        const activeDev = getFirstActiveDevice();
        if (!activeDev || !sftpPlugin) return [];

        try {
            if (!sftpPlugin.sftpConfig) {
                sftpPlugin.requestSftpMount(activeDev);
                await new Promise((r) => setTimeout(r, 1200));
            }
            const rawFiles = await sftpPlugin.listDirectory('/sdcard/DCIM/Camera');
            const imageFiles = rawFiles.filter((f) => !f.isDir && /\.(jpg|jpeg|png|webp|heic)$/i.test(f.name)).slice(0, 30);

            const photoList = [];
            for (const file of imageFiles) {
                const localPath = path.join(photoCacheDir, file.name);
                photoRemoteMap.set(file.name, file.path);
                photoList.push({
                    id: file.name,
                    name: file.name,
                    path: file.path,
                    url: `photo-cache://local/${encodeURIComponent(file.name)}`,
                    date: file.modifyTime || Date.now(),
                    size: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
                    cached: fs.existsSync(localPath)
                });
            }
            return photoList;
        } catch (err) {
            console.warn('[Bridge] Photos scan failed:', err.message);
            return [];
        }
    }

    ipcMain.handle('get-photos', async () => {
        return await scanAndCachePhotos();
    });

    ipcMain.on('scan-photos', async () => {
        const photos = await scanAndCachePhotos();
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('photos-updated', photos);
        }
    });

    ipcMain.on('download-file', async (event, { remotePath, name }) => {
        const activeDev = getFirstActiveDevice();
        if (!activeDev || !sftpPlugin) return;
        try {
            const downloadsFolder = app.getPath('downloads');
            const destPath = path.join(downloadsFolder, name || path.basename(remotePath));
            await sftpPlugin.downloadFile(remotePath, destPath);
            console.log(`[Bridge] Downloaded ${name} to ${destPath}`);
        } catch (e) {
            console.error('[Bridge] Download failed:', e.message);
        }
    });
    // Messaging Handlers
    ipcMain.handle('get-sms-threads', () => {
        return smsPlugin ? smsPlugin.getThreadsList() : [];
    });

    ipcMain.on('fetch-sms-threads', () => {
        const activeDev = getFirstActiveDevice();
        if (activeDev && smsPlugin) smsPlugin.requestAllThreads(activeDev);
    });

    ipcMain.on('send-sms', (event, { phoneNumber, messageText }) => {
        const activeDev = getFirstActiveDevice();
        if (activeDev && smsPlugin) smsPlugin.sendSms(activeDev, phoneNumber, messageText);
    });

    // Unified Settings Handlers
    ipcMain.handle('get-settings', () => {
        return rfcommClient ? rfcommClient.loadConfig() : {};
    });

    ipcMain.handle('save-settings', (event, partialSettings) => {
        if (rfcommClient) {
            rfcommClient.saveConfig(partialSettings);
            if (partialSettings.hasOwnProperty('autoStart')) {
                const enabled = !!partialSettings.autoStart;
                try {
                    let execPath = app.getPath('exe');
                    if (process.platform === 'linux' && process.env.APPIMAGE) {
                        execPath = process.env.APPIMAGE;
                    }
                    app.setLoginItemSettings({
                        openAtLogin: enabled,
                        path: execPath
                    });
                    console.log(`[Bridge] AutoStart login setting updated to: ${enabled} (path: ${execPath})`);
                } catch (e) {
                    console.warn('[Bridge] Failed to update login item settings:', e.message);
                }
            }
            return rfcommClient.loadConfig();
        }
        return {};
    });

    // Contacts Handlers
    ipcMain.handle('get-contacts', () => {
        return contactsPlugin ? contactsPlugin.getContactsList() : [];
    });

    ipcMain.on('fetch-contacts', () => {
        const activeDev = getFirstActiveDevice();
        if (activeDev && contactsPlugin) contactsPlugin.requestAllContacts(activeDev);
    });

    ipcMain.on('share-url', (event, { url }) => {
        const activeDev = getFirstActiveDevice();
        if (activeDev) sharePlugin.shareUrlToPhone(activeDev, url);
    });

    ipcMain.on('send-reply', (event, { requestReplyId, text }) => {
        const activeDev = getFirstActiveDevice();
        if (activeDev) notificationPlugin.replyToNotification(activeDev, requestReplyId, text);
    });

    ipcMain.on('send-notification-action', (event, { requestId, actionKey }) => {
        const activeDev = getFirstActiveDevice();
        if (activeDev) notificationPlugin.sendNotificationAction(activeDev, requestId, actionKey);
    });

    ipcMain.on('dismiss-notification', (event, { id }) => {
        const activeDev = getFirstActiveDevice();
        if (activeDev) notificationPlugin.dismissNotification(activeDev, id);
    });

    // ===== Shared Clipboard =====

    // PC -> phone clipboard auto-sync. Polls the OS clipboard; when the text changes
    // (and it isn't content we just received from the phone) it forwards it to the
    // device, mirroring KDE Connect's shared clipboard behaviour.
    let clipboardWatchTimer = null;
    let lastPcClipboard = '';
    let clipboardAutoSync = true;
    try {
        const cfg = rfcommClient.loadConfig();
        if (cfg && cfg.hasOwnProperty('clipboardAutoSync')) {
            clipboardAutoSync = !!cfg.clipboardAutoSync;
        }
    } catch (e) {}

    const pushClipboardItem = (item) => {
        if (currentMainWindow && !currentMainWindow.isDestroyed()) {
            currentMainWindow.webContents.send('clipboard-received', item);
        }
    };

    const startClipboardWatch = () => {
        if (clipboardWatchTimer) return;
        try {
            lastPcClipboard = electronClipboard.readText() || '';
        } catch (e) {
            lastPcClipboard = '';
        }
        clipboardWatchTimer = setInterval(() => {
            if (!clipboardAutoSync) return;
            let text = '';
            try {
                text = electronClipboard.readText() || '';
            } catch (e) {
                return;
            }
            if (!text || text === lastPcClipboard) return;
            if (clipboardPlugin && text === clipboardPlugin.lastContent) return; // echo of phone->pc
            lastPcClipboard = text;

            const activeDev = getFirstActiveDevice();
            if (!activeDev || !clipboardPlugin) return;
            clipboardPlugin.sendClipboard(activeDev, text);
            const item = clipboardPlugin.addSentFromPc(text, 'PC');
            if (item) pushClipboardItem(item);
        }, 1500);
    };

    const stopClipboardWatch = () => {
        if (clipboardWatchTimer) {
            clearInterval(clipboardWatchTimer);
            clipboardWatchTimer = null;
        }
    };

    if (clipboardAutoSync) startClipboardWatch();

    ipcMain.handle('get-clipboard-history', () => {
        return clipboardPlugin ? clipboardPlugin.getHistory() : [];
    });

    ipcMain.handle('get-clipboard-auto-sync', () => clipboardAutoSync);

    ipcMain.on('set-clipboard-auto-sync', (event, { enabled }) => {
        clipboardAutoSync = !!enabled;
        try {
            rfcommClient.saveConfig({ clipboardAutoSync });
        } catch (e) {}
        if (clipboardAutoSync) startClipboardWatch();
        else stopClipboardWatch();
    });

    ipcMain.on('clear-clipboard-history', () => {
        if (clipboardPlugin) clipboardPlugin.clearHistory();
    });

    ipcMain.on('remove-clipboard-item', (event, { id }) => {
        if (clipboardPlugin) clipboardPlugin.removeFromHistory(id);
    });

    ipcMain.on('set-pc-clipboard', (event, { content }) => {
        try {
            electronClipboard.writeText(content || '');
        } catch (e) {
            console.warn('[Bridge] set-pc-clipboard failed:', e.message);
        }
    });

    ipcMain.on('send-clipboard', (event, { content }) => {
        if (!content) return;
        const activeDev = getFirstActiveDevice();
        if (!activeDev || !clipboardPlugin) return;
        clipboardPlugin.sendClipboard(activeDev, content);
        const item = clipboardPlugin.addSentFromPc(content, 'PC');
        if (item) pushClipboardItem(item);
    });

    ipcMain.on('media-control', (event, { action, volume, setPos, seek }) => {
        const activeDev = getFirstActiveDevice();
        if (!activeDev || !mprisPlugin) return;
        if (action === 'setVolume') mprisPlugin.setVolume(activeDev, volume);
        else if (action === 'GetState') mprisPlugin.requestMediaState(activeDev);
        else if (action === 'SetPos' || action === 'Seek') mprisPlugin.sendSeek(activeDev, action === 'SetPos' ? { setPos } : { seek });
        else mprisPlugin.sendAction(activeDev, action);
    });

    ipcMain.on('pc-media-state-changed', (event, state) => {
        const activeDev = getFirstActiveDevice();
        if (activeDev && mprisPlugin && state) mprisPlugin.broadcastPcState(activeDev, state);
    });

    // PC app's own controls (media panel buttons / volume slider) drive the real system session.
    ipcMain.on('pc-media-command', (event, command) => {
        handlePcMediaCommand(command || {});
    });

    // Poll the real system media session (master volume + now-playing via SMTC) so the phone's
    // volume bar tracks physical volume keys / the actual media app, and the phone + app see the
    // real title/artist/play-state/timeline of whatever is playing on the PC.
    let lastPcNowPlayingSig = '';
    setInterval(refreshPcMediaState, 2000);

    // Read the real system session and push any changed fields to the phone + renderer.
    function refreshPcMediaState() {
        if (!pcMediaController) return;
        pcMediaController.getNowPlaying().then((np) => {
            return pcMediaController.getVolume().then((res) => {
                const state = {};
                if (typeof res.volume === 'number' && res.volume !== lastPcVolume) {
                    lastPcVolume = res.volume;
                    state.volume = res.volume;
                }
                // pos is floored coarsely only while paused (a paused track's position is
                // static, so a coarse floor just suppresses needless rebroadcasts); while
                // playing the true 1s position is sent so the app/phone get accurate progress.
                const posKey = np.isPlaying ? Math.floor(np.pos || 0) : Math.floor((np.pos || 0) / 5);
                const sig = `${np.title}|${np.artist}|${np.album}|${np.isPlaying}|${posKey}|${np.length}`;
                if (sig !== lastPcNowPlayingSig) {
                    lastPcNowPlayingSig = sig;
                    state.title = np.title;
                    state.artist = np.artist;
                    state.album = np.album;
                    state.isPlaying = np.isPlaying;
                    state.pos = np.pos;
                    state.length = np.length;
                }
                if (Object.keys(state).length === 0) return;
                const activeDev = getFirstActiveDevice();
                if (mprisPlugin && activeDev) mprisPlugin.broadcastPcState(activeDev, state);
                if (currentMainWindow && !currentMainWindow.isDestroyed()) {
                    currentMainWindow.webContents.send('pc-media-state', state);
                }
            }).catch(() => { /* helper unavailable */ });
        }).catch(() => { /* helper unavailable */ });
    }

    ipcMain.on('ring-phone', () => {
        const activeDev = getFirstActiveDevice();
        if (activeDev) findMyPhonePlugin.ringPhone(activeDev);
    });

    ipcMain.handle('pair-device', (event, deviceId) => {
        const devInfo = deviceManager.discoveredDevices.get(deviceId);
        if (!devInfo) return { success: false, message: 'Device not found' };

        let devConn = activeDeviceConnections.get(deviceId);
        if (!devConn) {
            devConn = connectToDevice(devInfo, currentMainWindow);
        }

        if (devConn.connected) {
            pairingManager.requestPair(devConn);
        } else {
            devConn.once('connected', () => {
                pairingManager.requestPair(devConn);
            });
        }
        return { success: true };
    });


    ipcMain.handle('accept-pair', (event, deviceId) => {
        const devConn = activeDeviceConnections.get(deviceId);
        if (devConn) {
            pairingManager.acceptPair(devConn);
            return { success: true };
        }
        return { success: false, message: 'Device connection not active' };
    });

    ipcMain.handle('unpair-device', (event, deviceId) => {
        pairingManager.unpair(deviceId);
        const devConn = activeDeviceConnections.get(deviceId);
        if (devConn) {
            pairingManager.rejectPair(devConn);
            devConn.disconnect();
        }
        return { success: true };
    });

    return { cryptoHelper, deviceManager, packetRouter, pairingManager, rfcommClient, rfcommProtocol, audioBridge };
}

function getFirstActiveDevice() {
    const values = Array.from(activeDeviceConnections.values());
    return values.length > 0 ? values[0] : null;
}

// Translate a phone/app command into a real system media key press, master volume change,
// or SMTC session seek.
function handlePcMediaCommand(command) {
    if (!pcMediaController) return;
    const { action, setVolume, seek, setPos, SetPosition, Seek } = command || {};
    let method = null;
    let args = [];
    if (typeof setVolume === 'number') {
        console.log('[bridge] PC media command: setVolume', setVolume);
        method = 'setVolume'; args = [setVolume];
    } else if (typeof SetPosition === 'number') {
        console.log('[bridge] PC media command: SetPosition', SetPosition);
        method = 'setPos'; args = [SetPosition];
    } else if (typeof Seek === 'number') {
        console.log('[bridge] PC media command: Seek', Seek, '(us -> ms)');
        method = 'seek'; args = [Math.round(Seek / 1000)];
    } else if (typeof seek === 'number') {
        console.log('[bridge] PC media command: seek', seek);
        method = 'seek'; args = [seek];
    } else if (typeof setPos === 'number') {
        console.log('[bridge] PC media command: setPos', setPos);
        method = 'setPos'; args = [setPos];
    } else if (action === 'Play') {
        console.log('[bridge] PC media command: Play');
        method = 'play';
    } else if (action === 'Pause') {
        console.log('[bridge] PC media command: Pause');
        method = 'pause';
    } else if (action === 'PlayPause') {
        console.log('[bridge] PC media command: PlayPause');
        method = 'playPause';
    } else if (action === 'Next') {
        console.log('[bridge] PC media command: Next');
        method = 'next';
    } else if (action === 'Previous') {
        console.log('[bridge] PC media command: Previous');
        method = 'previous';
    } else if (action === 'Stop') {
        console.log('[bridge] PC media command: Stop');
        method = 'stop';
    } else {
        console.log('[bridge] PC media command: UNHANDLED', JSON.stringify(command));
        return;
    }
    if (!method || typeof pcMediaController[method] !== 'function') return;
    try {
        const res = pcMediaController[method](...args);
        if (res && typeof res.catch === 'function') {
            res.catch(() => { /* no media player available (e.g. no MPRIS session) */ });
        }
    } catch (err) {
        // no media player available (e.g. no MPRIS session)
    }
}

function connectToDevice(deviceInfo, mainWindow) {
    if (activeDeviceConnections.has(deviceInfo.id)) {
        return activeDeviceConnections.get(deviceInfo.id);
    }

    const deviceConnection = new Device(deviceInfo, cryptoHelper);
    deviceConnection.isPaired = pairingManager.isPaired(deviceInfo.id);
    activeDeviceConnections.set(deviceInfo.id, deviceConnection);

    deviceConnection.on('connected', (info) => {
        activeDeviceConnections.set(info.id, deviceConnection);
        const win = currentMainWindow || mainWindow;
        if (win && !win.isDestroyed()) {
            win.webContents.send('device-status-changed', {
                name: info.name,
                connected: true,
                battery: batteryPlugin ? batteryPlugin.batteryState.charge : 85,
                signal: connectivityPlugin ? connectivityPlugin.connectivityState.signalStrength : 4,
                wifi: true,
                bluetooth: true
            });
        }

        // Start the RFCOMM phone link alongside the KDE Connect TCP link
        if (rfcommClient && !rfcommClient.connected && !rfcommClient.connecting) {
            rfcommClient.connect();
        }

        notificationPlugin.requestAllNotifications(deviceConnection);
        batteryPlugin.requestBatteryStatus(deviceConnection);
        connectivityPlugin.requestReport(deviceConnection);
        smsPlugin.requestAllThreads(deviceConnection);
        contactsPlugin.requestAllContacts(deviceConnection);
        sftpPlugin.requestSftpMount(deviceConnection);
    });

    deviceConnection.on('packet', (packet, payload) => {
        packetRouter.routePacket(deviceConnection, packet, payload);
    });

    deviceConnection.on('connectfailed', () => {
        // A failed connect attempt must not leave a dead placeholder in the map,
        // otherwise auto-connect sees it and never retries.
        activeDeviceConnections.delete(deviceInfo.id);
    });

    deviceConnection.on('disconnected', ({ info }) => {
        activeDeviceConnections.delete(info.id);
        if (rfcommClient) rfcommClient.drop();
        const win = currentMainWindow || mainWindow;
        if (win && !win.isDestroyed()) {
            win.webContents.send('device-status-changed', { name: info.name, connected: false });
        }
    });

    deviceConnection.connect();
    return deviceConnection;
}

module.exports = { initKDEConnectBridge, setMainWindow };
