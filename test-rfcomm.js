// Standalone RFCOMM link test — no Electron/UI needed.
// Run: node test-rfcomm.js
// Force the phone MAC (no colons) with:  npm run test:link -- <MAC>
const path = require('path');
const os = require('os');
const RfcommClient = require('./src/bluetooth/RfcommClient');
const RfcommProtocol = require('./src/bluetooth/RfcommProtocol');

const forcedMac = process.argv[2];
const client = new RfcommClient({
    bridgeScript: path.join(__dirname, 'src/bluetooth/rfcomm-bridge.ps1'),
    configPath: path.join(__dirname, 'phone-link-test.json')
});
const proto = new RfcommProtocol(client);

proto.on('linkUp', (i) => console.log('LINK UP:', i.mac, '|', i.name));
proto.on('handshake', () => console.log('HANDSHAKE ok'));
proto.on('linkReady', () => console.log('LINK READY - linked!'));
proto.on('callRing', (d) => console.log('INCOMING CALL from', d.name || d.number));
proto.on('callState', (s) => console.log('CALL STATE:', s.state, s.number || ''));
proto.on('linkDown', () => console.log('LINK DOWN'));
client.on('error', (e) => console.log('ERROR:', e.code, '-', e.message));

if (forcedMac) {
    client.connect({ mac: forcedMac, name: 'phone' });
} else {
    client.connect(); // resolves MAC from phone-link-test.json or scans paired devices
}
