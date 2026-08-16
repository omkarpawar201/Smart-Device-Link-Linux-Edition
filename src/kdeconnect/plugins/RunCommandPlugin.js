const BasePlugin = require('./BasePlugin');

class RunCommandPlugin extends BasePlugin {
    constructor(eventEmitter) {
        super('RunCommandPlugin');
        this.emitter = eventEmitter;
        this.commandsList = [];
    }

    getCapabilities() {
        return ['kdeconnect.runcommand'];
    }

    handlePacket(device, packet) {
        if (packet.type === 'kdeconnect.runcommand') {
            const body = packet.body || {};

            if (body.commandList) {
                try {
                    this.commandsList = JSON.parse(body.commandList);
                } catch (e) {
                    this.commandsList = [];
                }

                console.log(`[RunCommandPlugin] Received ${this.commandsList.length} remote commands from ${device.info.name}`);

                if (this.emitter) {
                    this.emitter.emit('remoteCommandsUpdated', {
                        deviceId: device.info.id,
                        commands: this.commandsList
                    });
                }
            }
        }
    }

    executeCommand(device, commandKey) {
        if (!device || !commandKey) return false;

        const execPacket = {
            id: Date.now(),
            type: 'kdeconnect.runcommand.request',
            body: {
                key: commandKey
            }
        };

        console.log(`[RunCommandPlugin] Executing command "${commandKey}" on ${device.info.name}`);
        return device.sendPacket(execPacket);
    }

    getCommands() {
        return this.commandsList;
    }
}

module.exports = RunCommandPlugin;
