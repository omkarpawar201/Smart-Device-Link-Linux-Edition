'use strict';

const { spawn, execFile } = require('child_process');
const path = require('path');

const CMD_TIMEOUT_MS = 5000;

// Cross-platform controller for the PC's real media session.
//
// Windows: keeps a single persistent PowerShell helper process alive and speaks
// a line protocol over stdin/stdout (media-keys.ps1 — VK_MEDIA_* key presses,
// master volume via Core Audio, now-playing via SMTC). No native modules.
//
// Linux: MPRIS over D-Bus via dbus-send (the native equivalent of SMTC) plus
// pactl for master volume on PulseAudio/PipeWire. No playerctl dependency; the
// active MPRIS player is discovered from the session bus and cached.
class PcMediaController {
    constructor() {
        this._linux = process.platform !== 'win32';
        this.child = null;
        this.startPromise = null;
        this.started = false;
        this.failed = false;
        this.waiters = [];
        this.buffer = '';
        this.isPlaying = false;
        this.volume = null;
        this.muted = false;
        this.linuxPlayer = null; // cached MPRIS player bus name (org.mpris.MediaPlayer2.*)
        this.onExit = () => this.dispose();
        process.on('exit', this.onExit);
    }

    // ---------- Linux helpers (MPRIS + pactl) ----------

    _exec(cmd, args, timeoutMs = CMD_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) {
                    const e = new Error((stderr || '').toString().trim() || err.message);
                    e.exitCode = err.code;
                    return reject(e);
                }
                resolve((stdout || '').toString());
            });
        });
    }

    async _mprisPlayers() {
        const out = await this._exec('dbus-send', [
            '--session', '--print-reply',
            '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames'
        ]);
        const names = [];
        for (const m of out.matchAll(/"((?:org\.mpris\.MediaPlayer2\.)[^"]+)"/g)) {
            names.push(m[1]);
        }
        return names;
    }

    _dbusGetProp(player, iface, prop) {
        return this._exec('dbus-send', [
            '--session', '--print-reply',
            '--dest=' + player, '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties.Get', 'string:' + iface, 'string:' + prop
        ]);
    }

    // dbus-send prints strings on a single line WITHOUT escaping inner quotes
    // (e.g. string "Test Song "Quoted""), so capture greedily up to the last
    // quote on the line.
    _stringProp(out) {
        const m = out.match(/^[ \t]*variant\s+string\s+"(.*)"[ \t]*$/m);
        return m ? m[1] : null;
    }

    _intProp(out) {
        const m = out.match(/variant\s+(?:int64|int32|uint32|uint64)\s+(-?\d+)/);
        return m ? Number(m[1]) : null;
    }

    // Pulls a single value out of an MPRIS Metadata (a{sv}) dump.
    _metadataValue(out, key) {
        const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('string\\s+"' + esc + '"\\s+variant\\s+([\\s\\S]*?)(?=\\n\\s*dict entry|\\n\\s*\\])');
        const m = out.match(re);
        if (!m) return null;
        const block = m[1];
        const sm = block.match(/^[ \t]*string\s+"(.*)"[ \t]*$/m);
        if (sm) return sm[1];
        const im = block.match(/(?:int64|int32|uint32|uint64)\s+(-?\d+)/);
        if (im) return Number(im[1]);
        const om = block.match(/^[ \t]*object\s+path\s+"(.*)"[ \t]*$/m);
        if (om) return om[1];
        const bm = block.match(/boolean\s+(\w+)/);
        if (bm) return bm[1] === 'true';
        const am = block.match(/^[ \t]*string\s+"(.*)"[ \t]*$/m);
        if (am) return am[1];
        return null;
    }

    // Find the active MPRIS player (cache it; rediscover when it disappears).
    async _pickPlayer() {
        if (this.linuxPlayer) return this.linuxPlayer;
        let lastErr = null;
        for (const name of await this._mprisPlayers()) {
            try {
                await this._dbusGetProp(name, 'org.mpris.MediaPlayer2.Player', 'PlaybackStatus');
                this.linuxPlayer = name;
                return name;
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr || new Error('No MPRIS media player found');
    }

    // Calls a player method, re-discovering the player once if the cached one died.
    async _callPlayer(method, args) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const player = await this._pickPlayer();
            try {
                return await this._exec('dbus-send', [
                    '--session', '--print-reply',
                    '--dest=' + player, '/org/mpris/MediaPlayer2', method, ...args
                ]);
            } catch (e) {
                this.linuxPlayer = null;
                if (attempt === 1) throw e;
            }
        }
    }

    async _linuxGetVolume() {
        const out = await this._exec('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
        const m = out.match(/(\d{1,3})%/);
        this.volume = m ? Math.min(100, Number(m[1])) : 0;
        this.muted = false;
        try {
            const mut = await this._exec('pactl', ['get-sink-mute', '@DEFAULT_SINK@']);
            this.muted = /mute:\s*yes/i.test(mut.trim());
        } catch (e) { /* non-fatal */ }
        return { volume: this.volume, muted: this.muted };
    }

    // ---------- Windows helper machinery ----------

    _powershellPath() {
        if (process.env.SystemRoot) {
            return path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        }
        return 'powershell.exe';
    }

    ensureStarted() {
        if (this._linux) return Promise.resolve();
        if (this.failed) return Promise.reject(new Error('PcMediaController unavailable'));
        if (this.started && this.child) return Promise.resolve();
        if (this.startPromise) return this.startPromise;
        this.startPromise = this._start();
        return this.startPromise;
    }

    _start() {
        return new Promise((resolve, reject) => {
            const scriptPath = path.join(__dirname, 'media-keys.ps1');
            let child;
            try {
                child = spawn(this._powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true
                });
            } catch (err) {
                this._disable(err);
                reject(err);
                return;
            }

            this.child = child;
            child.stdout.on('data', (chunk) => this._onData(chunk));
            child.stderr.on('data', (chunk) => {
                const text = chunk.toString().trim();
                if (text) console.error('[PcMediaController] helper:', text);
            });
            child.on('error', (err) => {
                this._disable(err);
                reject(err);
            });
            child.on('exit', (code) => {
                this.child = null;
                this.started = false;
                this.startPromise = null;
                const err = new Error('media keys helper exited (' + code + ')');
                this._flushWaiters(err);
                reject(err);
            });

            // The helper's first stdout line is "ready".
            const startupWaiter = { resolve, reject, timer: null };
            this.waiters.push(startupWaiter);
        });
    }

    _onData(chunk) {
        this.buffer += chunk.toString();
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).replace(/\r$/, '');
            this.buffer = this.buffer.slice(idx + 1);
            this._handleLine(line);
        }
    }

    _handleLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return;

        if (trimmed === 'ready' && !this.started) {
            this.started = true;
            const w = this.waiters.shift();
            if (w) {
                clearTimeout(w.timer);
                w.resolve();
            }
            return;
        }

        const w = this.waiters.shift();
        if (!w) return;
        clearTimeout(w.timer);

        const result = parseResult(trimmed);
        if (result && result.error) w.reject(new Error(result.error));
        else w.resolve(result || {});
    }

    _flushWaiters(err) {
        while (this.waiters.length) {
            const w = this.waiters.shift();
            clearTimeout(w.timer);
            w.reject(err);
        }
    }

    _disable(err) {
        this.failed = true;
        this.started = false;
        try {
            if (this.child) this.child.kill();
        } catch (e) { /* ignore */ }
        this._flushWaiters(err);
    }

    _request(cmd) {
        return this.ensureStarted()
            .then(() => new Promise((resolve, reject) => {
                if (!this.child) return reject(new Error('helper not running'));
                const waiter = {
                    resolve,
                    reject,
                    timer: setTimeout(() => {
                        const i = this.waiters.indexOf(waiter);
                        if (i >= 0) this.waiters.splice(i, 1);
                        reject(new Error('helper timeout: ' + cmd));
                    }, CMD_TIMEOUT_MS)
                };
                this.waiters.push(waiter);
                this.child.stdin.write(cmd + '\n');
            }));
    }

    play() {
        if (this._linux) {
            this.isPlaying = true;
            return this._callPlayer('org.mpris.MediaPlayer2.Player.Play', [])
                .catch((err) => { this.isPlaying = false; throw err; });
        }
        this.isPlaying = true;
        return this._request('play').catch((err) => { this.isPlaying = false; throw err; });
    }

    pause() {
        if (this._linux) {
            this.isPlaying = false;
            return this._callPlayer('org.mpris.MediaPlayer2.Player.Pause', [])
                .catch((err) => { this.isPlaying = true; throw err; });
        }
        this.isPlaying = false;
        return this._request('pause').catch((err) => { this.isPlaying = true; throw err; });
    }

    playPause() {
        if (this._linux) {
            this.isPlaying = !this.isPlaying;
            return this._callPlayer('org.mpris.MediaPlayer2.Player.PlayPause', [])
                .catch((err) => { this.isPlaying = !this.isPlaying; throw err; });
        }
        this.isPlaying = !this.isPlaying;
        return this._request('playpause').catch((err) => { this.isPlaying = !this.isPlaying; throw err; });
    }

    next() {
        if (this._linux) return this._callPlayer('org.mpris.MediaPlayer2.Player.Next', []);
        return this._request('next');
    }

    previous() {
        if (this._linux) return this._callPlayer('org.mpris.MediaPlayer2.Player.Previous', []);
        return this._request('prev');
    }

    stop() {
        if (this._linux) {
            this.isPlaying = false;
            return this._callPlayer('org.mpris.MediaPlayer2.Player.Stop', [])
                .catch((err) => { this.isPlaying = true; throw err; });
        }
        this.isPlaying = false;
        return this._request('stop').catch((err) => { this.isPlaying = true; throw err; });
    }

    // Relative seek by `ms` from the current position (the phone's seek bar sends a delta).
    seek(ms) {
        if (this._linux) {
            const us = Math.round(Number(ms) || 0) * 1000;
            return this._callPlayer('org.mpris.MediaPlayer2.Player.Seek', ['int64:' + us]);
        }
        return this._request('seek ' + Math.round(Number(ms) || 0));
    }

    // Absolute seek to `ms` within the current track.
    async setPos(ms) {
        if (this._linux) {
            const us = Math.round(Number(ms) || 0) * 1000;
            let trackid = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
            try {
                const player = await this._pickPlayer();
                const metaOut = await this._dbusGetProp(player, 'org.mpris.MediaPlayer2.Player', 'Metadata');
                trackid = this._metadataValue(metaOut, 'mpris:trackid') || trackid;
            } catch (e) { /* use NoTrack fallback */ }
            return this._callPlayer('org.mpris.MediaPlayer2.Player.SetPosition', ['objpath:' + trackid, 'int64:' + us]);
        }
        return this._request('setpos ' + Math.round(Number(ms) || 0));
    }

    setVolume(volume) {
        const v = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
        if (this._linux) {
            return this._exec('pactl', ['set-sink-volume', '@DEFAULT_SINK@', v + '%'])
                .then(() => this._linuxGetVolume());
        }
        this.volume = v;
        return this._request('setvol ' + v).then((res) => {
            if (res && typeof res.volume === 'number') {
                this.volume = res.volume;
                this.muted = !!res.muted;
            }
            return res;
        });
    }

    getVolume() {
        if (this._linux) return this._linuxGetVolume();
        return this._request('getvol').then((res) => {
            if (res && typeof res.volume === 'number') {
                this.volume = res.volume;
                this.muted = !!res.muted;
            }
            return res;
        });
    }

    // Real now-playing metadata + play state from the media session.
    // pos/length are returned in SECONDS (renderer convention). Also syncs
    // `isPlaying` so Play/Pause decisions use the real session state.
    async getNowPlaying() {
        if (this._linux) {
            const player = await this._pickPlayer();
            const statusOut = await this._dbusGetProp(player, 'org.mpris.MediaPlayer2.Player', 'PlaybackStatus');
            const metaOut = await this._dbusGetProp(player, 'org.mpris.MediaPlayer2.Player', 'Metadata');
            let posUs = 0;
            try {
                posUs = this._intProp(await this._dbusGetProp(player, 'org.mpris.MediaPlayer2.Player', 'Position')) || 0;
            } catch (e) { /* non-fatal */ }
            const lengthUs = this._metadataValue(metaOut, 'mpris:length');
            const np = {
                title: this._metadataValue(metaOut, 'xesam:title') || '',
                artist: this._metadataValue(metaOut, 'xesam:artist') || '',
                album: this._metadataValue(metaOut, 'xesam:album') || '',
                isPlaying: this._stringProp(statusOut) === 'Playing',
                pos: Math.round(posUs / 1e6),
                length: lengthUs ? Math.round(Number(lengthUs) / 1e6) : 0
            };
            this.isPlaying = np.isPlaying;
            return np;
        }
        return this._request('getnp').then((res) => {
            const np = {
                title: res.title || '',
                artist: res.artist || '',
                album: res.album || '',
                isPlaying: res.playing === true,
                pos: typeof res.pos === 'number' ? Math.round(res.pos / 1000) : 0,
                length: typeof res.length === 'number' ? Math.round(res.length / 1000) : 0
            };
            this.isPlaying = np.isPlaying;
            return np;
        });
    }

    dispose() {
        process.removeListener('exit', this.onExit);
        if (this._linux) return;
        if (this.child) {
            try { this.child.stdin.end(); } catch (e) { /* ignore */ }
            try { this.child.kill(); } catch (e) { /* ignore */ }
            this.child = null;
        }
        this.started = false;
    }
}

function parseResult(line) {
    if (line === 'ok') return {};
    if (line.startsWith('err=')) return { error: line.slice(4) };
    const result = {};
    for (const part of line.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) {
            const key = part.slice(0, eq).trim();
            const val = part.slice(eq + 1).trim();
            if (key === 'vol') {
                const n = Number(val);
                if (Number.isFinite(n)) result.volume = n;
            } else if (key === 'mute') {
                result.muted = val.toLowerCase() === 'true';
            } else if (key === 'playing') {
                result.playing = val.toLowerCase() === 'true';
            } else if (key === 'pos' || key === 'length') {
                const n = Number(val);
                if (Number.isFinite(n)) result[key] = n;
            } else if (key.indexOf('np_') === 0) {
                const name = key.slice(3);
                try {
                    result[name] = decodeURIComponent(val);
                } catch (e) {
                    result[name] = val;
                }
            }
        }
    }
    return result;
}

module.exports = PcMediaController;
