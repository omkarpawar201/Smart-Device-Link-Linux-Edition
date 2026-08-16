const BasePlugin = require('./BasePlugin');

const VCARDS_REQUEST_CHUNK_SIZE = 50;

class ContactsPlugin extends BasePlugin {
    constructor(eventEmitter) {
        super('ContactsPlugin');
        this.emitter = eventEmitter;
        this.contactsMap = new Map(); // uid -> { id, name, number, numbers, avatar }
    }

    getCapabilities() {
        return [
            'kdeconnect.contacts.response_uids_timestamps',
            'kdeconnect.contacts.response_vcards',
            'kdeconnect.contacts',
            'kdeconnect.contacts.response'
        ];
    }

    handlePacket(device, packet) {
        console.log(`[ContactsPlugin] Packet ${packet.type} received from ${device.info.name} (keys: ${Object.keys(packet.body || {}).join(', ')})`);

        // Step 1 response: the phone answers the uid list request with a set of uids.
        // Fetch the actual vCards for those uids next.
        if (packet.type === 'kdeconnect.contacts.response_uids_timestamps') {
            const body = packet.body || {};
            const uids = Array.isArray(body.uids) ? body.uids : [];
            if (uids.length > 0) {
                console.log(`[ContactsPlugin] Received ${uids.length} contact uids from ${device.info.name}, requesting vCards...`);
                this.requestVCards(device, uids);
            }
            return;
        }

        // Step 2 response: body has { uids: [...], "<uid>": "<vCard text>", ... }
        if (packet.type === 'kdeconnect.contacts.response_vcards') {
            const body = packet.body || {};
            const uids = Array.isArray(body.uids) ? body.uids : [];
            let parsedCount = 0;

            uids.forEach((uid) => {
                const vcard = body[String(uid)];
                if (typeof vcard !== 'string' || vcard.length === 0) return;

                const contact = this.parseVCard(vcard);
                this.contactsMap.set(String(uid), {
                    id: String(uid),
                    name: contact.name,
                    number: contact.numbers[0] || '',
                    numbers: contact.numbers,
                    avatar: null
                });
                parsedCount++;
            });

            if (parsedCount > 0) {
                console.log(`[ContactsPlugin] Parsed ${parsedCount} contact vCards from ${device.info.name}`);
                if (this.emitter) {
                    this.emitter.emit('contactsUpdated', this.getContactsList());
                }
            }
            return;
        }

        // Legacy fallback: some old Android builds answer with kdeconnect.contacts.response
        // carrying a flat contacts list.
        if (packet.type === 'kdeconnect.contacts' || packet.type === 'kdeconnect.contacts.response') {
            const body = packet.body || {};
            const rawList = body.contacts || body.uids || body.response || body.list || (Array.isArray(body) ? body : []);

            if (rawList.length > 0) {
                console.log(`[ContactsPlugin] Processing ${rawList.length} contact entries from ${device.info.name}`);

                rawList.forEach((c) => {
                    if (typeof c === 'string') {
                        const uid = c;
                        if (!this.contactsMap.has(uid)) {
                            this.contactsMap.set(uid, { id: uid, name: uid, number: '', numbers: [], avatar: null });
                        }
                        return;
                    }

                    const name = c.name || c.displayName || c.formattedName || 'Unknown Contact';
                    let numbers = [];

                    if (Array.isArray(c.phoneNumbers)) {
                        numbers = c.phoneNumbers.map((n) => (typeof n === 'string' ? n : (n.number || n.value || '')));
                    } else if (Array.isArray(c.numbers)) {
                        numbers = c.numbers.map((n) => (typeof n === 'string' ? n : (n.number || n.value || '')));
                    } else if (c.number) {
                        numbers = [c.number];
                    }

                    const primaryNumber = numbers[0] || c.number || '';
                    const uid = String(c.uid || c.id || primaryNumber || name);

                    this.contactsMap.set(uid, {
                        id: uid,
                        name: name,
                        number: primaryNumber,
                        numbers: numbers.filter(Boolean),
                        avatar: c.avatar || null
                    });
                });

                if (this.emitter) {
                    this.emitter.emit('contactsUpdated', this.getContactsList());
                }
            }
        }
    }

    requestAllContacts(device) {
        if (!device) return false;

        console.log(`[ContactsPlugin] Requesting contact uid list from ${device.info.name}`);

        // Modern KDE Connect protocol, step 1: ask the device for the list of contact uids.
        // The phone replies with kdeconnect.contacts.response_uids_timestamps, which this
        // plugin follows up with a vCard request. ("requestAll" style packets are not handled
        // by current kdeconnect-android builds.)
        return device.sendPacket({
            id: Date.now(),
            type: 'kdeconnect.contacts.request_all_uids_timestamps',
            body: {}
        });
    }

    requestVCards(device, uids) {
        if (!device || !uids || uids.length === 0) return false;

        console.log(`[ContactsPlugin] Requesting vCards for ${uids.length} contacts from ${device.info.name}`);

        // Send the uid list in chunks so a very large contact book does not produce one
        // oversized response packet.
        for (let i = 0; i < uids.length; i += VCARDS_REQUEST_CHUNK_SIZE) {
            const chunk = uids.slice(i, i + VCARDS_REQUEST_CHUNK_SIZE);
            device.sendPacket({
                id: Date.now() + i,
                type: 'kdeconnect.contacts.request_vcards_by_uid',
                body: { uids: chunk }
            });
        }
        return true;
    }

    parseVCard(vcard) {
        const lines = vcard.split(/\r?\n/);
        let name = 'Unknown Contact';
        const numbers = [];

        for (const line of lines) {
            if (line.startsWith('FN:')) {
                name = line.substring(3).trim();
            } else if (line.indexOf('TEL') === 0) {
                const colonIndex = line.indexOf(':');
                if (colonIndex !== -1) {
                    const num = line.substring(colonIndex + 1).trim();
                    if (num) numbers.push(num);
                }
            }
        }

        return { name, numbers };
    }

    resolveContactName(phoneNumber) {
        if (!phoneNumber) return 'Unknown Caller';
        const cleanQuery = phoneNumber.replace(/\D/g, '');

        for (const contact of this.contactsMap.values()) {
            for (const num of contact.numbers) {
                const cleanNum = num.replace(/\D/g, '');
                if (cleanNum && (cleanNum.endsWith(cleanQuery) || cleanQuery.endsWith(cleanNum))) {
                    return contact.name;
                }
            }
        }
        return phoneNumber;
    }

    getContactsList() {
        const list = Array.from(this.contactsMap.values());
        list.sort((a, b) => a.name.localeCompare(b.name));
        return list;
    }
}

module.exports = ContactsPlugin;
