const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

/**
 * Screen mirroring via scrcpy.
 *
 * scrcpy handles everything for us: H.264 capture (adb), low-latency decoding,
 * and input injection (tap/swipe/keyboard/buttons), and it works with a locked
 * phone screen. We just spawn it as a child process with the right flags.
 *
 * Binary resolution order for scrcpy / adb:
 *  1. explicit path from settings/env (SCRCPY_PATH, ADB)
 *  2. PATH lookup
 *  3. common install dirs (WinGet packages, etc.)
 */
class ScrcpyMirrorManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this._linux = process.platform !== 'win32';
        this.scrcpyOverride = options.scrcpyPath || process.env.SCRCPY_PATH || null;
        this.adbOverride = options.adbPath || process.env.ADB || null;
        this.defaultSerial = options.defaultSerial || null;
        this.child = null;
        this.running = false;
        this.serial = null;
        this.startedAt = null;
        this.lastLog = [];
        this.restartCount = 0;
        this.stopRequested = false;
        this.embeddedTitle = null;
        this.embeddedHwnd = null;
        this.embeddedParentHwnd = null;
        this.embedCorrection = null;
        this._currentOptions = null;
        this.embeddedRect = null;
        this._respawnTimer = null;
        this._intentionalRestart = false;
    }

    _commonDirs() {
        const dirs = [];
        if (process.platform === 'win32') {
            const wingetRoot = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
            try {
                if (fs.existsSync(wingetRoot)) {
                    for (const entry of fs.readdirSync(wingetRoot)) {
                        if (!entry.startsWith('Genymobile.scrcpy')) continue;
                        const root = path.join(wingetRoot, entry);
                        try {
                            const walk = (dir) => {
                                for (const f of fs.readdirSync(dir)) {
                                    const full = path.join(dir, f);
                                    if (f === 'scrcpy.exe' || f === 'adb.exe') return full;
                                    if (fs.statSync(full).isDirectory()) {
                                        const hit = walk(full);
                                        if (hit) return hit;
                                    }
                                }
                                return null;
                            };
                            const exe = walk(root);
                            if (exe) dirs.push(path.dirname(exe));
                        } catch (e) {
                            /* ignore */
                        }
                    }
                }
            } catch (e) {
                /* ignore */
            }
        }
        return dirs;
    }

    resolveBin(name) {
        const override = name === 'scrcpy' ? this.scrcpyOverride : this.adbOverride;
        if (override && fs.existsSync(override)) return override;

        const inPath = this._which(name);
        if (inPath) return inPath;

        for (const dir of this._commonDirs()) {
            const candidate = path.join(dir, name === 'scrcpy' ? 'scrcpy.exe' : 'adb.exe');
            if (fs.existsSync(candidate)) return candidate;
            const noExt = path.join(dir, name);
            if (fs.existsSync(noExt)) return noExt;
        }
        return null;
    }

    _which(name) {
        try {
            const { execSync } = require('child_process');
            const isWin = process.platform === 'win32';
            const cmd = isWin ? `where ${name}` : `which ${name}`;
            const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            const first = (out || '').split(/\r?\n/).find((l) => l.trim());
            return first && first.trim() ? first.trim() : null;
        } catch (e) {
            return null;
        }
    }

    getBins() {
        const scrcpy = this.resolveBin('scrcpy');
        let adb = this.resolveBin('adb');
        if (!adb && scrcpy) {
            const adbCandidate = path.join(path.dirname(scrcpy), 'adb.exe');
            if (fs.existsSync(adbCandidate)) adb = adbCandidate;
        }
        return { scrcpy, adb };
    }

    getStatus() {
        return {
            running: this.running,
            serial: this.serial,
            startedAt: this.startedAt,
            embedded: !!this.embeddedHwnd,
            bins: this.getBins()
        };
    }

    async _runAdb(args) {
        return new Promise((resolve, reject) => {
            const { adb } = this.getBins();
            if (!adb) return reject(new Error('adb not found. Install scrcpy (which bundles adb) or set the ADB env var.'));
            execFile(adb, args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) return reject(new Error((stderr || err.message || '').trim()));
                resolve((stdout || '').trim());
            });
        });
    }

    async _deviceState(serial) {
        const out = await this._runAdb(['devices']);
        const line = (out || '').split(/\r?\n/).find((l) => l.startsWith(serial + '\t'));
        return line ? line.split(/\s+/)[1] || null : null;
    }

    /**
     * MIUI/POCO drops the adb-over-Wi-Fi link when the screen locks. Re-establish
     * it (pairing keys persist on the PC, so `adb connect` is enough) before
     * handing the serial to scrcpy.
     */
    async ensureDeviceOnline(serial) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        if (await this._deviceState(serial) === 'device') return;

        const attempts = [
            () => this._runAdb(['reconnect', 'offline']),
            () => this._runAdb(['reconnect']),
            () => this._runAdb(['connect', serial])
        ];
        for (const attempt of attempts) {
            try {
                await attempt();
            } catch (e) {
                /* keep trying */
            }
            await sleep(2000);
            if (await this._deviceState(serial) === 'device') return;
        }
        throw new Error(`Phone ${serial} is offline. Unlock it once and confirm Wireless Debugging is still on, then retry.`);
    }

    async listDevices() {
        const bins = this.getBins();
        const out = await this._runAdb(['devices', '-l']);
        const lines = out.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('List of devices'));
        const devices = lines.map((line) => {
            const parts = line.split(/\s+/);
            const serial = parts[0];
            const state = parts[1] || 'unknown';
            const modelMatch = line.match(/model:(\S+)/);
            const deviceMatch = line.match(/device:(\S+)/);
            return {
                serial,
                state,
                model: modelMatch ? modelMatch[1] : null,
                kind: deviceMatch ? deviceMatch[1] : null,
                isTcpip: /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial)
            };
        });
        return { ok: true, ...bins, devices };
    }

    pickSerial(devices, preferred) {
        if (preferred) return preferred;
        if (this.defaultSerial) return this.defaultSerial;
        const online = devices.filter((d) => d.state === 'device');
        if (!online.length) return null;
        const tcp = online.find((d) => d.isTcpip);
        return tcp ? tcp.serial : online[0].serial;
    }

    _displayScale() {
        if (!this._linux) return 1;
        try {
            const { screen } = require('electron');
            const sf = screen.getPrimaryDisplay().scaleFactor;
            return sf > 0 ? sf : 1;
        } catch (e) {
            return 1;
        }
    }

    // Options positions/sizes arrive in PHYSICAL px (bridge multiplies the
    // renderer's CSS px by devicePixelRatio). On Wayland scrcpy expects logical
    // compositor pixels, so divide by the display scale. On X11 the SDL window
    // is placed in physical pixels already, so keep as-is.
    _linuxLogical(v) {
        const s = this._displayScale();
        return Math.round(v / s);
    }

    _spawnScrcpy(serial, options) {
        const bins = this.getBins();
        const args = ['-s', serial, '--window-title', options.windowTitle || 'Diy Phone Link - Screen Mirror'];
        if (options.embedded) args.push('--window-borderless');
        if (options.embedWindowSize) {
            const w = this._linux ? this._linuxLogical(options.embedWindowSize.width) : options.embedWindowSize.width;
            const h = this._linux ? this._linuxLogical(options.embedWindowSize.height) : options.embedWindowSize.height;
            args.push('--window-width', String(Math.max(1, w)));
            args.push('--window-height', String(Math.max(1, h)));
        }
        if (this._linux && options.windowPos) {
            args.push('--window-x', String(this._linuxLogical(options.windowPos.x)));
            args.push('--window-y', String(this._linuxLogical(options.windowPos.y)));
        }
        if (options.maxSize) args.push('--max-size', String(options.maxSize));
        if (options.maxFps) args.push('--max-fps', String(options.maxFps));
        if (options.turnScreenOff) args.push('--turn-screen-off');
        if (options.stayAwake !== false) args.push('--stay-awake');
        if (options.noAudio) args.push('--no-audio');
        if (options.noVideoPlayback) args.push('--no-video-playback');

        const scrcpyDir = path.dirname(bins.scrcpy);
        const env = {
            ...process.env,
            ADB: bins.adb || '',
            PATH: scrcpyDir + path.delimiter + (process.env.PATH || '')
        };
        if (this._linux) {
            // Run under XWayland: the Wayland backend ignores --window-x/y and cannot
            // be kept above the Electron window. As an X11 window on the same display
            // it can be positioned exactly and pinned always-on-top.
            env.SDL_VIDEODRIVER = 'x11';
        }

        return spawn(bins.scrcpy, args, { env, windowsHide: false });
    }

    async start(options = {}) {
        if (this.running) {
            this.emit('status', this.getStatus());
            return this.getStatus();
        }

        this.embeddedTitle = options.embedded ? (options.windowTitle || 'Diy Phone Link - Screen Mirror') : null;
        this.embeddedHwnd = null;
        this.embeddedParentHwnd = null;
        this.embedCorrection = null;
        this.embeddedRect = null;
        this._currentOptions = { ...options };
        this._intentionalRestart = false;

        const bins = this.getBins();
        if (!bins.scrcpy) throw new Error('scrcpy not found. Install it (winget install Genymobile.scrcpy) or set SCRCPY_PATH.');

        const list = await this.listDevices();
        const serial = this.pickSerial(list.devices || [], options.serial);
        if (!serial) {
            throw new Error('No Android device connected over adb. Enable Wireless Debugging on the phone and run adb connect <ip>:<port>.');
        }

        await this.ensureDeviceOnline(serial);

        let lastOutcome = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            let child;
            try {
                child = this._spawnScrcpy(serial, options);
            } catch (err) {
                throw new Error(`Failed to launch scrcpy: ${err.message}`);
            }

            child.stdout.on('data', (d) => this._log('info', d.toString()));
            child.stderr.on('data', (d) => this._log('error', d.toString()));

            let established = false;
            const outcome = await new Promise((resolve) => {
                child.once('error', (err) => resolve({ error: err }));
                child.once('exit', (code, signal) => resolve({ code, signal }));
                child.on('exit', (code, signal) => {
                    this._onChildExit(child, serial, options, code, signal, established);
                });
                const timer = setTimeout(() => {
                    established = true;
                    resolve('up');
                }, 5000);
                child.once('close', () => clearTimeout(timer));
            });

            if (outcome === 'up') {
                this.restartCount = 0;
                this.stopRequested = false;
                this.child = child;
                this.running = true;
                this.serial = serial;
                this.startedAt = Date.now();
                this.emit('status', { running: true, serial, embedded: !!this.embeddedHwnd });
                if (this._linux) this._keepAboveLinux().catch(() => {});
                return this.getStatus();
            }

            lastOutcome = outcome;
            const reason = outcome && outcome.error
                ? `launch error (${outcome.error.code || outcome.error.message})`
                : `code ${outcome && outcome.code}`;
            this._log('error', `scrcpy failed during startup (${reason}); attempt ${attempt}/3`);

            if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 1000));
                try {
                    await this.ensureDeviceOnline(serial);
                } catch (e) {
                    /* keep retrying */
                }
            }
        }

        this.running = false;
        this.serial = null;
        this.startedAt = null;
        const detail = lastOutcome && lastOutcome.error ? lastOutcome.error.message : `scrcpy exited with code ${lastOutcome && lastOutcome.code}`;
        this.emit('status', {
            running: false,
            error: `Could not start screen mirror: ${detail}. The Wi-Fi adb link may have dropped (MIUI drops it when the screen locks).\n${this.lastLog.slice(-10).join('\n')}`
        });
        return this.getStatus();
    }

    // Shared scrcpy-exit handler. Guarded so our own Linux docked-mode respawns
    // (which intentionally kill + restart scrcpy to reposition the window) do
    // not trigger the "phone dropped" auto-restart path.
    _onChildExit(child, serial, options, code, signal, established) {
        if (this._intentionalRestart) return;
        // Exit from a child that has since been replaced by a Linux respawn.
        if (child !== this.child && this.child) return;
        if (!established) return;
        this.running = false;
        this.child = null;
        this.embeddedRect = null;
        if (code === 0 || signal || this.stopRequested) {
            this.emit('status', { running: false, serial: null, exitCode: code, signal });
            return;
        }
        if (this.restartCount < 3) {
            this.restartCount += 1;
            this._log('error', `scrcpy exited (code ${code}); reconnecting adb and restarting (${this.restartCount}/3)...`);
            this.emit('status', { running: false, serial: null, exitCode: code, error: 'Phone connection dropped (MIUI). Reconnecting...' });
            setTimeout(() => {
                if (this.stopRequested) return;
                this.ensureDeviceOnline(serial)
                    .then(() => this.start(options))
                    .catch(() => {
                        if (this.stopRequested) return;
                        this.emit('status', { running: false, error: 'Auto-restart failed: phone offline. Unlock it and confirm Wireless Debugging is on.' });
                    });
            }, 1500);
        } else {
            this.emit('status', {
                running: false,
                serial: null,
                exitCode: code,
                error: `scrcpy stopped (code ${code}) after ${this.restartCount} auto-restarts. Reconnect and press Start again.`
            });
        }
    }

    _attachChild(serial, options, child) {
        child.stdout.on('data', (d) => this._log('info', d.toString()));
        child.stderr.on('data', (d) => this._log('error', d.toString()));
        child.on('exit', (code, signal) => this._onChildExit(child, serial, options, code, signal, true));
        return child;
    }

    _log(level, text) {
        const line = text.trim();
        if (!line) return;
        this.lastLog.push(`[${level}] ${line}`);
        if (this.lastLog.length > 200) this.lastLog.splice(0, this.lastLog.length - 200);
        console.log(`[ScrcpyMirror] ${line}`);
        this.emit('log', { level, line });
    }

    /**
     * Docked (embedded) mirroring. The scrcpy window is spawned borderless with a
     * unique title, then re-parented into the Electron window with Win32 SetParent
     * and moved exactly over the phone-model "screen" placeholder in the renderer.
     * All the PowerShell/Win32 work lives in embed-window.ps1 so we need no native
     * node modules.
     */
    _runPs(args) {
        return this._runPsRaw(args).then((trimmed) => {
            if (trimmed === null) return null;
            const m = trimmed.match(/^OK (-?\d+)$/);
            return m ? m[1] : trimmed;
        });
    }

    _runPsRaw(args) {
        return new Promise((resolve, reject) => {
            const { spawn } = require('child_process');
            const script = path.join(__dirname, 'embed-window.ps1');
            const child = spawn(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
                { windowsHide: true }
            );
            let out = '';
            let err = '';
            child.stdout.on('data', (d) => (out += d.toString()));
            child.stderr.on('data', (d) => (err += d.toString()));
            child.on('error', (e) => reject(e));
            child.on('close', (code) => {
                const trimmed = out.trim();
                if (trimmed === 'NOT_FOUND') return resolve(null);
                if (code !== 0) return reject(new Error((err || trimmed || `powershell exited ${code}`).trim()));
                resolve(trimmed);
            });
        });
    }

    _parseRect(out) {
        const m = (out || '').match(/^OK (-?\d+) (-?\d+) (-?\d+) (-?\d+)$/);
        return m ? { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) } : null;
    }

    // rect is in PHYSICAL pixels already (renderer sends CSS px * devicePixelRatio).
    async embedWindow(parentHwnd, rect) {
        if (this._linux) {
            // No Win32 SetParent on Linux: position a borderless scrcpy window
            // exactly over the phone-model "screen" placeholder instead. The
            // renderer treats a non-null hwnd as "docked".
            if (this.embeddedHwnd) {
                // Already docked: repositioning is handled by moveWindow() (debounced
                // respawn). Returning here is what breaks the status -> autoDock ->
                // embedWindow -> respawn feedback loop that previously respawned
                // scrcpy every ~150ms (killing it before it could render).
                return this.embeddedHwnd;
            }
            if (!this.child) return null;
            this.embeddedHwnd = 'scrcpy:' + this.child.pid;
            this.embeddedParentHwnd = parentHwnd || null;
            this.embeddedRect = { ...rect };
            this.embedCorrection = null;
            // If the child was already pre-positioned for this hole (mirror:start
            // passed windowPos) it is adopted as-is; otherwise respawn at the rect
            // as a fallback for callers that skip pre-positioning.
            if (!this._currentOptions || !this._currentOptions.windowPos) {
                await this._linuxRespawn(rect);
            }
            return this.embeddedHwnd;
        }
        if (this.embeddedHwnd) {
            await this._moveRaw(rect);
            return this.embeddedHwnd;
        }
        const args = [
            '-Action', 'embed',
            '-Title', this.embeddedTitle || '',
            '-ProcessId', String(this.child ? this.child.pid : ''),
            '-ParentHwnd', parentHwnd,
            '-X', rect.x, '-Y', rect.y, '-W', rect.width, '-H', rect.height
        ];
        // Poll until the scrcpy window actually appears (it is created shortly after spawn).
        for (let i = 0; i < 30; i++) {
            const hwnd = await this._runPs(args);
            if (hwnd) {
                this.embeddedHwnd = hwnd;
                this.embeddedParentHwnd = parentHwnd;
                this.embedCorrection = null;
                await this._calibrateTo(rect);
                return hwnd;
            }
            await new Promise((r) => setTimeout(r, 400));
        }
        return null;
    }

    async moveWindow(rect) {
        if (this._linux) {
            if (!this.embeddedHwnd) return;
            this.embeddedRect = { ...rect };
            // Repositioning = respawn scrcpy at the new geometry; debounce rapid
            // resize/move events (no qdbus/KWin scripting available on Wayland).
            clearTimeout(this._respawnTimer);
            this._respawnTimer = setTimeout(() => {
                this._respawnTimer = null;
                if (this.embeddedRect) this._linuxRespawn(this.embeddedRect).catch(() => {});
            }, 200);
            return;
        }
        if (!this.embeddedHwnd) return;
        await this._moveRaw(rect);
    }

    // Restarts scrcpy borderless at the given rect (Linux docked mode). Kills
    // the current child without triggering the auto-restart path, then spawns a
    // fresh one pre-positioned with --window-x/-y/-width/-height.
    async _linuxRespawn(rect) {
        const child = this.child;
        if (!child || this.stopRequested) return;
        if (this._intentionalRestart) return;
        this._intentionalRestart = true;
        this.child = null;
        try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
        await new Promise((r) => setTimeout(r, 300));
        if (this.stopRequested) return;

        const serial = this.serial;
        const options = {
            ...this._currentOptions,
            embedded: true,
            windowTitle: this.embeddedTitle,
            windowPos: { x: rect.x, y: rect.y },
            embedWindowSize: { width: rect.width, height: rect.height }
        };
        let newChild;
        try {
            newChild = this._spawnScrcpy(serial, options);
        } catch (e) {
            this._intentionalRestart = false;
            this.running = false;
            this.embeddedHwnd = null;
            this.emit('status', { running: false, error: 'Failed to reposition scrcpy: ' + e.message });
            return;
        }
        this._attachChild(serial, options, newChild);
        this.child = newChild;
        this.embeddedHwnd = 'scrcpy:' + newChild.pid;
        this.embeddedRect = { ...rect };
        this._intentionalRestart = false;
        this.emit('status', this.getStatus());
        if (this._linux) this._keepAboveLinux().catch(() => {});
    }

    // KWin/XWayland: a separate borderless window sinks below the Electron window
    // whenever the app gains focus, which is what made the phone-model hole show
    // black. Pin the scrcpy window always-on-top so it stays glued over the hole.
    // wmctrl sends the proper _NET_WM_STATE ClientMessage that the compositor
    // honors (direct xprop writes are ignored by window managers).
    async _keepAboveLinux() {
        if (!this._linux || !this.embeddedTitle) return;
        const { execFile } = require('child_process');
        for (let i = 0; i < 20; i++) {
            if (this.stopRequested) return;
            try {
                const ok = await new Promise((resolve) => {
                    execFile('wmctrl', ['-r', this.embeddedTitle, '-b', 'add,above'], (err) => resolve(!err));
                });
                if (ok) return;
            } catch (e) { /* keep polling */ }
            await new Promise((r) => setTimeout(r, 300));
        }
    }

    // Returns the embedded window's current rect in parent-client physical px
    // (the same coordinate space MoveWindow uses).
    async getWindowRect() {
        if (this._linux) {
            if (!this.embeddedHwnd || !this.embeddedRect) return null;
            return { ...this.embeddedRect };
        }
        if (!this.embeddedHwnd || !this.embeddedParentHwnd) return null;
        const out = await this._runPsRaw([
            '-Action', 'calibrate',
            '-Hwnd', this.embeddedHwnd,
            '-ParentHwnd', this.embeddedParentHwnd
        ]);
        return this._parseRect(out);
    }

    // Moves the embedded window, applying the cached DPI/scale correction.
    async _moveRaw(desired) {
        const corr = this.embedCorrection;
        const args = ['-Action', 'move', '-Hwnd', this.embeddedHwnd];
        if (!corr) {
            args.push('-X', desired.x, '-Y', desired.y, '-W', desired.width, '-H', desired.height);
            await this._runPs(args);
            return;
        }
        const apply = (key, v) => {
            const t = corr[key];
            if (!t || !t.s || !Number.isFinite(t.s)) return Math.round(v);
            return Math.max(0, Math.round((v - t.o) / t.s));
        };
        args.push(
            '-X', apply('x', desired.x),
            '-Y', apply('y', desired.y),
            '-W', apply('width', desired.width),
            '-H', apply('height', desired.height)
        );
        await this._runPs(args);
    }

    // Moves + measures.  Called with RAW (pre-correction) coordinates.
    async _applyAndMeasure(arg) {
        const { setTimeout: sleep } = require('timers');
        await this._runPs([
            '-Action', 'move', '-Hwnd', this.embeddedHwnd,
            '-X', arg.x, '-Y', arg.y, '-W', arg.width, '-H', arg.height
        ]);
        await new Promise((r) => sleep(r, 120));
        return this.getWindowRect();
    }

    /**
     * Empirically discovers the effective scale/offset Windows applies to
     * MoveWindow for the embedded child (DPI virtualization, SDL quirks, etc.)
     * by measuring two different raw placements, then solving the affine
     * transform raw -> actual per axis.  Subsequent moves reuse the solution.
     */
    async _calibrateTo(desired) {
        this.embedCorrection = null;
        const { setTimeout: sleep } = require('timers');
        await new Promise((r) => sleep(r, 150));

        const p1 = await this._applyAndMeasure(desired);
        if (!p1) return;

        const perturb = Math.max(8, Math.round(desired.width * 0.05));
        const arg2 = { ...desired, x: desired.x + perturb, width: desired.width + perturb };
        const p2 = await this._applyAndMeasure(arg2);
        if (!p2) return;

        const corr = {};
        for (const key of ['x', 'y', 'width', 'height']) {
            const dArg = arg2[key] - desired[key];
            const dAct = p2[key] - p1[key];
            const s = dArg !== 0 ? dAct / dArg : 1;
            const o = p1[key] - s * desired[key];
            corr[key] = Number.isFinite(s) && Math.abs(s) >= 0.05 ? { s, o } : null;
        }
        this.embedCorrection = corr;
        this._log('info',
            `calibrate: desired(${desired.x},${desired.y},${desired.width},${desired.height}) ` +
            `measured1(${p1.x},${p1.y},${p1.width},${p1.height}) measured2(${p2.x},${p2.y},${p2.width},${p2.height}) ` +
            `sx=${corr.width ? corr.width.s.toFixed(3) : 'n/a'} sy=${corr.height ? corr.height.s.toFixed(3) : 'n/a'}`);

        const fix = (key, v) => {
            const t = corr[key];
            if (!t || !t.s) return Math.round(v);
            return Math.max(0, Math.round((v - t.o) / t.s));
        };
        const finalArg = {
            x: fix('x', desired.x),
            y: fix('y', desired.y),
            width: fix('width', desired.width),
            height: fix('height', desired.height)
        };
        const check = await this._applyAndMeasure(finalArg);
        if (check) {
            this._log('info',
                `calibrate final: requested(${desired.x},${desired.y},${desired.width},${desired.height}) ` +
                `measured(${check.x},${check.y},${check.width},${check.height})`);
        }
    }

    async focusWindow() {
        if (!this.embeddedHwnd) return;
        if (this._linux) return; // no reliable Wayland raise without KWin scripting
        await this._runPs(['-Action', 'focus', '-Hwnd', this.embeddedHwnd]);
    }

    async getDeviceSize() {
        const serial = this.serial;
        if (!serial) return null;
        const out = await this._runAdb(['-s', serial, 'shell', 'wm', 'size']);
        const m = (out || '').match(/Physical size:\s*(\d+)x(\d+)/);
        return m ? { ok: true, width: Number(m[1]), height: Number(m[2]) } : null;
    }

    async screenshot(destPath) {
        const bins = this.getBins();
        if (!bins.adb) throw new Error('adb not found');
        const args = ['exec-out', 'screencap', '-p'];
        if (this.serial) args.unshift('-s', this.serial);
        return new Promise((resolve, reject) => {
            const { spawn } = require('child_process');
            const child = spawn(bins.adb, args, { windowsHide: true });
            const out = fs.createWriteStream(destPath);
            let err = '';
            child.stderr.on('data', (d) => (err += d.toString()));
            child.on('error', (e) => reject(e));
            child.stdout.pipe(out);
            out.on('error', (e) => reject(e));
            child.on('close', (code) => {
                out.end();
                if (code !== 0) {
                    try { fs.unlinkSync(destPath); } catch (e) { /* ignore */ }
                    return reject(new Error((err || `adb screencap exited ${code}`).trim()));
                }
                resolve(destPath);
            });
        });
    }

    async stop() {
        this.stopRequested = true;
        clearTimeout(this._respawnTimer);
        this._respawnTimer = null;
        const child = this.child;
        if (!child) {
            this.running = false;
            this.embeddedHwnd = null;
            this.embeddedTitle = null;
            this.emit('status', this.getStatus());
            return;
        }
        this.running = false;
        this.child = null;
        this.embeddedHwnd = null;
        this.embeddedParentHwnd = null;
        this.embedCorrection = null;
        this.embeddedTitle = null;
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
        this.serial = null;
        this.startedAt = null;
        this.emit('status', this.getStatus());
    }
}

module.exports = ScrcpyMirrorManager;
