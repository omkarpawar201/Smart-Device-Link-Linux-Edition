const EventEmitter = require('events');

class PacketRouter extends EventEmitter {
    constructor() {
        super();
        this.plugins = new Map(); // packetType -> Array of plugin handlers
        this.registerCoreHandlers();
    }

    registerPlugin(plugin) {
        const caps = plugin.getCapabilities();
        caps.forEach((packetType) => {
            if (!this.plugins.has(packetType)) {
                this.plugins.set(packetType, []);
            }
            this.plugins.get(packetType).push(plugin);
        });
        console.log(`[PacketRouter] Registered plugin: ${plugin.name} (${caps.join(', ')})`);
    }

    registerCoreHandlers() {
        // Automatic responder for Ping packets
        this.on('packet:kdeconnect.ping', ({ device, packet }) => {
            console.log(`[PacketRouter] Ping received from ${device.info.name}`);
            // Respond with ping packet if requested
            device.sendPacket({
                id: Date.now(),
                type: 'kdeconnect.ping',
                body: { message: 'pong' }
            });
        });
    }

    routePacket(device, packet, payload) {
        if (!packet || !packet.type) return;

        // Emit event for core system listeners
        this.emit(`packet:${packet.type}`, { device, packet, payload });
        this.emit('packet', { device, packet, payload });

        // Route to registered plugins
        const handlers = this.plugins.get(packet.type);
        if (handlers && handlers.length > 0) {
            handlers.forEach((plugin) => {
                try {
                    plugin.handlePacket(device, packet, payload);
                } catch (err) {
                    console.error(`[PacketRouter Error in ${plugin.name}]:`, err.message);
                }
            });
        } else {
            // Unhandled packet type log
            // console.log(`[PacketRouter] Unhandled packet type: ${packet.type}`);
        }
    }
}

module.exports = PacketRouter;
