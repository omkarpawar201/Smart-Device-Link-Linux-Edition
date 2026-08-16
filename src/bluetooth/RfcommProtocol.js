const EventEmitter = require('events');

const FRAME_HEADER_LEN = 4;
const MAX_FRAME_LEN = 0x100000; // 1 MiB sanity cap
const HEARTBEAT_MS = 5000;
const MISSED_HEARTBEAT_THRESHOLD = 3;

// App-level protocol over the custom RFCOMM link (mirrors Microsoft Phone Link's
// approach of running its own framing + keep-alives instead of any native profile).
//
// Frame format (shared with the Android companion app's Protocol.kt):
//   [4-byte big-endian length][UTF-8 JSON payload]
//
// Messages (JSON object with a "t" type field):
//   PC -> Phone: hello, ping, call.answer, call.reject, call.hangup,
//                call.dial {number}, call.mute {muted}, call.volume {level}
//   Phone -> PC: hello, pong, link.ready, call.ring {number,name},
//                call.state {state: talking|ended|missed, number, name}
class RfcommProtocol extends EventEmitter {
    constructor(client, options = {}) {
        super();
        this.client = client;
        this.heartbeatMs = options.heartbeatMs || HEARTBEAT_MS;
        this.missedHeartbeatThreshold = options.missedHeartbeatThreshold || MISSED_HEARTBEAT_THRESHOLD;

        this.connected = false;
        this.buffer = Buffer.alloc(0);
        this.heartbeatTimer = null;
        this.lastPongAt = 0;

        client.on('connected', (info) => this.handleConnected(info));
        client.on('data', (chunk) => this.handleData(chunk));
        client.on('disconnected', () => this.handleDisconnected());
    }

    // ---------- framing ----------

    encodeFrame(obj) {
        const json = Buffer.from(JSON.stringify(obj), 'utf8');
        const header = Buffer.alloc(FRAME_HEADER_LEN);
        header.writeUInt32BE(json.length, 0);
        return Buffer.concat([header, json]);
    }

    sendMessage(obj) {
        if (!this.connected || !this.client) return false;
        return this.client.send(this.encodeFrame(obj));
    }

    // ---------- link lifecycle ----------

    handleConnected(info) {
        this.connected = true;
        this.buffer = Buffer.alloc(0);
        this.lastPongAt = Date.now();
        this.sendMessage({ t: 'hello', v: 1 });
        this.startHeartbeat();
        this.emit('linkUp', info);
    }

    handleDisconnected() {
        this.connected = false;
        this.stopHeartbeat();
        this.buffer = Buffer.alloc(0);
        this.emit('linkDown');
    }

    handleData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (true) {
            if (this.buffer.length < FRAME_HEADER_LEN) return;
            const len = this.buffer.readUInt32BE(0);
            if (len < 0 || len > MAX_FRAME_LEN) {
                console.warn('[RfcommProtocol] Invalid frame length, discarding buffer');
                this.buffer = Buffer.alloc(0);
                return;
            }
            if (this.buffer.length < FRAME_HEADER_LEN + len) return;
            const payload = this.buffer.slice(FRAME_HEADER_LEN, FRAME_HEADER_LEN + len).toString('utf8');
            this.buffer = this.buffer.slice(FRAME_HEADER_LEN + len);
            this.processMessage(payload);
        }
    }

    processMessage(rawJson) {
        let msg;
        try {
            msg = JSON.parse(rawJson);
        } catch (e) {
            return;
        }
        if (!msg || typeof msg !== 'object') return;
        const type = msg.t;
        switch (type) {
            case 'pong':
                this.lastPongAt = Date.now();
                break;
            case 'ping':
                // The phone's own heartbeat expects a pong within ~15s, or it
                // drops the link. Answer it like the phone answers ours.
                this.sendMessage({ t: 'pong' });
                break;
            case 'hello':
                // Reply with our own hello to complete the two-way handshake.
                this.sendMessage({ t: 'hello', v: 1 });
                this.emit('handshake');
                break;
            case 'link.ready':
                this.emit('linkReady');
                break;
            case 'call.ring':
                this.emit('callRing', {
                    number: msg.number || null,
                    name: msg.name || null
                });
                break;
            case 'call.state':
                this.emit('callState', {
                    state: msg.state,
                    number: msg.number || null,
                    name: msg.name || null
                });
                break;
            default:
                this.emit('message', msg);
        }
    }

    // ---------- heartbeat / watchdog ----------

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.sendMessage({ t: 'ping' });
            const age = Date.now() - this.lastPongAt;
            if (age > this.heartbeatMs * this.missedHeartbeatThreshold) {
                console.warn(`[RfcommProtocol] No pong for ${age}ms — link considered dead`);
                this.emit('linkDead');
                if (this.client && typeof this.client.drop === 'function') {
                    // drop() tears down the socket but keeps auto-reconnect armed.
                    this.client.drop();
                }
            }
        }, this.heartbeatMs);
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    // ---------- call control (PC -> phone) ----------

    answerCall() {
        return this.sendMessage({ t: 'call.answer' });
    }

    rejectCall() {
        return this.sendMessage({ t: 'call.reject' });
    }

    hangupCall() {
        return this.sendMessage({ t: 'call.hangup' });
    }

    dialNumber(number) {
        const clean = (number || '').toString().replace(/[^\d+]/g, '');
        if (!clean) return false;
        return this.sendMessage({ t: 'call.dial', number: clean });
    }

    setMicMuted(muted) {
        return this.sendMessage({ t: 'call.mute', muted: !!muted });
    }

    setVolume(level) {
        const clamped = Math.max(0, Math.min(15, Math.floor(level)));
        return this.sendMessage({ t: 'call.volume', level: clamped });
    }
}

module.exports = RfcommProtocol;
