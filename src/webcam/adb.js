const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * adb helpers for the phone-as-webcam USB transport.
 *
 * Resolves adb the same way ScrcpyMirrorManager does (env ADB override, PATH,
 * then common WinGet install dirs) so USB webcam and screen mirroring share the
 * same tooling. A device connected over USB is exposed to the HTTP frame pump
 * as http://127.0.0.1:<port>/shot.jpg via `adb forward`.
 */

const exec = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 20000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
            err.stderr = (stderr || '').trim();
            return reject(err);
        }
        resolve((stdout || '').trim());
    });
});

function _which(name) {
    try {
        const { execSync } = require('child_process');
        const isWin = process.platform === 'win32';
        const out = execSync(isWin ? `where ${name}` : `which ${name}`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const first = (out || '').split(/\r?\n/).find((l) => l.trim());
        return first && first.trim() ? first.trim() : null;
    } catch (e) {
        return null;
    }
}

function _commonDirs() {
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
                                if (f === 'adb.exe') return full;
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

function resolveAdb() {
    const override = process.env.ADB;
    if (override && fs.existsSync(override)) return override;

    const inPath = _which('adb');
    if (inPath) return inPath;

    for (const dir of _commonDirs()) {
        const candidate = path.join(dir, 'adb.exe');
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/** Returns the serials of connected devices (USB or wireless). */
async function listDevices() {
    const adb = resolveAdb();
    if (!adb) throw new Error('adb not found. Install scrcpy (which bundles adb) or set the ADB env var.');
    const out = await exec(adb, ['devices']);
    return out
        .split(/\r?\n/)
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => l && /device$/.test(l))
        .map((l) => l.split(/\s+/)[0]);
}

/** Forwards hostPort on the first connected device to devicePort on it. */
async function forward(hostPort, devicePort) {
    const adb = resolveAdb();
    if (!adb) throw new Error('adb not found. Install scrcpy (which bundles adb) or set the ADB env var.');
    const devices = await listDevices();
    if (!devices.length) throw new Error('No Android device connected over USB/adb. Enable USB debugging and connect the phone.');
    await exec(adb, ['-s', devices[0], 'forward', `tcp:${hostPort}`, `tcp:${devicePort}`]);
    return devices[0];
}

async function unforward(hostPort) {
    const adb = resolveAdb();
    if (!adb) return;
    try {
        await exec(adb, ['forward', '--remove', `tcp:${hostPort}`]);
    } catch (e) {
        /* non-fatal */
    }
}

module.exports = { resolveAdb, listDevices, forward, unforward };
