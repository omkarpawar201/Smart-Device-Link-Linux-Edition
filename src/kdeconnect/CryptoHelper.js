const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

class CryptoHelper {
    constructor(storageDir) {
        this.storageDir = storageDir || path.join(os.homedir(), '.smart_device_link_keys');
        this.keyPath = path.join(this.storageDir, 'private.pem');
        this.certPath = path.join(this.storageDir, 'certificate.pem');
        this.deviceIdPath = path.join(this.storageDir, 'deviceId.txt');

        this.deviceId = null;
        this.privateKey = null;
        this.certificate = null;

        this.initKeys();
    }

    initKeys() {
        if (!fs.existsSync(this.storageDir)) {
            fs.mkdirSync(this.storageDir, { recursive: true });
        }

        // Load or generate Device ID (standard KDE Connect format)
        if (fs.existsSync(this.deviceIdPath)) {
            const rawId = fs.readFileSync(this.deviceIdPath, 'utf8').trim();
            if (rawId.startsWith('_')) {
                this.deviceId = rawId;
            } else {
                this.deviceId = '_' + crypto.randomBytes(16).toString('hex');
                fs.writeFileSync(this.deviceIdPath, this.deviceId, 'utf8');
            }
        } else {
            this.deviceId = '_' + crypto.randomBytes(16).toString('hex');
            fs.writeFileSync(this.deviceIdPath, this.deviceId, 'utf8');
        }

        // Load or generate RSA Keys and TLS Certificate
        if (fs.existsSync(this.keyPath) && fs.existsSync(this.certPath)) {
            const certStr = fs.readFileSync(this.certPath, 'utf8');
            try {
                const x509 = new crypto.X509Certificate(certStr);
                if (x509 && x509.subject.includes(this.deviceId)) {
                    this.privateKey = fs.readFileSync(this.keyPath, 'utf8');
                    this.certificate = certStr;
                    console.log('[CryptoHelper] Validated existing X.509 certificate for:', this.deviceId);
                } else {
                    console.log('[CryptoHelper] Device ID mismatch in certificate, regenerating...');
                    this.generateNewCertificate();
                }
            } catch (e) {
                console.warn('[CryptoHelper] Existing certificate invalid, regenerating...');
                this.generateNewCertificate();
            }
        } else {
            this.generateNewCertificate();
        }
    }

    generateNewCertificate() {
        console.log('[CryptoHelper] Fast generating X.509 v3 certificate for deviceId:', this.deviceId);

        // Native OpenSSL C++ key generation (< 50ms)
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });

        this.privateKey = privateKey;
        this.certificate = this.createSelfSignedCert(publicKey, privateKey, this.deviceId);

        // Verify with OpenSSL
        try {
            const certObj = new crypto.X509Certificate(this.certificate);
            console.log(`[CryptoHelper] Certificate Verified with OpenSSL! Fingerprint: ${certObj.fingerprint256}`);
        } catch (err) {
            console.error('[CryptoHelper] X.509 Verification Failed:', err.message);
        }

        // Save to disk
        fs.writeFileSync(this.keyPath, this.privateKey, 'utf8');
        fs.writeFileSync(this.certPath, this.certificate, 'utf8');
    }

    createSelfSignedCert(publicKeyPem, privateKeyPem, deviceId) {
        function encodeLength(len) {
            if (len < 128) return Buffer.from([len]);
            const bytes = [];
            let temp = len;
            while (temp > 0) {
                bytes.unshift(temp & 0xff);
                temp >>= 8;
            }
            return Buffer.from([0x80 | bytes.length, ...bytes]);
        }

        function derEncode(tag, payload) {
            const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
            return Buffer.concat([Buffer.from([tag]), encodeLength(buf.length), buf]);
        }

        const version = derEncode(0xa0, derEncode(0x02, Buffer.from([0x02]))); // v3
        const serial = derEncode(0x02, crypto.randomBytes(16));

        // sha256WithRSAEncryption OID: 1.2.840.113549.1.1.11
        const oidSha256WithRSA = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]);
        const sigAlg = derEncode(0x30, Buffer.concat([
            derEncode(0x06, oidSha256WithRSA),
            derEncode(0x05, Buffer.alloc(0))
        ]));

        // commonName OID: 2.5.4.3 (MUST match deviceId)
        const commonNameStr = deviceId || 'Smart Device Link';
        const oidCommonName = Buffer.from([0x55, 0x04, 0x03]);
        const nameAttr = derEncode(0x30, Buffer.concat([
            derEncode(0x06, oidCommonName),
            derEncode(0x0c, Buffer.from(commonNameStr, 'utf8'))
        ]));
        const name = derEncode(0x30, derEncode(0x31, nameAttr));

        // 10-Year Validity Window
        const now = new Date();
        const future = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);
        const toUtcStr = (d) => d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';

        const notBefore = derEncode(0x17, Buffer.from(toUtcStr(now), 'ascii'));
        const notAfter = derEncode(0x17, Buffer.from(toUtcStr(future), 'ascii'));
        const validity = derEncode(0x30, Buffer.concat([notBefore, notAfter]));

        const spkiDer = Buffer.from(
            publicKeyPem
                .replace(/-----BEGIN PUBLIC KEY-----/g, '')
                .replace(/-----END PUBLIC KEY-----/g, '')
                .replace(/\s+/g, ''),
            'base64'
        );

        // X.509 v3 Extensions: BasicConstraints, KeyUsage, SubjectAlternativeName (SAN)
        const oidBasicConstraints = Buffer.from([0x55, 0x1d, 0x13]);
        const extBasicConstraints = derEncode(0x30, Buffer.concat([
            derEncode(0x06, oidBasicConstraints),
            derEncode(0x01, Buffer.from([0xff])),
            derEncode(0x04, derEncode(0x30, Buffer.alloc(0)))
        ]));

        const oidKeyUsage = Buffer.from([0x55, 0x1d, 0x0f]);
        const extKeyUsage = derEncode(0x30, Buffer.concat([
            derEncode(0x06, oidKeyUsage),
            derEncode(0x01, Buffer.from([0xff])),
            derEncode(0x04, derEncode(0x03, Buffer.from([0x05, 0xa0])))
        ]));

        const oidSAN = Buffer.from([0x55, 0x1d, 0x11]);
        const sanName = derEncode(0x82, Buffer.from(commonNameStr, 'utf8'));
        const extSAN = derEncode(0x30, Buffer.concat([
            derEncode(0x06, oidSAN),
            derEncode(0x04, derEncode(0x30, sanName))
        ]));

        const extensionsSeq = derEncode(0x30, Buffer.concat([
            extBasicConstraints,
            extKeyUsage,
            extSAN
        ]));
        const extensionsExplicit = derEncode(0xa3, extensionsSeq);

        const tbsCert = derEncode(0x30, Buffer.concat([
            version,
            serial,
            sigAlg,
            name,
            validity,
            name,
            spkiDer,
            extensionsExplicit
        ]));

        const signer = crypto.createSign('SHA256');
        signer.update(tbsCert);
        const sigBuf = signer.sign(privateKeyPem);
        const sigBitString = derEncode(0x03, Buffer.concat([Buffer.from([0x00]), sigBuf]));

        const certDer = derEncode(0x30, Buffer.concat([
            tbsCert,
            sigAlg,
            sigBitString
        ]));

        const pemLines = certDer.toString('base64').match(/.{1,64}/g).join('\n');
        return `-----BEGIN CERTIFICATE-----\n${pemLines}\n-----END CERTIFICATE-----\n`;
    }

    verifyPeerCertificate(tlsSocket, expectedDeviceId, trustedFingerprint) {
        try {
            if (!tlsSocket || typeof tlsSocket.getPeerCertificate !== 'function') {
                return { valid: false, reason: 'Not a TLS socket' };
            }

            const peerCert = tlsSocket.getPeerCertificate(true);
            if (!peerCert || !peerCert.raw) {
                console.warn('[CryptoHelper] Remote peer provided no certificate');
                return { valid: false, reason: 'No peer certificate' };
            }

            const x509 = new crypto.X509Certificate(peerCert.raw);
            const cnMatch = x509.subject.match(/CN=([^,\n]+)/);
            const peerCN = cnMatch ? cnMatch[1].trim() : null;
            const fingerprint = x509.fingerprint256.replace(/:/g, '').toLowerCase();

            if (expectedDeviceId && peerCN !== expectedDeviceId) {
                console.warn(`[CryptoHelper] Certificate CN (${peerCN}) does not match expected deviceId (${expectedDeviceId})`);
                return { valid: false, reason: 'CN mismatch', peerCN, fingerprint, certPem: x509.toString() };
            }

            if (trustedFingerprint && fingerprint !== trustedFingerprint.toLowerCase()) {
                console.warn(`[CryptoHelper] Certificate Pinning Mismatch! Remote: ${fingerprint}, Trusted: ${trustedFingerprint}`);
                return { valid: false, reason: 'Certificate Pinning Mismatch', peerCN, fingerprint, certPem: x509.toString() };
            }

            return {
                valid: true,
                peerDeviceId: peerCN || expectedDeviceId,
                fingerprint: fingerprint,
                certPem: x509.toString()
            };
        } catch (err) {
            console.error('[CryptoHelper] Failed to verify peer certificate:', err.message);
            return { valid: false, reason: err.message };
        }
    }

    getFingerprint(certPem) {
        const pem = certPem || this.certificate || '';
        try {
            const x509 = new crypto.X509Certificate(pem);
            return x509.fingerprint256.replace(/:/g, '').toLowerCase();
        } catch (e) {
            const base64 = pem
                .replace(/-----BEGIN CERTIFICATE-----/g, '')
                .replace(/-----END CERTIFICATE-----/g, '')
                .replace(/[\r\n\s]/g, '');
            const derBuffer = Buffer.from(base64, 'base64');
            return crypto.createHash('sha256').update(derBuffer).digest('hex');
        }
    }

    getDeviceName() {
        return os.hostname() || 'Smart Device Link PC';
    }

    getIdentityPacket() {
        return {
            id: Date.now(),
            type: 'kdeconnect.identity',
            body: {
                deviceId: this.deviceId,
                deviceName: this.getDeviceName(),
                protocolVersion: 7,
                deviceType: 'desktop',
                tcpPort: 1716,
                incomingCapabilities: [
                    'kdeconnect.notification',
                    'kdeconnect.notification.request',
                    'kdeconnect.telephony',
                    'kdeconnect.sms.messages',
                    'kdeconnect.contacts.response_uids_timestamps',
                    'kdeconnect.contacts.response_vcards',
                    'kdeconnect.battery',
                    'kdeconnect.clipboard',
                    'kdeconnect.sftp',
                    'kdeconnect.share.request',
                    'kdeconnect.mpris',
                    'kdeconnect.mpris.request',
                    'kdeconnect.ping',
                    'kdeconnect.connectivity_report',
                    'kdeconnect.findmyphone'
                ],
                outgoingCapabilities: [
                    'kdeconnect.notification',
                    'kdeconnect.notification.request',
                    'kdeconnect.telephony.request_mute',
                    'kdeconnect.sms.request',
                    'kdeconnect.sms.request_conversations',
                    'kdeconnect.sms.request_conversation',
                    'kdeconnect.contacts.request_all_uids_timestamps',
                    'kdeconnect.contacts.request_vcards_by_uid',
                    'kdeconnect.clipboard',
                    'kdeconnect.share.request',
                    'kdeconnect.mpris',
                    'kdeconnect.mpris.request',
                    'kdeconnect.ping',
                    'kdeconnect.findmyphone.request'
                ]
            }
        };
    }
}

module.exports = CryptoHelper;
