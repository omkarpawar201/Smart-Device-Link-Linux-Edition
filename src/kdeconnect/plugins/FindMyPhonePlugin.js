const BasePlugin = require('./BasePlugin');

class FindMyPhonePlugin extends BasePlugin {
    constructor(eventEmitter) {
        super('FindMyPhonePlugin');
        this.emitter = eventEmitter;
    }

    getCapabilities() {
        return ['kdeconnect.findmyphone.request'];
    }

    handlePacket(device, packet) {
        // Usually outbound, but handles ring feedback if sent back
    }

    ringPhone(device) {
        if (!device) return false;

        const ringPacket = {
            id: Date.now(),
            type: 'kdeconnect.findmyphone.request',
            body: {}
        };

        console.log(`[FindMyPhonePlugin] Ringing phone: ${device.info.name}`);
        return device.sendPacket(ringPacket);
    }
}

module.exports = FindMyPhonePlugin;
