const BasePlugin = require('./BasePlugin');

class TelephonyPlugin extends BasePlugin {
    constructor(eventEmitter) {
        super('TelephonyPlugin');
        this.emitter = eventEmitter;
        this.activeCall = null;
    }

    getCapabilities() {
        return ['kdeconnect.telephony'];
    }

    handlePacket(device, packet) {
        if (packet.type === 'kdeconnect.telephony') {
            const body = packet.body || {};
            const event = body.event || '';

            // The phone resends the last packet (ringing/talking) with isCancel=true to signal the
            // call ended, so it must be checked before the event-specific branches below.
            if (body.isCancel) {
                const endedData = this.activeCall
                    ? { ...this.activeCall, event: 'ended', isCancel: true }
                    : {
                        deviceId: device.info.id,
                        phoneNumber: body.phoneNumber || 'Unknown Number',
                        contactName: body.contactName || body.phoneNumber || 'Unknown Caller',
                        phoneThumbnail: body.phoneThumbnail || null,
                        event: 'ended',
                        isCancel: true,
                        timestamp: Date.now()
                    };
                this.activeCall = null;
                console.log(`[TelephonyPlugin] Call ended on ${device.info.name} (${endedData.contactName} - ${endedData.phoneNumber})`);
                if (this.emitter) {
                    this.emitter.emit('callEnded', endedData);
                }
                return;
            }

            const callData = {
                deviceId: device.info.id,
                phoneNumber: body.phoneNumber || 'Unknown Number',
                contactName: body.contactName || body.phoneNumber || 'Unknown Caller',
                phoneThumbnail: body.phoneThumbnail || null,
                event: event,
                timestamp: Date.now()
            };

            console.log(`[TelephonyPlugin] Call Event from ${device.info.name}: "${event}" (${callData.contactName} - ${callData.phoneNumber})`);

            if (event === 'ringing') {
                this.activeCall = callData;
                if (this.emitter) {
                    this.emitter.emit('incomingCall', callData);
                }
            } else if (event === 'missedCall') {
                this.activeCall = null;
                if (this.emitter) {
                    this.emitter.emit('missedCall', callData);
                }
            } else if (event === 'talking') {
                if (this.activeCall) {
                    this.activeCall.event = 'talking';
                }
                if (this.emitter) {
                    this.emitter.emit('callTalking', callData);
                }
            }
        }
    }

    acceptCall(device) {
        if (!device) return false;

        const acceptPacket = {
            id: Date.now(),
            type: 'kdeconnect.telephony.request',
            body: { action: 'accept' }
        };

        console.log(`[TelephonyPlugin] Sending Accept Call request to ${device.info.name}`);
        return device.sendPacket(acceptPacket);
    }

    rejectCall(device) {
        if (!device) return false;

        const rejectPacket = {
            id: Date.now(),
            type: 'kdeconnect.telephony.request',
            body: { action: 'reject' }
        };

        console.log(`[TelephonyPlugin] Sending Reject Call request to ${device.info.name}`);
        return device.sendPacket(rejectPacket);
    }

    requestMute(device) {
        if (!device) return false;

        const mutePacket = {
            id: Date.now(),
            type: 'kdeconnect.telephony.request_mute',
            body: {}
        };

        console.log(`[TelephonyPlugin] Requesting call mute on ${device.info.name}`);
        return device.sendPacket(mutePacket);
    }

    getActiveCall() {
        return this.activeCall;
    }
}

module.exports = TelephonyPlugin;
