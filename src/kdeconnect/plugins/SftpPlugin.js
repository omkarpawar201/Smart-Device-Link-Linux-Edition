const BasePlugin = require('./BasePlugin');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

class SftpPlugin extends BasePlugin {
    constructor(eventEmitter) {
        super('SftpPlugin');
        this.emitter = eventEmitter;
        this.sftpConfig = null;
        this.sftpClient = null;
        this.sshClient = null;
        this.isConnected = false;
        this.currentDevice = null;
        this.mountRequestInFlight = false;
        this._mountResetTimer = null;
    }

    getCapabilities() {
        return ['kdeconnect.sftp'];
    }

    handlePacket(device, packet) {
        if (packet.type === 'kdeconnect.sftp') {
            const body = packet.body || {};
            this.currentDevice = device;
            this.mountRequestInFlight = false;
            if (this._mountResetTimer) {
                clearTimeout(this._mountResetTimer);
                this._mountResetTimer = null;
            }

            if (body.errorMessage) {
                console.warn(`[SftpPlugin] Device reported SFTP error: ${body.errorMessage}`);
                return;
            }

            this.sftpConfig = {
                ip: body.ip || device.info.ip,
                port: body.port || 1739,
                user: body.user || 'kdeconnect',
                password: body.password || '',
                path: body.path || '/sdcard'
            };

            console.log(`[SftpPlugin] Received SFTP Credentials for ${device.info.name} (${this.sftpConfig.ip}:${this.sftpConfig.port})`);

            if (this.emitter) {
                this.emitter.emit('sftpMounted', {
                    deviceId: device.info.id,
                    config: this.sftpConfig
                });
            }
        }
    }

    requestSftpMount(device) {
        if (!device) return false;
        this.currentDevice = device;

        // The phone regenerates its SFTP password on every startBrowsing request, and responses
        // can arrive out of order. Sending multiple overlapping requests can therefore leave us
        // with stale credentials. Only allow one request to be in flight at a time.
        if (this.mountRequestInFlight) return false;
        this.mountRequestInFlight = true;

        const requestPacket = {
            id: Date.now(),
            type: 'kdeconnect.sftp.request',
            body: { startBrowsing: true }
        };

        // Safety net: if the phone never replies, clear the flag so future requests are not blocked.
        this._mountResetTimer = setTimeout(() => {
            this.mountRequestInFlight = false;
            this._mountResetTimer = null;
        }, 8000);

        console.log(`[SftpPlugin] Requesting SFTP Mount from ${device.info.name}`);
        return device.sendPacket(requestPacket);
    }

    async waitForConfig(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (!this.sftpConfig && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200));
        }
    }

    _resetSession() {
        if (this.sshClient) {
            try { this.sshClient.end(); } catch (e) { /* already closed */ }
        }
        this.sshClient = null;
        this.sftpClient = null;
        this.isConnected = false;
    }

    // Runs an operation against the SFTP session, re-establishing the connection once
    // if the existing session turns out to be dead/stale (phone idle, Wi-Fi flap, etc.).
    async withSession(device, fn) {
        let attempt = 0;
        for (;;) {
            const sftp = await this.ensureSftpSession(device);
            try {
                return await fn(sftp);
            } catch (err) {
                if (attempt++ === 0 && !this.isConnected) {
                    this._resetSession();
                    continue;
                }
                throw err;
            }
        }
    }

    async ensureSftpSession(device) {
        const dev = device || this.currentDevice;
        if (this.sftpClient && this.isConnected) return this.sftpClient;

        if (!this.sftpConfig) {
            if (!dev) throw new Error('No device available to request SFTP credentials');
            this.requestSftpMount(dev);
            await this.waitForConfig(6000);
            if (!this.sftpConfig) throw new Error('SFTP credentials not received within timeout');
        }

        try {
            await this.connectSftp();
        } catch (err) {
            // The stored password may be stale (the phone regenerates it per request). Invalidate
            // the config, fetch fresh credentials, and retry once before giving up.
            this._resetSession();
            this.sftpConfig = null;
            if (!dev) throw err;
            this.requestSftpMount(dev);
            await this.waitForConfig(6000);
            if (!this.sftpConfig) throw err;
            await this.connectSftp();
        }

        return this.sftpClient;
    }

    connectSftp(configOverride) {
        return new Promise((resolve, reject) => {
            const config = configOverride || this.sftpConfig;
            if (!config) return reject(new Error('No SFTP configuration available'));

            const conn = new Client();

            conn.on('ready', () => {
                console.log(`[SftpPlugin] SSH2 Client Ready. Opening SFTP session...`);
                this.sshClient = conn;
                conn.sftp((err, sftp) => {
                    if (err) {
                        conn.end();
                        return reject(err);
                    }
                    this.sftpClient = sftp;
                    this.isConnected = true;
                    resolve(sftp);
                });
            });

            conn.on('error', (err) => {
                console.error(`[SftpPlugin] SSH2 Error: ${err.message} (${config.ip}:${config.port} user=${config.user})`);
                this.isConnected = false;
                reject(err);
            });

            conn.on('close', () => {
                if (this.sshClient === conn) {
                    this.isConnected = false;
                    this.sftpClient = null;
                    this.sshClient = null;
                }
            });

            conn.connect({
                host: config.ip,
                port: config.port,
                username: config.user,
                password: config.password,
                readyTimeout: 10000
            });
        });
    }

    async listDirectory(remotePath = '/sdcard') {
        return this.withSession(this.currentDevice, (sftp) => new Promise((resolve, reject) => {
            sftp.readdir(remotePath, (err, list) => {
                if (err) return reject(err);

                const items = list.map((item) => ({
                    name: item.filename,
                    isDir: item.attrs.isDirectory(),
                    size: item.attrs.size,
                    modifyTime: item.attrs.mtime * 1000,
                    path: path.posix.join(remotePath, item.filename)
                }));

                items.sort((a, b) => {
                    if (a.isDir && !b.isDir) return -1;
                    if (!a.isDir && b.isDir) return 1;
                    return a.name.localeCompare(b.name);
                });

                resolve(items);
            });
        }));
    }

    async downloadFile(remoteFilePath, localFilePath) {
        return this.withSession(this.currentDevice, (sftp) => new Promise((resolve, reject) => {
            sftp.fastGet(remoteFilePath, localFilePath, (err) => {
                if (err) return reject(err);
                resolve(localFilePath);
            });
        }));
    }

    async uploadFile(localFilePath, remoteFilePath, onProgress) {
        return this.withSession(this.currentDevice, (sftp) => new Promise((resolve, reject) => {
            const total = fs.statSync(localFilePath).size || 0;
            let transferred = 0;

            const readStream = fs.createReadStream(localFilePath);
            const writeStream = sftp.createWriteStream(remoteFilePath);

            writeStream.on('close', () => resolve(remoteFilePath));
            writeStream.on('error', (err) => reject(err));
            readStream.on('error', (err) => reject(err));
            readStream.on('data', (chunk) => {
                transferred += chunk.length;
                if (onProgress && total > 0) {
                    onProgress(Math.min(1, transferred / total));
                }
            });

            readStream.pipe(writeStream);
        }));
    }

    async deleteItem(remotePath, isDirectory = false) {
        return this.withSession(this.currentDevice, (sftp) => new Promise((resolve, reject) => {
            const action = isDirectory ? sftp.rmdir.bind(sftp) : sftp.unlink.bind(sftp);
            action(remotePath, (err) => {
                if (err) return reject(err);
                resolve(true);
            });
        }));
    }

    async createDirectory(remotePath) {
        return this.withSession(this.currentDevice, (sftp) => new Promise((resolve, reject) => {
            sftp.mkdir(remotePath, (err) => {
                if (err) return reject(err);
                resolve(true);
            });
        }));
    }
}

module.exports = SftpPlugin;
