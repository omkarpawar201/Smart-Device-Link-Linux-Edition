const dgram = require('dgram');
const tls = require('tls');
const EventEmitter = require('events');
const os = require('os');

class DeviceManager extends EventEmitter {
    constructor(cryptoHelper) {
        super();
        this.crypto = cryptoHelper;
        this.port = 1716;
        this.udpSocket = null;
        this.tcpServer = null;
        this.discoveredDevices = new Map();
        this.broadcastInterval = null;
        this._retryTcpTimer = null;
        this._retryUdpTimer = null;
    }

    startDiscovery() {
        this.startTcpServer();
        this.startUdpDiscovery();
    }

    startTcpServer() {
        try {
            const net = require('net');
            this.tcpServer = net.createServer((socket) => {
                console.log(`[TCP DeviceManager] Incoming TCP Connection from ${socket.remoteAddress}`);

                socket.setTimeout(10000);
                socket.on('timeout', () => {
                    console.warn('[TCP DeviceManager] Socket timeout during initial handshake from', socket.remoteAddress);
                    socket.destroy();
                });

                let rawBuffer = Buffer.alloc(0);

                const onData = (chunk) => {
                    rawBuffer = Buffer.concat([rawBuffer, chunk]);
                    const newlineIndex = rawBuffer.indexOf(0x0a); // '\n' byte
                    if (newlineIndex !== -1) {
                        const lineBuffer = rawBuffer.subarray(0, newlineIndex);
                        const remainingBuffer = rawBuffer.subarray(newlineIndex + 1);

                        socket.removeListener('data', onData);
                        socket.pause(); // Pause socket before TLS wrapping

                        // Unshift remaining bytes (ClientHello) back to socket stream if present
                        if (remainingBuffer.length > 0) {
                            socket.unshift(remainingBuffer);
                        }

                        try {
                            const line = lineBuffer.toString('utf8').trim();
                            const packet = JSON.parse(line);
                            if (packet.type === 'kdeconnect.identity') {
                                console.log(`[TCP DeviceManager] Identity received from ${packet.body?.deviceName || socket.remoteAddress}`);

                                // Per the KDE Connect protocol, the device that connects to us already knows our
                                // identity (it got it from our UDP broadcast), so we must NOT reply with a
                                // plaintext identity packet. Doing so would corrupt the TLS handshake that the
                                // connecting device starts immediately afterwards. We perform that TLS handshake
                                // as the TLS *client*, since the connecting device acts as the TLS *server*.
                                this.upgradeServerTLSSocket(socket, packet);
                            } else {
                                this.upgradeServerTLSSocket(socket, null);
                            }
                        } catch (e) {
                            this.upgradeServerTLSSocket(socket, null);
                        }
                    }
                };

                socket.on('data', onData);
                socket.on('error', (err) => {
                    console.warn('[TCP DeviceManager] Socket error:', err.message);
                });
            });

            this.tcpServer.on('error', (err) => {
                console.error('[TCP DeviceManager] Server Error:', err.message);
                if (err.code === 'EADDRINUSE') {
                    this.tryStopNativeKdeConnect();
                    this.emit('fatalError', {
                        code: 'PORT_1716_IN_USE',
                        message: `TCP port ${this.port} is already in use — another KDE Connect instance (e.g. the native kdeconnectd daemon) is running. Stop it with:  systemctl --user stop kdeconnectd   (or: killall kdeconnectd)  and restart the app.`
                    });
                    // Self-heal: kdeconnectd may be stopped/killed while the app
                    // stays running, so retry the bind instead of dying forever.
                    if (!this._retryTcpTimer) {
                        this._retryTcpTimer = setTimeout(() => {
                            this._retryTcpTimer = null;
                            this.tcpServer = null;
                            console.log('[TCP DeviceManager] Retrying TCP 1716 bind...');
                            this.startTcpServer();
                        }, 2000);
                        if (this._retryTcpTimer.unref) this._retryTcpTimer.unref();
                    }
                }
            });

            this.tcpServer.listen(this.port, () => {
                console.log(`[TCP DeviceManager] Listening for incoming KDE Connect connections on TCP ${this.port}`);
            });
        } catch (e) {
            console.error('[TCP DeviceManager] Failed to start TCP server:', e.message);
        }
    }

    upgradeServerTLSSocket(rawSocket, identityPacket) {
        try {
            // KDE Connect uses inverted TLS roles: the device that RECEIVES the TCP connection
            // performs the TLS handshake as the CLIENT (sends ClientHello). The connecting device
            // performs the TLS handshake as the SERVER. Node's tls.connect() with the `socket`
            // option wraps an existing accepted TCP socket and begins a client-mode handshake.
            const tlsSocket = tls.connect({
                socket: rawSocket,
                key: this.crypto.privateKey,
                cert: this.crypto.certificate,
                rejectUnauthorized: false,
                requestCert: false,
                minVersion: 'TLSv1.2',
                maxVersion: 'TLSv1.2'
            });

            let handshakeDone = false;

            // Log exact cause if phone aborts during handshake
            const cleanupHandshake = (reason) => {
                if (!handshakeDone) {
                    console.warn(`[TCP DeviceManager] TLS Handshake aborted by ${rawSocket.remoteAddress}: ${reason}`);
                }
            };

            tlsSocket.on('close', () => cleanupHandshake('Socket closed'));
            tlsSocket.on('end', () => cleanupHandshake('Socket ended'));
            tlsSocket.on('error', (err) => cleanupHandshake(`Error: ${err.message}`));

            const onHandshakeComplete = () => {
                if (handshakeDone) return;
                handshakeDone = true;
                console.log(`[TCP DeviceManager] Encrypted TLS Handshake Established with ${rawSocket.remoteAddress}`);
                this.emit('incomingConnection', { tlsSocket, identityPacket });
            };

            tlsSocket.on('secure', onHandshakeComplete);
            tlsSocket.on('secureConnect', onHandshakeComplete);
        } catch (err) {
            console.error('[TCP DeviceManager] TLS Server upgrade error:', err.message);
        }
    }

    startUdpDiscovery() {
        this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.udpSocket.on('error', (err) => {
            console.error('[UDP DeviceManager] Socket Error:', err.message);
            if (err.code === 'EADDRINUSE') {
                this.tryStopNativeKdeConnect();
                this.emit('fatalError', {
                    code: 'PORT_1716_IN_USE',
                    message: `UDP port ${this.port} is already in use — the native KDE Connect daemon (kdeconnectd) is running. Stop it with:  systemctl --user stop kdeconnectd   (or: killall kdeconnectd)  and restart the app.`
                });
                if (!this._retryUdpTimer) {
                    this._retryUdpTimer = setTimeout(() => {
                        this._retryUdpTimer = null;
                        this.udpSocket = null;
                        console.log('[UDP DeviceManager] Retrying UDP 1716 bind...');
                        this.startUdpDiscovery();
                    }, 2000);
                    if (this._retryUdpTimer.unref) this._retryUdpTimer.unref();
                }
            }
        });

        this.udpSocket.on('message', (msg, rinfo) => {
            this.handleIncomingBroadcast(msg, rinfo);
        });

        this.udpSocket.on('listening', () => {
            const address = this.udpSocket.address();
            console.log(`[UDP DeviceManager] Listening for KDE Connect devices on UDP ${address.address}:${address.port}`);
            try {
                this.udpSocket.setBroadcast(true);
            } catch (e) {
                console.warn('[UDP DeviceManager] Broadcast set warning:', e.message);
            }

            // Start broadcasting identity packet every 5 seconds
            this.sendIdentityBroadcast();
            this.broadcastInterval = setInterval(() => this.sendIdentityBroadcast(), 5000);
        });

        try {
            this.udpSocket.bind(this.port);
        } catch (e) {
            console.error('[UDP DeviceManager] Bind failed:', e.message);
        }
    }

    handleIncomingBroadcast(msgBuffer, rinfo) {
        try {
            const rawText = msgBuffer.toString('utf8').trim();
            const packet = JSON.parse(rawText);

            if (packet.type === 'kdeconnect.identity' && packet.body) {
                const remoteDeviceId = packet.body.deviceId;
                if (!remoteDeviceId || remoteDeviceId === this.crypto.deviceId) return;

                const deviceData = {
                    id: remoteDeviceId,
                    name: packet.body.deviceName || 'Android Device',
                    type: packet.body.deviceType || 'phone',
                    ip: rinfo.address,
                    port: packet.body.tcpPort || 1716,
                    protocolVersion: packet.body.protocolVersion || 7,
                    incomingCapabilities: packet.body.incomingCapabilities || [],
                    outgoingCapabilities: packet.body.outgoingCapabilities || [],
                    lastSeen: Date.now()
                };

                const isNew = !this.discoveredDevices.has(remoteDeviceId);
                this.discoveredDevices.set(remoteDeviceId, deviceData);

                if (isNew) {
                    console.log(`[UDP DeviceManager] Discovered Device: ${deviceData.name} (${deviceData.ip})`);
                    // Kick the phone into connecting right away instead of waiting for
                    // the next 5s broadcast. Only reply on first discovery to avoid
                    // triggering the phone to re-connect on every broadcast.
                    this.sendIdentityToIp(rinfo.address);
                    this.emit('deviceDiscovered', deviceData);
                } else {
                    this.emit('deviceUpdated', deviceData);
                }
            }
        } catch (err) {
            // Ignore invalid or non-JSON UDP packets
        }
    }

    sendIdentityToIp(targetIp) {
        if (!this.udpSocket) return;
        const identityPacket = this.crypto.getIdentityPacket();
        identityPacket.body.tcpPort = 1716;
        const message = Buffer.from(JSON.stringify(identityPacket) + '\n', 'utf8');
        this.udpSocket.send(message, 0, message.length, this.port, targetIp, (err) => {
            if (err && err.code !== 'ENETUNREACH') {
                // Ignore transient network errors
            }
        });
    }


    sendIdentityBroadcast() {
        if (!this.udpSocket) return;

        const identityPacket = this.crypto.getIdentityPacket();
        identityPacket.body.tcpPort = 1716;

        const jsonStr = JSON.stringify(identityPacket) + '\n';
        const message = Buffer.from(jsonStr, 'utf8');

        const broadcastAddresses = this.getBroadcastAddresses();
        broadcastAddresses.forEach((ip) => {
            this.udpSocket.send(message, 0, message.length, this.port, ip, (err) => {
                if (err && err.code !== 'ENETUNREACH') {
                    // Ignore transient network errors
                }
            });
        });
    }

    getBroadcastAddresses() {
        const addresses = new Set(['255.255.255.255']);
        const interfaces = os.networkInterfaces();

        for (const name of Object.keys(interfaces)) {
            for (const net of interfaces[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    const parts = net.address.split('.');
                    if (parts.length === 4) {
                        addresses.add(`${parts[0]}.${parts[1]}.${parts[2]}.255`);
                    }
                }
            }
        }
        return Array.from(addresses);
    }

    tryStopNativeKdeConnect() {
        if (process.platform !== 'linux') return;
        try {
            const { execSync } = require('child_process');
            console.log('[DeviceManager] Port 1716 in use. Attempting to stop native kdeconnectd...');
            execSync('systemctl --user stop kdeconnectd || killall kdeconnectd || true');
        } catch (e) {
            console.warn('[DeviceManager] Failed to stop native kdeconnectd:', e.message);
        }
    }

    stopDiscovery() {
        if (this.broadcastInterval) {
            clearInterval(this.broadcastInterval);
            this.broadcastInterval = null;
        }
        if (this._retryTcpTimer) {
            clearTimeout(this._retryTcpTimer);
            this._retryTcpTimer = null;
        }
        if (this._retryUdpTimer) {
            clearTimeout(this._retryUdpTimer);
            this._retryUdpTimer = null;
        }
        if (this.udpSocket) {
            this.udpSocket.close();
            this.udpSocket = null;
        }
        if (this.tcpServer) {
            this.tcpServer.close();
            this.tcpServer = null;
        }
    }

    getDiscoveredDevices() {
        return Array.from(this.discoveredDevices.values());
    }
}

module.exports = DeviceManager;
