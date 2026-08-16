const BasePlugin = require('./BasePlugin');

class BatteryPlugin extends BasePlugin {
    constructor(eventEmitter) {
        super('BatteryPlugin');
        this.emitter = eventEmitter;
        this.batteryState = {
            charge: 100,
            isCharging: false,
            thresholdEvent: 0 // 0: None, 1: Low, 2: Critical
        };
    }

    getCapabilities() {
        return ['kdeconnect.battery', 'kdeconnect.battery.request'];
    }

    handlePacket(device, packet) {
        if (packet.type === 'kdeconnect.battery') {
            const body = packet.body || {};

            const isChargingVal = typeof body.isCharging === 'boolean'
                ? body.isCharging
                : Boolean(body.isCharging === 1 || body.isCharging === 'true');

            this.batteryState = {
                charge: typeof body.currentCharge === 'number' ? body.currentCharge : (typeof body.thresholdEvent === 'number' ? body.thresholdEvent : this.batteryState.charge),
                isCharging: isChargingVal,
                thresholdEvent: body.thresholdEvent || 0,
                updatedAt: Date.now()
            };

            console.log(`[BatteryPlugin] ${device.info.name} Battery: ${this.batteryState.charge}% (Charging: ${this.batteryState.isCharging})`);

            if (this.emitter) {
                this.emitter.emit('batteryStateChanged', {
                    deviceId: device.info.id,
                    ...this.batteryState
                });
            }
        }
    }


    requestBatteryStatus(device) {
        if (!device) return false;

        const requestPacket = {
            id: Date.now(),
            type: 'kdeconnect.battery.request',
            body: { request: true }
        };

        return device.sendPacket(requestPacket);
    }
}

module.exports = BatteryPlugin;
