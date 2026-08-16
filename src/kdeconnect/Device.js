const net = require('net');
const tls = require('tls');
const EventEmitter = require('events');

const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 15000;

class Device extends EventEmitter {
    constructor(deviceInfo, cryptoHelper) {
        super();
        this.info = deviceInfo; // { id, name, ip, port, ... }
        this.crypto = cryptoHelper;
        this.socket = null;
        this.connected = false;
        this.isPaired = false;
        this.buffer = Buffer.alloc(0);
        this._pendingPayload = null;
        this.lastPacketAt = 0;
        this.heartbeatInterval = null;
    }

    connect() {
        console.log(`[Device] Connecting TCP to ${this.info.name} at ${this.info.ip}:${this.info.port || 1716}...`);

        const rawSocket = net.connect({
            host: this.info.ip,
            port: this.info.port || 1716,
            timeout: 3000
        });

        const onRawConnect = () => {
            // The connect-phase handlers below are only relevant during the attempt;
            // once connected, the TLS socket takes over error/timeout handling.
            rawSocket.removeAllListeners('timeout');
            rawSocket.removeAllListeners('error');

            // If a replacement socket was already attached (e.g. the phone connected
            // to us while our outbound connect was still in flight), abandon this
            // outbound connection instead of clobbering the live one.
            if (this.socket) {
                console.warn(`[Device] ${this.info.name}: outbound connect superseded by an incoming connection, aborting.`);
                rawSocket.destroy();
                return;
            }

            // Connection established; the idle timeout was only needed for the connect attempt.
            // Liveness is now handled by the application-level heartbeat watchdog.
            rawSocket.setTimeout(0);

            // KDE Connect: the device that INITIATES the TCP connection sends its identity in
            // plaintext first (with targetDeviceId / targetProtocolVersion), then performs the
            // TLS handshake as the TLS *server*. The receiving device performs the TLS *client*
            // handshake. We therefore wrap the outbound socket in server mode.
            const identityPacket = this.crypto.getIdentityPacket();
            identityPacket.body.targetDeviceId = this.info.id;
            if (this.info.protocolVersion) {
                identityPacket.body.targetProtocolVersion = this.info.protocolVersion;
            }
            rawSocket.write(JSON.stringify(identityPacket) + '\n', 'utf8');

            try {
                this.socket = new tls.TLSSocket(rawSocket, {
                    isServer: true,
                    key: this.crypto.privateKey,
                    cert: this.crypto.certificate,
                    rejectUnauthorized: false,
                    requestCert: false,
                    minVersion: 'TLSv1.2',
                    maxVersion: 'TLSv1.2'
                });
            } catch (err) {
                console.error(`[Device Connection Failure] ${this.info.name}:`, err.message);
                this.handleDisconnect(err.message);
                return;
            }

            this.socket.setEncoding('utf8');
            this.socket.setKeepAlive(true, 3000);

            this.socket.on('secure', () => {
                this.connected = true;
                this.lastPacketAt = Date.now();
                console.log(`[Device] Encrypted TLS Connection Established with ${this.info.name}`);
                this.emit('connected', this.info);
                this.startHeartbeat();
            });

            this.socket.on('timeout', () => {
                console.warn(`[Device Timeout] Connection to ${this.info.name} (${this.info.ip}) timed out.`);
                this.handleDisconnect('Socket timeout');
            });

            this.socket.on('data', (data) => {
                this.handleRawData(data);
            });

            this.socket.on('end', () => {
                this.handleDisconnect('Socket ended by remote device');
            });

            this.socket.on('error', (err) => {
                console.error(`[Device Error] ${this.info.name}:`, err.message);
                this.handleDisconnect(err.message);
            });

            this.socket.on('close', () => {
                this.handleDisconnect('Socket closed');
            });
        };

        rawSocket.on('connect', onRawConnect);

        // Any timeout/error before 'connect' fires means the attempt itself failed.
        // Emit 'connectfailed' so the bridge can drop the placeholder from its map;
        // otherwise a failed connect would sit there forever and block future
        // auto-reconnect attempts.
        let connectAttemptFailed = false;
        const failConnect = (message) => {
            if (connectAttemptFailed) return;
            connectAttemptFailed = true;
            this.handleDisconnect(message);
            this.emit('connectfailed', this.info);
            rawSocket.removeAllListeners();
            rawSocket.destroy();
        };

        rawSocket.on('timeout', () => {
            console.warn(`[Device Timeout] Connection to ${this.info.name} (${this.info.ip}) timed out.`);
            failConnect('Socket timeout');
        });

        rawSocket.on('error', (err) => {
            console.error(`[Device Connection Failure] ${this.info.name}:`, err.message);
            failConnect(err.message);
        });
    }

    handleRawData(data) {
        this.lastPacketAt = Date.now();
        this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(data) ? data : Buffer.from(data)]);

        // If a packet declared a payload earlier but not all bytes had arrived yet,
        // finish consuming them before parsing any new JSON lines.
        if (this._pendingPayload) {
            if (this.buffer.length < this._pendingPayload.remaining) return;
            const pendingPayload = Buffer.from(this.buffer.subarray(0, this._pendingPayload.remaining));
            this.buffer = this.buffer.subarray(this._pendingPayload.remaining);
            this.emit('packet', this._pendingPayload.packet, pendingPayload);
            this._pendingPayload = null;
        }

        // KDE Connect protocol uses newline-delimited JSON packets, optionally followed
        // by a binary payload (e.g. album art) of `payloadSize` bytes.
        let newlineIndex = this.buffer.indexOf(0x0a);
        while (newlineIndex !== -1) {
            const jsonLine = this.buffer.subarray(0, newlineIndex).toString('utf8').trim();
            this.buffer = this.buffer.subarray(newlineIndex + 1);

            if (jsonLine.length > 0) {
                try {
                    const packet = JSON.parse(jsonLine);
                    const payloadSize = packet.payloadSize;
                    const transferPort = packet.payloadTransferInfo && packet.payloadTransferInfo.port;
                    if (payloadSize > 0 && transferPort) {
                        // KDE Connect transfers payloads over a SEPARATE TCP connection
                        // (mirroring the main link's TLS): the sender advertises a port in
                        // payloadTransferInfo and waits for us to connect to it. Do NOT wait
                        // for the bytes on the main socket or every later packet would stall.
                        this.receivePayloadOverSocket(packet, payloadSize, transferPort);
                    } else if (payloadSize > 0) {
                        // Legacy/fallback: payload bytes arrive immediately after the JSON
                        // line on the same socket.
                        if (this.buffer.length < payloadSize) {
                            this._pendingPayload = { packet, remaining: payloadSize };
                            return; // wait for the rest of the payload to arrive
                        }
                        const payload = Buffer.from(this.buffer.subarray(0, payloadSize));
                        this.buffer = this.buffer.subarray(payloadSize);
                        this.emit('packet', packet, payload);
                    } else {
                        this.emit('packet', packet);
                    }
                } catch (err) {
                    console.warn('[Device] Failed to parse JSON packet:', err.message);
                }
            }

            newlineIndex = this.buffer.indexOf(0x0a);
        }
    }

    // The sender (phone) is listening on payloadTransferInfo.port and hands that socket
    // over to TLS (server role). We connect to it as the TLS client and read `size` raw
    // bytes, then emit the packet with the payload attached.
    receivePayloadOverSocket(packet, size, port) {
        let downloaded = 0;
        const chunks = [];
        let finished = false;

        const finish = (payload) => {
            if (finished) return;
            finished = true;
            try { sock.destroy(); } catch (e) { /* already closed */ }
            this.emit('packet', packet, payload);
        };

        const partial = () => (downloaded > 0 ? Buffer.concat(chunks).subarray(0, Math.min(downloaded, size)) : undefined);

        const sock = tls.connect({
            host: this.info.ip,
            port,
            rejectUnauthorized: false,
            requestCert: false,
            key: this.crypto.privateKey,
            cert: this.crypto.certificate,
            minVersion: 'TLSv1.2',
            maxVersion: 'TLSv1.2'
        });

        sock.on('secureConnect', () => {
            sock.setTimeout(10000);
        });

        sock.on('data', (chunk) => {
            chunks.push(chunk);
            downloaded += chunk.length;
            if (downloaded >= size) {
                finish(Buffer.concat(chunks).subarray(0, size));
            }
        });

        sock.on('error', (err) => {
            console.warn(`[Device] Payload transfer from ${this.info.name} (${this.info.ip}:${port}) failed: ${err.message}`);
            finish(partial());
        });

        sock.on('timeout', () => {
            console.warn(`[Device] Payload transfer from ${this.info.name} timed out.`);
            finish(partial());
        });

        sock.on('end', () => {
            finish(partial());
        });

        sock.setTimeout(10000);
    }

    sendPacket(packet) {
        if (!this.socket || !this.connected) {
            console.warn(`[Device] Cannot send packet to ${this.info.name}: Socket not connected`);
            return false;
        }

        try {
            const payload = JSON.stringify(packet) + '\n';
            this.socket.write(payload, 'utf8');
            return true;
        } catch (err) {
            console.error(`[Device] Send Packet Error to ${this.info.name}:`, err.message);
            return false;
        }
    }

    handleDisconnect(reason) {
        if (this.pendingDisconnect) return;

        const wasConnected = this.connected;
        this.connected = false;
        this.lastPacketAt = 0;
        this.stopHeartbeat();

        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }

        if (!wasConnected) return;

        // Grace period: the phone often swaps to a fresh connection immediately
        // (LanLink.link.reset churn on every UDP broadcast). If a replacement
        // socket is attached before the timer fires, the disconnect is cancelled
        // and the link is reused seamlessly instead of flickering the UI.
        this.pendingDisconnect = setTimeout(() => {
            this.pendingDisconnect = null;
            console.log(`[Device] Disconnected from ${this.info.name}. Reason: ${reason}`);
            this.emit('disconnected', { info: this.info, reason });
        }, 600);
    }

    cancelPendingDisconnect() {
        if (this.pendingDisconnect) {
            clearTimeout(this.pendingDisconnect);
            this.pendingDisconnect = null;
        }
    }

    disconnect() {
        this.handleDisconnect('User initiated disconnect');
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (!this.connected) return;

            // Unpaired devices never answer plugin pings (the phone only routes
            // plugin packets to paired peers), so a timeout here would falsely
            // kill the link during pairing. Let socket-level events handle it.
            if (this.isPaired) {
                const idleMs = Date.now() - this.lastPacketAt;
                if (idleMs > HEARTBEAT_TIMEOUT_MS) {
                    console.warn(`[Device] ${this.info.name} has not responded for ${Math.round(idleMs / 1000)}s; declaring disconnected.`);
                    this.handleDisconnect('Heartbeat timeout (no response from device)');
                    return;
                }
            }

            this.sendPing();
        }, HEARTBEAT_INTERVAL_MS);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    sendPing() {
        // kdeconnect.connectivity_report.request is deprecated and ignored by
        // modern Android; the phone's stable BatteryPlugin still answers
        // kdeconnect.battery.request with a kdeconnect.battery report.
        const pingPacket = {
            id: Date.now(),
            type: 'kdeconnect.battery.request',
            body: { request: true }
        };
        this.sendPacket(pingPacket);
    }
}

module.exports = Device;
