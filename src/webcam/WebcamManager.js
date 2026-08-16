const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const EventEmitter = require('events');

/**
 * Phone-as-webcam engine.
 *
 * Spawns webcam-bridge.ps1, which polls the IP Webcam app on the phone
 * (http://<phone-ip>:8080/shot.jpg) and pushes decoded frames into the
 * UnityCapture virtual camera shared memory. The UnityCapture DirectShow
 * filter ("Phone Camera") is what meeting apps actually see.
 *
 * Also drives install-webcam.ps1 to register/unregister that filter with a
 * custom friendly name. Install/uninstall self-elevate via UAC and report back
 * through a result file because the elevated child cannot pipe stdout.
 */
class WebcamManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this._linux = process.platform !== 'win32';
        this.bridgeScript = options.bridgeScript || path.join(__dirname, 'webcam-bridge.ps1');
        this.installScript = options.installScript || path.join(__dirname, 'install-webcam.ps1');
        this.dllDir = options.dllDir || path.join(__dirname, '..', '..', 'resources', 'unitycapture');

        this.child = null;
        this.running = false;
        this.stopRequested = false;
        this._previewTimer = null;
        this._relay = null;
        this._previewFeed = null;
        this.config = null;
        this.capNum = 0;
        this.frames = 0;
        this.fps = 0;
        this.size = null;
        this.consumer = false;
        this.feedUp = false;
        this.feedError = null;
        this.lastFramePath = null;
        this.startedAt = null;
        this.lastLog = [];
    }

    getStatus() {
        return {
            running: this.running,
            source: this.config ? this.config.source : null,
            capNum: this.capNum,
            frames: this.frames,
            fps: this.fps,
            size: this.size,
            consumer: this.consumer,
            feedUp: this.feedUp,
            feedError: this.feedError,
            startedAt: this.startedAt,
            config: this.config,
            lastFramePath: this.lastFramePath
        };
    }

    _log(level, line) {
        const text = String(line || '').trim();
        if (!text) return;
        this.lastLog.push(`[${level}] ${text}`);
        if (this.lastLog.length > 200) this.lastLog.splice(0, this.lastLog.length - 200);
        console.log(`[Webcam] ${text}`);
        this.emit('log', { level, line: text });
    }

    // ---- Driver management (install-webcam.ps1 / v4l2loopback on Linux) ----

    // Linux: locate the v4l2loopback device named "Phone Camera" (created with
    // card_label=Phone Camera). Returns { name, capNum, path } or null.
    _linuxDevice() {
        try {
            const dir = '/sys/devices/virtual/video4linux';
            if (!fs.existsSync(dir)) return null;
            for (const entry of fs.readdirSync(dir)) {
                const nameFile = path.join(dir, entry, 'name');
                if (!fs.existsSync(nameFile)) continue;
                const name = fs.readFileSync(nameFile, 'utf8').trim();
                if (/phone\s*camera|diyphonelink/i.test(name)) {
                    const capNum = (entry.match(/(\d+)/) || [])[1];
                    return { name, capNum: capNum ? Number(capNum) : 0, path: '/dev/' + entry };
                }
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // Linux: is the v4l2loopback kernel module present (loadable)?
    _moduleAvailable() {
        return new Promise((resolve) => {
            if (this._moduleAvailableResult !== undefined) {
                return resolve(this._moduleAvailableResult);
            }
            const { execFile } = require('child_process');
            execFile('modprobe', ['-n', 'v4l2loopback'], (err) => {
                this._moduleAvailableResult = !err;
                resolve(this._moduleAvailableResult);
            });
        });
    }

    _pkexecModprobe(args) {
        return new Promise((resolve) => {
            const child = spawn('pkexec', ['modprobe', ...args], { windowsHide: true });
            let err = '';
            child.stderr.on('data', (d) => (err += d.toString()));
            child.on('error', (e) => resolve(`Could not run pkexec modprobe: ${e.message}`));
            child.on('close', (code) => {
                if (code === 0) return resolve(null);
                resolve((err || `modprobe exited ${code} (authorization cancelled?)`).trim());
            });
        });
    }

    async driverStatus() {
        if (this._linux) {
            const dev = this._linuxDevice();
            const devices = dev ? [{ Name: dev.name, capNum: dev.capNum, path: dev.path }] : [];
            const installed = await this._moduleAvailable();
            return { ok: true, devices, installed, loaded: devices.length > 0 };
        }
        const { out } = await this._runInstallScript(['-Action', 'status']);
        try {
            const parsed = JSON.parse(out || '[]');
            const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
            return { ok: true, devices: list };
        } catch (e) {
            return { ok: false, devices: [], error: `Unparsable status: ${out}` };
        }
    }

    _tempResultPath() {
        return path.join(os.tmpdir(), `phonelink-webcam-result-${process.pid}.txt`);
    }

    _runInstallScript(args) {
        return new Promise((resolve, reject) => {
            const child = spawn(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.installScript, ...args],
                { windowsHide: true }
            );
            let out = '';
            let err = '';
            child.stdout.on('data', (d) => (out += d.toString()));
            child.stderr.on('data', (d) => (err += d.toString()));
            child.on('error', (e) => reject(e));
            child.on('close', (code) => {
                if (code === 0) {
                    return resolve({ code, out: out.trim(), err: err.trim() });
                }
                // The elevated install/uninstall child writes the real error to
                // the result file (it cannot pipe stdout back), so prefer that
                // over the generic "exited N" message.
                let msg = (err || `install-webcam exited ${code}`).trim();
                const resultPathIdx = args.findIndex((a) => a === '-ResultPath');
                if (resultPathIdx !== -1 && args[resultPathIdx + 1]) {
                    try {
                        const text = fs.readFileSync(args[resultPathIdx + 1], 'utf8').trim();
                        if (text.startsWith('ERR ')) msg = text.slice(4);
                        else if (text) msg = text;
                    } catch (e) { /* ignore */ }
                }
                reject(new Error(msg));
            });
        });
    }

    async installDriver({ name = 'Phone Camera', devices = 1 } = {}) {
        if (this._linux) {
            if (this._linuxDevice()) {
                return { ok: true, message: 'Phone Camera virtual device is already loaded' };
            }
            if (!(await this._moduleAvailable())) {
                return {
                    ok: false,
                    error: 'The v4l2loopback kernel module is not installed. Install it with "sudo apt install v4l2loopback-dkms" (or the linux-modules-extra package for your kernel), then try again.'
                };
            }
            const err = await this._pkexecModprobe(['v4l2loopback', 'exclusive_caps=1', 'card_label=' + name]);
            if (err) return { ok: false, error: err };
            const dev = this._linuxDevice();
            return dev
                ? { ok: true, message: `${name} loaded at ${dev.path}` }
                : { ok: false, error: 'Module loaded but the /dev device did not appear. Recheck your v4l2loopback setup.' };
        }
        const resultPath = this._tempResultPath();
        try { fs.unlinkSync(resultPath); } catch (e) { /* ignore */ }
        const { code } = await this._runInstallScript([
            '-Action', 'install',
            '-Name', name,
            '-Devices', String(devices),
            '-DllDir', this.dllDir,
            '-ResultPath', resultPath
        ]);
        return this._readDriverResult(resultPath, code, 'install');
    }

    async uninstallDriver() {
        if (this._linux) {
            if (!this._linuxDevice()) {
                return { ok: true, message: 'No Phone Camera virtual device to remove' };
            }
            const err = await this._pkexecModprobe(['-r', 'v4l2loopback']);
            if (err) return { ok: false, error: err + ' (close any app currently using the camera first)' };
            return { ok: true, message: 'Phone Camera virtual device removed' };
        }
        const resultPath = this._tempResultPath();
        try { fs.unlinkSync(resultPath); } catch (e) { /* ignore */ }
        const { code } = await this._runInstallScript([
            '-Action', 'uninstall',
            '-ResultPath', resultPath
        ]);
        return this._readDriverResult(resultPath, code, 'uninstall');
    }

    _readDriverResult(resultPath, code, action) {
        let text = '';
        try { text = fs.readFileSync(resultPath, 'utf8').trim(); } catch (e) { /* ignore */ }
        if (text) {
            if (text.startsWith('ERR ')) {
                return { ok: false, error: text.slice(4) };
            }
            return { ok: true, message: text.slice(text.indexOf(' ') + 1) };
        }
        if (code === 0) {
            return { ok: true, message: `${action} completed` };
        }
        return { ok: false, error: `${action} failed with exit code ${code}` };
    }

    // ---- Frame pump (webcam-bridge.ps1) ----

    async start(options = {}) {
        if (this.running) {
            this.emit('status', this.getStatus());
            return this.getStatus();
        }
        if (this._linux) return this._startLinux(options);

        const url = options.url || '';
        if (!url) throw new Error('Missing webcam URL. Start the IP Webcam app on the phone (HTTP server on :8080).');

        this.config = {
            url,
            user: options.user || '',
            pass: options.pass || '',
            fps: options.fps || 30,
            capNum: options.capNum || 0,
            source: options.source || 'wifi'
        };
        this.capNum = this.config.capNum;
        this.frames = 0;
        this.fps = 0;
        this.size = null;
        this.consumer = false;
        this.feedUp = false;
        this.feedError = null;
        this.startedAt = Date.now();
        this.stopRequested = false;

        this.lastFramePath = options.lastFramePath || null;
        if (this.lastFramePath) {
            try { fs.mkdirSync(path.dirname(this.lastFramePath), { recursive: true }); } catch (e) { /* ignore */ }
        }

        const args = [
            '-Url', url,
            '-Fps', String(this.config.fps),
            '-CapNum', String(this.capNum)
        ];
        if (this.config.user) args.push('-User', this.config.user);
        if (this.config.pass) args.push('-Pass', this.config.pass);
        if (this.lastFramePath) args.push('-LastFrame', this.lastFramePath);

        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.bridgeScript, ...args],
            { windowsHide: true }
        );

        this.child = child;
        child.stderr.on('data', (d) => this._onBridgeOutput(d.toString()));
        child.on('error', (e) => {
            this._log('error', `bridge launch failed: ${e.message}`);
            this._shutdown('bridge launch failed');
        });
        child.on('exit', (code, signal) => {
            this._log('info', `bridge exited code=${code} signal=${signal || ''}`);
            if (this.stopRequested) {
                this._shutdown(null, code === 0 || !!signal);
                return;
            }
            this._shutdown(`webcam bridge exited unexpectedly (code ${code})`);
        });

        this.running = true;
        this.emit('status', this.getStatus());
        return this.getStatus();
    }

    // ---- Linux frame pump (ffmpeg -> v4l2loopback) ----

    // The URL handed to us by bridge.js is the phone's single-frame endpoint
    // (…/shot.jpg). Newer companion app builds expose a native live /video
    // (multipart/x-mixed-replace) stream — use it directly when present, since
    // it pushes frames at capture rate with no per-frame HTTP overhead. Older
    // builds only have /shot.jpg, so fall back to a local relay that polls it
    // and re-serves MJPEG. A small poller keeps writing shot.jpg so the
    // renderer gets a live preview.
    async _startLinux(options = {}) {
        const url = options.url || '';
        if (!url) throw new Error('Missing webcam URL. Start the camera server in the DIY Phone Link app on the phone (HTTP server on :8080).');

        const dev = this._linuxDevice();
        if (!dev) {
            throw new Error('Virtual camera is not loaded. Use "Install driver" (loads the v4l2loopback module) first.');
        }

        const baseUrl = url.replace(/\/shot\.jpg$/, '');
        let streamUrl = null;
        if (await this._probeMpjpg(baseUrl + '/video', options.user || '', options.pass || '')) {
            streamUrl = baseUrl + '/video';
            if (options.user || options.pass) {
                const u = encodeURIComponent(options.user || '');
                const p = encodeURIComponent(options.pass || '');
                streamUrl = baseUrl.replace(/^http:\/\//, `http://${u}:${p}@`) + '/video';
            }
        } else {
            const relay = await this._startJpegRelay({
                url,
                user: options.user || '',
                pass: options.pass || '',
                fps: options.fps || 30
            });
            streamUrl = relay.streamUrl;
        }

        this.config = {
            url,
            user: options.user || '',
            pass: options.pass || '',
            fps: options.fps || 30,
            capNum: dev.capNum,
            source: options.source || 'wifi'
        };
        this.capNum = dev.capNum;
        this.frames = 0;
        this.fps = 0;
        this.size = null;
        this.consumer = true;
        this.feedUp = false;
        this.feedError = null;
        this.startedAt = Date.now();
        this.stopRequested = false;

        this.lastFramePath = options.lastFramePath || null;
        if (this.lastFramePath) {
            try { fs.mkdirSync(path.dirname(this.lastFramePath), { recursive: true }); } catch (e) { /* ignore */ }
        }

        this._log('info', `ffmpeg → ${dev.path} from ${streamUrl}`);
        const child = spawn('ffmpeg', [
            '-hide_banner', '-loglevel', 'info', '-stats',
            '-rtbufsize', '64M',
            '-f', 'mpjpeg',
            '-i', streamUrl,
            '-vf', 'format=yuv420p',
            '-f', 'v4l2', dev.path
        ], { windowsHide: true });

        this.child = child;
        child.stderr.on('data', (d) => this._onLinuxFfmpegOutput(d.toString()));
        child.on('error', (e) => {
            this._log('error', `ffmpeg launch failed: ${e.message}`);
            this._shutdown('ffmpeg launch failed: ' + e.message);
        });
        child.on('exit', (code, signal) => {
            this._log('info', `ffmpeg exited code=${code} signal=${signal || ''}`);
            if (this.stopRequested) {
                this._shutdown(null, code === 0 || !!signal);
                return;
            }
            this._shutdown(`ffmpeg feed exited unexpectedly (code ${code})`);
        });

        this.running = true;
        if (this.lastFramePath) {
            await this._startPreviewFeed(streamUrl, options.user || '', options.pass || '');
        }
        this.emit('status', this.getStatus());
        return this.getStatus();
    }

    _onLinuxFfmpegOutput(text) {
        for (const rawLine of String(text).split(/[\r\n]+/)) {
            const line = rawLine.trim();
            if (!line) continue;

            const stats = line.match(/frame=\s*(\d+)\s+fps=\s*([\d.]+)/);
            if (stats) {
                this.frames = Number(stats[1]);
                this.fps = Number(stats[2]);
                this.feedUp = true;
                this.feedError = null;
                this.emit('status', this.getStatus());
                continue;
            }
            const streamM = line.match(/Stream\s+#.*Video:.*\b(\d{2,4})x(\d{2,4})\b/);
            if (streamM && !this.size) {
                this.size = { width: Number(streamM[1]), height: Number(streamM[2]) };
            }
            if (/error|failed|invalid|not supported|no such file|unable/i.test(line)) {
                this._log('error', line);
                if (this.running) {
                    this.feedError = line;
                    this.emit('status', this.getStatus());
                }
            }
        }
    }

    // Local MJPEG relay: polls the phone's /shot.jpg and serves it to local
    // consumers as a multipart/x-mixed-replace stream on 127.0.0.1 (the
    // companion app has no native /video endpoint). Any number of consumers
    // (ffmpeg -> virtual camera, the renderer preview) may connect; one shared
    // poller feeds them all. Returns { streamUrl, stop }.
    _startJpegRelay({ url, user = '', pass = '', fps = 30 }) {
        return new Promise((resolve, reject) => {
            let stopped = false;
            const clients = new Set();
            let timer = null;
            let inFlight = false;

            const stop = () => {
                if (stopped) return;
                stopped = true;
                if (timer) clearInterval(timer);
                timer = null;
                for (const res of clients) { try { res.destroy(); } catch (e) { /* ignore */ } }
                clients.clear();
                try { server.close(); } catch (e) { /* ignore */ }
            };

            // Poll from START-of-request to START-of-request (setInterval), so a
            // slow fetch no longer pushes the next request out by its own latency.
            // If a request is still in flight we skip the tick rather than queue.
            const periodMs = Math.max(16, Math.round(1000 / Math.min(60, Math.max(2, fps))));

            const writeTo = (res, buf) => {
                if (stopped || res.destroyed || !res.writable) return false;
                try {
                    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
                    res.write(buf);
                    res.write('\r\n');
                    return true;
                } catch (e) {
                    return false;
                }
            };

            // Shared poller: one shot.jpg fetch is fanned out to every client.
            const tick = () => {
                if (stopped || clients.size === 0) return;
                if (inFlight) return;
                inFlight = true;
                this._httpGetBuffer(url, user, pass, 3000)
                    .then((buf) => {
                        for (const res of Array.from(clients)) writeTo(res, buf);
                    })
                    .catch(() => { /* transient fetch error — keep polling */ })
                    .finally(() => { inFlight = false; });
            };

            const server = http.createServer((req, res) => {
                if (req.method !== 'GET' || req.url.split('?')[0] !== '/video') {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not found');
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
                    'Cache-Control': 'no-cache, no-store',
                    'Pragma': 'no-cache',
                    'Connection': 'close'
                });
                clients.add(res);
                const remove = () => { clients.delete(res); };
                res.on('close', remove);
                res.on('error', remove);
                if (clients.size === 1) {
                    timer = setInterval(tick, periodMs);
                    tick();
                }
            });

            this._relay = { stop, port: null };
            server.on('error', (e) => {
                stop();
                reject(new Error('MJPEG relay failed: ' + e.message));
            });
            server.listen(0, '127.0.0.1', () => {
                if (stopped) return;
                const port = server.address().port;
                this._relay.port = port;
                resolve({ streamUrl: `http://127.0.0.1:${port}/video`, stop });
            });
        });
    }

    _stopJpegRelay() {
        if (this._relay) this._relay.stop();
        this._relay = null;
    }

    // Drives the renderer preview: holds ONE persistent connection to the same
    // MJPEG stream ffmpeg consumes, parses the JPEG frames, and rewrites
    // lastFramePath at a modest cadence (the img reloads every ~150ms, so we
    // only need ~10-15 writes/sec). Reconnects with backoff if the stream
    // drops. Replaces the old 1 fps shot.jpg polling that made the preview look
    // like 2-3 fps while the virtual camera streamed at full rate.
    _startPreviewFeed(streamUrl, user = '', pass = '') {
        return new Promise((resolve) => {
            let stopped = false;
            let currentReq = null;
            let reconnectTimer = null;
            let buffer = Buffer.alloc(0);
            let lastWrite = 0;
            const MIN_WRITE_INTERVAL = 70; // ~14fps max to disk

            const stop = () => {
                if (stopped) return;
                stopped = true;
                try { if (currentReq) currentReq.destroy(); } catch (e) { /* ignore */ }
                currentReq = null;
                if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                buffer = Buffer.alloc(0);
            };

            const scheduleReconnect = () => {
                if (stopped || reconnectTimer) return;
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    connect();
                }, 2000);
            };

            const onChunk = (chunk) => {
                if (stopped) return;
                buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
                while (buffer.length > 0) {
                    const marker = buffer.indexOf('--frame\r\n', 0, 'utf8');
                    if (marker < 0) { buffer = Buffer.alloc(0); break; }
                    if (marker > 0) buffer = buffer.slice(marker);
                    const headEnd = buffer.indexOf('\r\n\r\n', 0, 'utf8');
                    if (headEnd < 0) break;
                    const head = buffer.subarray(0, headEnd).toString('utf8');
                    const m = /Content-Length:\s*(\d+)/i.exec(head);
                    if (!m) { buffer = buffer.slice(headEnd + 4); continue; }
                    const len = Number(m[1]);
                    const start = headEnd + 4;
                    if (buffer.length < start + len) break;
                    const jpeg = buffer.subarray(start, start + len);
                    buffer = buffer.slice(start + len);
                    if (jpeg.length) {
                        this.emit('frame', jpeg);
                        if (this.lastFramePath) {
                            const now = Date.now();
                            if (now - lastWrite >= MIN_WRITE_INTERVAL) {
                                lastWrite = now;
                                try {
                                    const tmp = this.lastFramePath + '.tmp';
                                    fs.writeFileSync(tmp, jpeg);
                                    fs.renameSync(tmp, this.lastFramePath);
                                } catch (e) { /* ignore */ }
                            }
                        }
                    }
                }
            };

            const connect = () => {
                if (stopped) return;
                try {
                    const mod = streamUrl.startsWith('https') ? require('https') : require('http');
                    const u = new URL(streamUrl);
                    const headers = {};
                    if (user || pass) headers.Authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
                    const req = mod.get(u, { headers, timeout: 15000 }, (res) => {
                        if (res.statusCode !== 200) {
                            res.resume();
                            scheduleReconnect();
                            return;
                        }
                        currentReq = res;
                        res.on('data', onChunk);
                        res.on('end', scheduleReconnect);
                        res.on('error', scheduleReconnect);
                        res.on('close', scheduleReconnect);
                    });
                    currentReq = req;
                    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } });
                    req.on('error', scheduleReconnect);
                } catch (e) {
                    scheduleReconnect();
                }
            };

            connect();
            this._previewFeed = { stop };
            resolve();
        });
    }

    _stopPreviewFeed() {
        if (this._previewFeed) this._previewFeed.stop();
        this._previewFeed = null;
    }

    // Checks whether the phone serves a native multipart/x-mixed-replace stream
    // at the given /video URL (companion app v0.1.0+). Opens a short connection,
    // reads the headers, and closes it again.
    _probeMpjpg(url, user, pass) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                resolve(ok);
            };
            try {
                const http = url.startsWith('https') ? require('https') : require('http');
                const u = new URL(url);
                const headers = {};
                if (user || pass) {
                    headers.Authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
                }
                const req = http.get(u, { headers, timeout: 4000 }, (res) => {
                    const ok = res.statusCode === 200 &&
                        /multipart\/x-mixed-replace/i.test(res.headers['content-type'] || '');
                    finish(ok);
                    res.resume();
                    setTimeout(() => { try { req.destroy(); } catch (e) { /* ignore */ } }, 300);
                });
                req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } finish(false); });
                req.on('error', () => finish(false));
            } catch (e) {
                finish(false);
            }
        });
    }

    _httpGetBuffer(url, user, pass, timeoutMs) {
        return new Promise((resolve, reject) => {
            const http = url.startsWith('https') ? require('https') : require('http');
            let u;
            try { u = new URL(url); } catch (e) { return reject(new Error('invalid URL')); }
            const headers = {};
            if (user || pass) {
                headers.Authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
            }
            const req = http.get(u, { headers, timeout: timeoutMs }, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('request timed out')));
            req.on('error', reject);
        });
    }

    _onBridgeOutput(text) {
        for (const rawLine of String(text).split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            const m = line.match(/^\[STATUS\]\s+(.*)$/);
            if (m) {
                this._handleStatus(m[1]);
            } else if (!this.running) {
                // Pre-start chatter (PowerShell banner, Add-Type) — ignore.
            } else {
                this._log('info', line);
            }
        }
    }

    _handleStatus(msg) {
        if (msg.startsWith('ready ')) {
            this._log('info', msg);
            return;
        }
        if (msg === 'idle') {
            this.consumer = false;
            this.emit('status', this.getStatus());
            return;
        }
        if (msg === 'consumer') {
            this.consumer = true;
            this.emit('status', this.getStatus());
            return;
        }
        if (msg === 'feed-up') {
            this.feedUp = true;
            this.feedError = null;
            this.emit('status', this.getStatus());
            return;
        }
        if (msg.startsWith('feed-down')) {
            this.feedUp = false;
            this.feedError = msg.slice('feed-down'.length).trim();
            this._log('error', `feed down: ${this.feedError}`);
            this.emit('status', this.getStatus());
            return;
        }
        if (msg.startsWith('frames ')) {
            const m = msg.match(/^frames (\d+) fps ([\d.]+) size (\d+)x(\d+)$/);
            if (m) {
                this.frames = Number(m[1]);
                this.fps = Number(m[2]);
                this.size = { width: Number(m[3]), height: Number(m[4]) };
            }
            this.emit('status', this.getStatus());
            return;
        }
        if (msg === 'error no-url') {
            this._shutdown('no webcam URL provided');
            return;
        }
        this._log('info', `status: ${msg}`);
    }

    _shutdown(error, graceful = false) {
        clearInterval(this._previewTimer);
        this._previewTimer = null;
        this._stopJpegRelay();
        this._stopPreviewFeed();
        const wasRunning = this.running;
        this.running = false;
        this.child = null;
        if (graceful || !error) {
            this.emit('status', this.getStatus());
            return;
        }
        this._log('error', error);
        this.emit('status', { ...this.getStatus(), error });
    }

    async stop() {
        this.stopRequested = true;
        clearInterval(this._previewTimer);
        this._previewTimer = null;
        this._stopJpegRelay();
        this._stopPreviewFeed();
        const child = this.child;
        if (!child) {
            this.running = false;
            this.emit('status', this.getStatus());
            return;
        }
        this.running = false;
        this.child = null;
        if (process.platform === 'win32') {
            try {
                await new Promise((resolve) => {
                    const { execFile } = require('child_process');
                    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve());
                });
            } catch (e) {
                child.kill();
            }
        } else {
            child.kill();
        }
        this.startedAt = null;
        this.emit('status', this.getStatus());
    }
}

module.exports = WebcamManager;
