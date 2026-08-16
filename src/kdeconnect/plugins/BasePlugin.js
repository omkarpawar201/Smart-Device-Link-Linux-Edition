class BasePlugin {
    constructor(name) {
        this.name = name;
    }

    // Returns array of packet types this plugin listens to
    getCapabilities() {
        return [];
    }

    // Abstract method implemented by feature plugins
    handlePacket(device, packet) {
        console.log(`[Plugin:${this.name}] Received packet ${packet.type} from ${device.info.name}`);
    }
}

module.exports = BasePlugin;
