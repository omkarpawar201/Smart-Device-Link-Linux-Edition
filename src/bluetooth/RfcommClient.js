const EventEmitter = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_SERVICE_UUID = '8f2d9c40-1a2b-4b8e-9f2c-3d4e5f6a7b8c';

const DEFAULT_BRIDGE = process.platform === 'win32' ? 'rfcomm-bridge.ps1' : 'rfcomm-listen.py';

// Spawned helper scripts can't live inside app.asar, so packaged builds keep a
// real copy under process.resourcesPath (electron-builder extraResources).
function defaultBridgePath() {
    try {
        const { app } = require('electron');
        if (app && app.isPackaged) {
            return path.join(process.resourcesPath, 'src', 'bluetooth', DEFAULT_BRIDGE);
        }
    } catch (e) { /* dev mode / non-Electron */ }
    return path.join(__dirname, DEFAULT_BRIDGE);
}

// Shares the service UUID + frame format with the Android companion app
// (android/app/src/main/java/com/diyphonelink/app/Protocol.kt).
class RfcommClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.bridgeScript = options.bridgeScript || defaultBridgePath();
        this.serviceUuid = options.serviceUuid || DEFAULT_SERVICE_UUID;
        this.configPath = options.configPath || null;
        this.phoneNameHint = options.phoneNameHint || null;

        this.child = null;
        this.connected = false;
        this.connecting = false;
        this.connectedMac = null;
        this.connectedName = null;
        this.bridgeReady = false;
        this.pendingBuffer = [];
        this.shouldStayConnected = false;
        this.reconnectDelayMs = 3000;
        this.reconnectTimer = null;
        this.manualAddress = null;
        // Phone-initiated server mode: this phone will not answer PC-initiated
        // connect() calls, so the bridge runs as the RFCOMM listener by default.
        this.listen = options.listen !== false;
    }

    // ---------- config persistence ----------

    loadConfig() {
        if (!this.configPath) return {};
        try {
            return JSON.parse(fs.readFileSync(this.configPath, 'utf8')) || {};
        } catch (e) {
            return {};
        }
    }

    saveConfig(partial) {
        if (!this.configPath) return;
        try {
            const merged = { ...this.loadConfig(), ...partial };
            fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2), 'utf8');
        } catch (e) {
            console.warn('[RfcommClient] saveConfig failed:', e.message);
        }
    }

    setPhoneMac(mac) {
        this.manualAddress = mac || null;
        this.saveConfig({ mac: mac || null });
    }

    getPhoneMac() {
        return this.manualAddress || (this.loadConfig() && this.loadConfig().mac) || null;
    }

    // ---------- discovery ----------

    // Lists paired classic-Bluetooth devices (name + MAC). Windows pulls them
    // from PnP via PowerShell; Linux uses bluetoothctl (bluez).
    discoverPairedDevices() {
        if (process.platform !== 'win32') {
            return this._discoverPairedLinux();
        }
        return new Promise((resolve) => {
            const script = `
$ErrorActionPreference = 'SilentlyContinue'
$list = @()
Get-PnpDevice -Class Bluetooth | Where-Object { $_.FriendlyName -and $_.InstanceId -match '(?i)DEV_([0-9A-F]{12})' } | ForEach-Object {
    $mac = $matches[1]
    if (-not $mac) {
        $prop = Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Bluetooth_DeviceAddress' -ErrorAction SilentlyContinue
        if ($prop -and $prop.Data) { $mac = ($prop.Data.ToString() -replace '[^0-9a-fA-F]', '') }
    }
    if ($mac -and $mac.Length -eq 12) {
        $list += [pscustomobject]@{ Name = $_.FriendlyName; Mac = $mac.ToUpperInvariant() }
    }
}
$list | Select-Object -Unique | ConvertTo-Json -Compress
`;
            const child = spawn('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
            ], { windowsHide: true });

            const killer = setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } }, 15000);

            let out = '';
            let err = '';
            child.stdout.on('data', (d) => { out += d.toString('utf8'); });
            child.stderr.on('data', (d) => { err += d.toString('utf8'); });
            child.on('error', (e) => {
                clearTimeout(killer);
                console.warn('[RfcommClient] device scan failed:', e.message);
                resolve([]);
            });
            child.on('exit', () => {
                clearTimeout(killer);
                try {
                    const parsed = JSON.parse(out.trim());
                    const arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
                    resolve(arr
                        .map((d) => ({
                            name: String(d.Name || 'Bluetooth device'),
                            mac: String(d.Mac || '').toUpperCase()
                        }))
                        .filter((d) => /^[0-9A-F]{12}$/.test(d.mac)));
                } catch (e) {
                    if (err.trim()) console.warn('[RfcommClient] device scan stderr:', err.trim().slice(0, 300));
                    resolve([]);
                }
            });
        });
    }

    _discoverPairedLinux() {
        return new Promise((resolve) => {
            const run = (cmd, args) => new Promise((res) => {
                let child;
                try {
                    child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
                } catch (e) {
                    return res({ out: '', err: e.message });
                }
                let out = '';
                let err = '';
                child.stdout.on('data', (d) => { out += d.toString('utf8'); });
                child.stderr.on('data', (d) => { err += d.toString('utf8'); });
                child.on('error', (e) => res({ out, err: e.message }));
                child.on('close', () => res({ out, err }));
            });

            // bluetoothctl paired-devices lists classic + LE paired devices:
            //   "Device AA:BB:CC:DD:EE:FF Phone Name"
            run('bluetoothctl', ['paired-devices'])
                .then(({ out }) => {
                    const devices = String(out || '')
                        .split(/\r?\n/)
                        .map((l) => l.trim())
                        .map((l) => {
                            const m = l.match(/^Device\s+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})(?:\s+(.*))?$/);
                            if (!m) return null;
                            const name = (m[2] || '').trim();
                            return {
                                name: name || 'Bluetooth device',
                                mac: m[1].replace(/:/g, '').toUpperCase()
                            };
                        })
                        .filter((d) => d && /^[0-9A-F]{12}$/.test(d.mac));
                    resolve(devices);
                })
                .catch((e) => {
                    console.warn('[RfcommClient] bluetoothctl scan failed:', e.message);
                    resolve([]);
                });
        });
    }

    async resolvePhoneMac(nameHint) {
        const configured = this.getPhoneMac();
        if (configured) return { mac: configured, name: nameHint || this.connectedName || 'Configured phone', source: 'config' };

        let devices = [];
        try {
            devices = await this.discoverPairedDevices();
        } catch (e) {
            console.warn('[RfcommClient] discoverPairedDevices failed:', e.message);
        }
        if (!devices.length) return null;

        const hint = (nameHint || this.phoneNameHint || '').trim();
        if (hint) {
            const h = hint.toLowerCase();
            const exact = devices.find((d) => d.name.toLowerCase() === h);
            if (exact) return { ...exact, source: 'name' };
            const firstWord = h.split(/\s+/)[0];
            const fuzzy = devices.find((d) => d.name.toLowerCase().includes(firstWord));
            if (fuzzy) return { ...fuzzy, source: 'name' };
        }

        const phoneLike = devices.find((d) => /phone|galaxy|pixel|oneplus|xiaomi|redmi|oppo|vivo|realme|huawei|honor|mot\b/i.test(d.name));
        if (phoneLike) return { ...phoneLike, source: 'auto' };
        return devices[0] ? { ...devices[0], source: 'first' } : null;
    }

    // ---------- connect / send / disconnect ----------

    async connect({ mac, name } = {}) {
        if (mac && this.connected && this.connectedMac && mac.toUpperCase() !== this.connectedMac.toUpperCase()) {
            this.shouldStayConnected = false;
            this.disconnect();
        }
        if (this.connected) return true;
        if (this.connecting) return false;

        let target = null;
        if (mac) {
            target = { mac, name: name || this.connectedName || 'Phone' };
        } else if (this.listen) {
            // In server mode the phone initiates, so no target address is needed.
            target = { mac: null, name: this.connectedName || 'Phone' };
        } else {
            target = await this.resolvePhoneMac(name);
        }

        if (!target) {
            this.emit('error', {
                code: 'NO_PAIRED_PHONE',
                message: 'No paired Bluetooth phone found. Pair the phone with Windows, then grant the companion app the Bluetooth permission.'
            });
            return false;
        }

        this.connecting = true;
        this.shouldStayConnected = true;
        this.connectedName = target.name;
        console.log(`[RfcommClient] Connecting to ${target.name} (${target.mac}) over RFCOMM ${this.serviceUuid}`);
        this.emit('connecting', { mac: target.mac, name: target.name });
        this.spawnBridge(target.mac);
        return true;
    }

    spawnBridge(mac) {
        if (!this.bridgeScript || !fs.existsSync(this.bridgeScript)) {
            console.error('[RfcommClient] rfcomm-bridge.ps1 not found at', this.bridgeScript);
            this.connecting = false;
            this.emit('error', { code: 'BRIDGE_MISSING', message: 'rfcomm-bridge.ps1 not found' });
            return;
        }

        // Never run two listeners: each bridge registers its own SDP record, and a
        // second registration overwrites the first, so a late duplicate spawn would
        // repoint the phone at a different channel. Kill any prior bridge first.
        if (this.child) {
            try { this.child.kill(); } catch (e) { /* ignore */ }
            this.child = null;
        }

        let args;
        let command;
        if (process.platform === 'win32') {
            command = 'powershell.exe';
            args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.bridgeScript];
            if (this.listen) args.push('-Listen');
            args.push('-Guid', this.serviceUuid);
            if (mac) args.push('-Mac', mac);
        } else {
            // Linux: BlueZ ProfileManager1 listener (rfcomm-listen.py). It is
            // always the server role — the phone dials in over SDP, exactly the
            // topology the Windows -Listen mode provides.
            command = 'python3';
            args = ['-u', this.bridgeScript, this.serviceUuid];
        }

        let child;
        try {
            child = spawn(command, args, { windowsHide: true });
        } catch (e) {
            this.connecting = false;
            this.emit('error', { code: 'SPAWN_FAILED', message: e.message });
            return;
        }

        this.child = child;
        this.connectedMac = mac;
        this.bridgeReady = false;
        this.pendingBuffer = [];

        child.stdout.on('data', (chunk) => {
            if (this.bridgeReady) {
                this.emit('data', chunk);
            } else {
                this.pendingBuffer.push(chunk);
            }
        });

        let stderrTail = '';
        child.stderr.on('data', (chunk) => {
            stderrTail += chunk.toString('utf8');
            let idx;
            while ((idx = stderrTail.indexOf('\n')) !== -1) {
                const line = stderrTail.slice(0, idx).trim();
                stderrTail = stderrTail.slice(idx + 1);
                if (line) this.handleStatusLine(line);
            }
        });

        child.on('error', (err) => {
            console.error('[RfcommClient] bridge process error:', err.message);
            this.connecting = false;
            this.emit('error', { code: 'BRIDGE_ERROR', message: err.message });
        });

        child.on('exit', (code, signal) => {
            if (this.child === child) this.child = null;
            const wasConnected = this.connected;
            this.connecting = false;
            this.connected = false;
            this.bridgeReady = false;
            this.pendingBuffer = [];
            console.log(`[RfcommClient] bridge exited (code=${code} signal=${signal})`);
            if (wasConnected || this.shouldStayConnected) {
                this.emit('disconnected', { mac, code, signal, graceful: code === 0 });
                this.scheduleReconnect();
            }
        });
    }

    handleStatusLine(line) {
        if (line.startsWith('[STATUS] CONNECTED') || line.startsWith('[STATUS] ACCEPTED')) {
            console.log(`[RfcommClient] RFCOMM link up: ${line}`);
            this.connecting = false;
            this.connected = true;
            this.bridgeReady = true;
            this.reconnectDelayMs = 3000;
            const pending = this.pendingBuffer;
            this.pendingBuffer = [];
            this.emit('connected', {
                mac: this.connectedMac,
                name: this.connectedName,
                uuid: this.serviceUuid
            });
            for (const chunk of pending) this.emit('data', chunk);
        } else if (line.startsWith('[STATUS] ERROR_CONNECT')) {
            this.connecting = false;
            const message = line.slice('[STATUS] ERROR_CONNECT: '.length) || 'RFCOMM connect failed';
            this.emit('error', { code: 'CONNECT_FAILED', message });
            if (this.shouldStayConnected) this.scheduleReconnect();
        } else if (line.startsWith('[STATUS] ERROR_INVALID_MAC')) {
            this.connecting = false;
            this.emit('error', { code: 'INVALID_MAC', message: 'Configured MAC is not a valid 12-hex Bluetooth address' });
        } else if (line.startsWith('[STATUS] ERROR_LISTEN')) {
            this.connecting = false;
            const message = line.slice('[STATUS] ERROR_LISTEN'.length).replace(/^:\s*/, '') || 'RFCOMM listen failed';
            this.emit('error', { code: 'LISTEN_FAILED', message });
        } else if (line.startsWith('[STATUS] ERROR')) {
            console.warn('[RfcommClient] bridge error:', line);
        } else {
            console.log('[RfcommClient] bridge:', line);
        }
    }

    send(data) {
        if (!this.connected || !this.child || !this.child.stdin || !this.child.stdin.writable) return false;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        try {
            return this.child.stdin.write(buf);
        } catch (e) {
            return false;
        }
    }

    // Tears down the current link but keeps auto-reconnect armed (used when the
    // heartbeat watchdog decides the link is dead).
    drop() {
        const child = this.child;
        this.child = null;
        if (child) {
            try { child.stdin.end(); } catch (e) { /* ignore */ }
            try { child.kill(); } catch (e) { /* ignore */ }
        }
        const wasConnected = this.connected;
        this.connecting = false;
        this.connected = false;
        this.bridgeReady = false;
        this.pendingBuffer = [];
        if (wasConnected) this.emit('disconnected', { graceful: false });
        this.scheduleReconnect();
    }

    disconnect() {
        this.shouldStayConnected = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const child = this.child;
        this.child = null;
        if (child) {
            try { child.stdin.end(); } catch (e) { /* ignore */ }
            try { child.kill(); } catch (e) { /* ignore */ }
        }
        const wasConnected = this.connected;
        this.connecting = false;
        this.connected = false;
        this.bridgeReady = false;
        this.pendingBuffer = [];
        if (wasConnected) this.emit('disconnected', { graceful: true });
    }

    scheduleReconnect() {
        if (!this.shouldStayConnected || this.connected || this.connecting) return;
        if (this.reconnectTimer) return;
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
        console.log(`[RfcommClient] Reconnecting in ${this.reconnectDelayMs}ms...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connecting = false;
            this.connect({ name: this.connectedName });
        }, this.reconnectDelayMs);
    }
}

RfcommClient.SERVICE_UUID = DEFAULT_SERVICE_UUID;

module.exports = RfcommClient;
