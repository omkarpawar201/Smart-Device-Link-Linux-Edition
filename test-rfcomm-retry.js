// Rapid retry harness: attempts RFCOMM connect every 2s for ~120s.
// Run: node test-rfcomm-retry.js DCB72E2E313B
const path = require('path');
const RfcommClient = require('./src/bluetooth/RfcommClient');
const RfcommProtocol = require('./src/bluetooth/RfcommProtocol');

const mac = process.argv[2];
if (!mac) { console.log('Usage: node test-rfcomm-retry.js <MAC>'); process.exit(1); }

const client = new RfcommClient({
    bridgeScript: path.join(__dirname, 'src/bluetooth/rfcomm-bridge.ps1'),
    configPath: path.join(__dirname, 'phone-link-test.json')
});
const proto = new RfcommProtocol(client);

let connected = false;
proto.on('linkUp', (i) => { connected = true; console.log(new Date().toISOString(), 'LINK UP:', i.mac, '|', i.name); });
proto.on('handshake', () => console.log(new Date().toISOString(), 'HANDSHAKE ok'));
proto.on('linkReady', () => console.log(new Date().toISOString(), 'LINK READY - linked!'));
proto.on('linkDown', () => console.log(new Date().toISOString(), 'LINK DOWN'));
client.on('error', (e) => console.log(new Date().toISOString(), 'ERR:', e.code, '-', e.message));

const start = Date.now();
let attempt = 0;

function tryConnect() {
    if (connected) return;
    if (Date.now() - start > 120000) { console.log('Window closed, no connection.'); process.exit(0); }
    attempt++;
    console.log(new Date().toISOString(), `--- attempt ${attempt} ---`);
    client.connect({ mac, name: 'phone' });
}

// The client reconnects on its own, but force our 2s cadence too.
client.on('error', () => { setTimeout(tryConnect, 2000); });
tryConnect();
