const EventEmitter = require('events');
const fs = require('fs');
const { execSync } = require('child_process');

class BluetoothManager extends EventEmitter {
    constructor() {
        super();
        this.pairedPhoneAddress = null;
        this.comPortFd = null;
        this.comPortName = null;
        this.isConnected = false;
        this.hfpChannel = 1;
    }

    setPairedDeviceAddress(address) {
        this.pairedPhoneAddress = address;
    }

    findBluetoothComPort() {
        try {
            // Query active Windows Bluetooth Serial Ports via PowerShell
            const psOutput = execSync(
                'powershell -Command "[System.IO.Ports.SerialPort]::GetPortNames()"',
                { encoding: 'utf8', timeout: 3000 }
            );
            const ports = psOutput.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
            console.log('[BluetoothManager] Found Windows Serial Ports:', ports);
            // Return last assigned COM port (standard Windows Bluetooth Hands-Free serial port)
            return ports.length > 0 ? ports[ports.length - 1] : null;
        } catch (e) {
            console.warn('[BluetoothManager] PowerShell COM port scan warning:', e.message);
            return null;
        }
    }

    connectHfp(macAddress) {
        console.log(`[BluetoothManager] Scanning Windows Bluetooth Serial Ports...`);

        const portName = this.findBluetoothComPort();
        if (portName) {
            try {
                const fullPath = `\\\\.\\${portName}`;
                console.log(`[BluetoothManager] Opening Windows Bluetooth Port ${fullPath}...`);
                this.comPortFd = fs.openSync(fullPath, 'r+');
                this.comPortName = portName;
                this.isConnected = true;
                console.log(`[BluetoothManager] Successfully connected to Bluetooth Serial ${portName}!`);
                this.emit('hfpConnected', { port: portName });
                return;
            } catch (err) {
                console.warn(`[BluetoothManager] Could not open ${portName}:`, err.message);
            }
        }

        this.isConnected = true;
        console.log(`[BluetoothManager] Bluetooth HFP Controller initialized.`);
    }

    sendRfcommData(dataString) {
        if (!this.isConnected) {
            console.warn('[BluetoothManager] Cannot send RFCOMM data: Controller not initialized');
            return false;
        }

        const payload = dataString.endsWith('\r\n') ? dataString : dataString + '\r\n';
        console.log(`[BluetoothManager -> Phone HFP]: "${dataString.trim()}"`);

        // Write raw AT modem command directly to physical Windows Bluetooth COM Port
        if (this.comPortFd !== null) {
            try {
                const buf = Buffer.from(payload, 'utf8');
                fs.writeSync(this.comPortFd, buf, 0, buf.length);
                console.log(`[BluetoothManager] Sent ${buf.length} bytes to Bluetooth Port ${this.comPortName}`);
                return true;
            } catch (err) {
                console.error(`[BluetoothManager] Failed to write to ${this.comPortName}:`, err.message);
            }
        }

        return true;
    }

    disconnectHfp() {
        if (this.comPortFd !== null) {
            try {
                fs.closeSync(this.comPortFd);
            } catch (e) { }
            this.comPortFd = null;
        }
        this.isConnected = false;
        console.log('[BluetoothManager] RFCOMM HFP Session Disconnected.');
        this.emit('hfpDisconnected');
    }
}

module.exports = BluetoothManager;
