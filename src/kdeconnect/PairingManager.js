const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');

class PairingManager extends EventEmitter {
    constructor(packetRouter, cryptoHelper) {
        super();
        this.router = packetRouter;
        this.crypto = cryptoHelper;
        this.pairedFilePath = path.join(os.homedir(), '.smart_device_link_keys', 'paired_devices.json');
        this.pairedDevices = new Map(); // deviceId -> { id, name, certFingerprint, pairedAt }

        // Tracks in-progress pairing handshakes so we know whether an incoming
        // pair packet is a reply to a request we initiated or a brand-new request.
        this.pendingPairs = new Map(); // deviceId -> { direction: 'outgoing'|'incoming', timestamp }

        this.loadPairedDevices();
        this.registerPairingHandler();
    }

    loadPairedDevices() {
        try {
            if (fs.existsSync(this.pairedFilePath)) {
                const raw = fs.readFileSync(this.pairedFilePath, 'utf8');
                const list = JSON.parse(raw);
                list.forEach((dev) => this.pairedDevices.set(dev.id, dev));
                console.log(`[PairingManager] Loaded ${this.pairedDevices.size} paired devices from disk.`);
            }
        } catch (err) {
            console.error('[PairingManager] Failed to load paired devices:', err.message);
        }
    }

    savePairedDevices() {
        try {
            const list = Array.from(this.pairedDevices.values());
            fs.writeFileSync(this.pairedFilePath, JSON.stringify(list, null, 2), 'utf8');
        } catch (err) {
            console.error('[PairingManager] Failed to save paired devices:', err.message);
        }
    }

    isPaired(deviceId) {
        if (!deviceId) return false;
        return this.pairedDevices.has(deviceId);
    }

    // Protocol v8 requires a unix-seconds timestamp in pair packets. Without it
    // the Android PairingHandler treats an incoming request as an unpair.
    makePairPacket(pair) {
        return {
            id: Date.now(),
            type: 'kdeconnect.pair',
            body: {
                pair,
                timestamp: Math.floor(Date.now() / 1000)
            }
        };
    }

    registerPairingHandler() {
        this.router.on('packet:kdeconnect.pair', ({ device, packet }) => {
            const body = packet.body || {};
            const wantsPair = body.pair;

            console.log(`[PairingManager] Received pair packet from ${device.info.name} (pair: ${wantsPair})`);

            if (wantsPair) {
                const deviceId = device.info.id;
                const pending = this.pendingPairs.get(deviceId);

                if (pending && pending.direction === 'outgoing') {
                    // We initiated pairing and the remote device accepted.
                    console.log(`[PairingManager] ${device.info.name} accepted our pair request.`);
                    this.acceptPair(device);
                } else if (this.isPaired(deviceId)) {
                    // Already paired: respond to keep both sides in sync.
                    this.acceptPair(device);
                } else {
                    // Brand-new incoming pair request: show the user a prompt.
                    this.pendingPairs.set(deviceId, {
                        direction: 'incoming',
                        timestamp: body.timestamp || null
                    });
                    this.emit('pairingRequested', {
                        device: device.info,
                        requestId: packet.id
                    });
                }
            } else {
                // Unpair request
                const deviceId = device.info.id;
                this.pendingPairs.delete(deviceId);
                if (this.isPaired(deviceId)) {
                    this.unpair(deviceId);
                    this.emit('deviceUnpaired', device.info);
                } else {
                    console.log(`[PairingManager] Ignoring unpair request for already unpaired device ${device.info.name}`);
                }
            }
        });
    }

    requestPair(device) {
        if (!device || !device.info.id) return;

        const deviceId = device.info.id;
        if (this.isPaired(deviceId)) {
            console.log(`[PairingManager] requestPair called for already paired device ${device.info.name}`);
            return;
        }

        const pending = this.pendingPairs.get(deviceId);
        if (pending && pending.direction === 'incoming') {
            // The remote device already asked us: accept their request instead.
            console.log(`[PairingManager] ${device.info.name} already requested pairing, accepting their request.`);
            this.acceptPair(device);
            return;
        }

        console.log(`[PairingManager] Sending pair request to ${device.info.name}...`);
        this.pendingPairs.set(deviceId, {
            direction: 'outgoing',
            timestamp: Math.floor(Date.now() / 1000)
        });
        device.sendPacket(this.makePairPacket(true));
    }

    acceptPair(device) {
        if (!device || !device.info.id) return;

        const deviceId = device.info.id;
        this.pendingPairs.delete(deviceId);

        // Verify remote certificate and save to trust store
        if (device.socket && typeof device.socket.getPeerCertificate === 'function') {
            const certResult = this.crypto.verifyPeerCertificate(device.socket, deviceId);
            if (certResult.valid) {
                device.info.certificatePem = certResult.certPem;
                device.info.fingerprint = certResult.fingerprint;
                console.log(`[PairingManager] Verified & Saved peer certificate for ${device.info.name} (${certResult.fingerprint})`);
            }
        }

        const pairedDevice = {
            id: deviceId,
            name: device.info.name,
            ip: device.info.ip,
            pairedAt: Date.now(),
            fingerprint: device.info.fingerprint || null,
            certificatePem: device.info.certificatePem || null
        };

        this.pairedDevices.set(deviceId, pairedDevice);
        this.savePairedDevices();

        // Send pair accept packet
        device.sendPacket(this.makePairPacket(true));

        console.log(`[PairingManager] Paired successfully with ${device.info.name}`);
        this.emit('devicePaired', pairedDevice);
    }

    rejectPair(device) {
        if (!device || !device.info.id) return;
        console.log(`[PairingManager] Rejecting pair request from ${device.info.name}...`);
        this.pendingPairs.delete(device.info.id);
        device.sendPacket(this.makePairPacket(false));
    }

    unpair(deviceId) {
        if (this.pairedDevices.has(deviceId)) {
            this.pairedDevices.delete(deviceId);
            this.savePairedDevices();
            console.log(`[PairingManager] Device ${deviceId} unpaired.`);
            return true;
        }
        return false;
    }
}

module.exports = PairingManager;
