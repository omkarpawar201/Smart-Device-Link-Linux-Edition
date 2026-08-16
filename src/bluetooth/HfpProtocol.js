const EventEmitter = require('events');

class HfpProtocol extends EventEmitter {
    constructor(bluetoothManager) {
        super();
        this.btManager = bluetoothManager;
        this.state = 'DISCONNECTED'; // 'DISCONNECTED' | 'HANDSHAKE' | 'READY' | 'RINGING' | 'IN_CALL'

        this.indicators = {
            service: 1,  // 0: No network, 1: Available
            call: 0,     // 0: No call, 1: Call active
            callsetup: 0,// 0: None, 1: Incoming, 2: Outgoing, 3: Remote alerted
            callheld: 0, // 0: None, 1: Held, 2: Multicall
            signal: 4,   // 0-5 signal bars
            roam: 0,     // 0: Home, 1: Roaming
            battchg: 5   // 0-5 battery level
        };

        this.setupListeners();
    }

    setupListeners() {
        if (!this.btManager) return;

        this.btManager.on('hfpConnected', () => {
            this.state = 'HANDSHAKE';
            this.startHandshake();
        });

        this.btManager.on('hfpData', (data) => {
            this.parseAtResponse(data);
        });

        this.btManager.on('hfpDisconnected', () => {
            this.state = 'DISCONNECTED';
            this.indicators.call = 0;
            this.indicators.callsetup = 0;
            this.emit('hfpStateChanged', { state: this.state, indicators: this.indicators });
        });
    }

    startHandshake() {
        console.log('[HfpProtocol] Executing HFP Service Level Connection (SLC) Handshake...');
        // Step 1: Send BRSF (Bluetooth Retrieve Supported Features)
        this.sendAt('AT+BRSF=1023');
    }

    sendAt(command) {
        if (this.btManager) {
            this.btManager.sendRfcommData(command);
        }
    }

    parseAtResponse(responseText) {
        const lines = responseText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

        lines.forEach((line) => {
            if (line.startsWith('+BRSF:')) {
                // Step 2: Query Indicator Definitions
                this.sendAt('AT+CIND=?');
            } else if (line.startsWith('+CIND:')) {
                if (line.includes('(')) {
                    // Step 3: Read current indicator values
                    this.sendAt('AT+CIND?');
                } else {
                    // Step 4: Enable event reporting
                    this.sendAt('AT+CMER=3,0,0,1');
                    this.state = 'READY';
                    console.log('[HfpProtocol] HFP SLC Handshake Complete. Ready for Calls!');
                    this.emit('hfpReady');
                }
            } else if (line === 'RING') {
                this.state = 'RINGING';
                console.log('[HfpProtocol] INCOMING CALL RINGING!');
                this.emit('incomingCallRinging');
            } else if (line.startsWith('+CLIP:')) {
                // +CLIP: "+15552345678",129
                const parts = line.split('"');
                const callerNum = parts[1] || 'Unknown';
                console.log(`[HfpProtocol] Incoming Call CID: ${callerNum}`);
                this.emit('incomingCallDetails', { number: callerNum });
            } else if (line.startsWith('+CIEV:')) {
                // +CIEV: <ind_index>,<value>
                this.handleIndicatorChange(line);
            }
        });
    }

    handleIndicatorChange(line) {
        const match = line.match(/\+CIEV:\s*(\d+),(\d+)/);
        if (match) {
            const indIndex = parseInt(match[1], 10);
            const val = parseInt(match[2], 10);

            if (indIndex === 2) {
                this.indicators.call = val;
                this.state = val === 1 ? 'IN_CALL' : 'READY';
            } else if (indIndex === 3) {
                this.indicators.callsetup = val;
                if (val === 1) this.state = 'RINGING';
            }

            console.log(`[HfpProtocol] Indicator Event -> Call: ${this.indicators.call}, Setup: ${this.indicators.callsetup}`);
            this.emit('hfpStateChanged', { state: this.state, indicators: this.indicators });
        }
    }

    // User Call Actions
    answerCall() {
        console.log('[HfpProtocol] Answering Call (ATA)...');
        this.sendAt('ATA');
        this.state = 'IN_CALL';
        this.emit('callAnswered');
    }

    hangupCall() {
        console.log('[HfpProtocol] Hanging Up Call (ATH)...');
        this.sendAt('ATH');
        this.state = 'READY';
        this.emit('callEnded');
    }

    dialNumber(phoneNumber) {
        if (!phoneNumber) return;
        const cleanNum = phoneNumber.replace(/[^\d+]/g, '');
        console.log(`[HfpProtocol] Dialing Number (ATD${cleanNum};)...`);
        this.sendAt(`ATD${cleanNum};`);
        this.state = 'IN_CALL';
        this.emit('callStarted', { number: cleanNum });
    }

    setMicrophoneVolume(volume) {
        const vol = Math.min(15, Math.max(0, Math.floor(volume / 6.6)));
        this.sendAt(`AT+VGM=${vol}`);
    }

    setSpeakerVolume(volume) {
        const vol = Math.min(15, Math.max(0, Math.floor(volume / 6.6)));
        this.sendAt(`AT+VGS=${vol}`);
    }
}

module.exports = HfpProtocol;
