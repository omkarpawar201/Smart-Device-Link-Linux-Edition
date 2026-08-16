const BasePlugin = require('./BasePlugin');

class ConnectivityPlugin extends BasePlugin {
    constructor(eventEmitter) {
        super('ConnectivityPlugin');
        this.emitter = eventEmitter;
        this.connectivityState = {
            signalStrength: 4, // 0 to 4 bars
            networkType: '5G', // e.g. "5G", "LTE", "Wi-Fi"
            isRoaming: false
        };
    }

    getCapabilities() {
        return ['kdeconnect.connectivity_report', 'kdeconnect.connectivity_report.request'];
    }

    handlePacket(device, packet) {
        if (packet.type === 'kdeconnect.connectivity_report') {
            const body = packet.body || {};

            const networkLabel = body.networkType || body.gsmNetworkType || '4G';

            this.connectivityState = {
                signalStrength: typeof body.signalStrength === 'number' ? body.signalStrength : 4,
                networkType: networkLabel,
                isRoaming: !!body.isRoaming,
                updatedAt: Date.now()
            };

            console.log(`[ConnectivityPlugin] ${device.info.name} Signal: ${this.connectivityState.signalStrength}/4 (${this.connectivityState.networkType})`);

            if (this.emitter) {
                this.emitter.emit('connectivityStateChanged', {
                    deviceId: device.info.id,
                    ...this.connectivityState
                });
            }
        }
    }


    requestReport(device) {
        if (!device) return false;

        const requestPacket = {
            id: Date.now(),
            type: 'kdeconnect.connectivity_report.request',
            body: { request: true }
        };

        return device.sendPacket(requestPacket);
    }
}

module.exports = ConnectivityPlugin;
