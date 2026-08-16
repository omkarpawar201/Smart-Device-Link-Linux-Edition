const BasePlugin = require('./BasePlugin');
const path = require('path');

// Split a phone-style combined string "Artist - Title" on the FIRST separator, so a title
// like "Sweet Child O' Mine - Remastered" still keeps "Remastered" as part of the title.
function parseNowPlaying(np) {
    if (!np) return { title: '', artist: '' };
    const idx = np.indexOf(' - ');
    if (idx > 0) {
        return {
            artist: np.slice(0, idx).trim(),
            title: np.slice(idx + 3).trim()
        };
    }
    return { title: np.trim(), artist: '' };
}

class MprisPlugin extends BasePlugin {
    constructor(eventEmitter) {
        super('MprisPlugin');
        this.emitter = eventEmitter;
        this.mediaState = {
            player: '',
            title: '',
            artist: '',
            album: '',
            albumArt: '',
            albumArtUrl: '',
            isPlaying: false,
            volume: 50,
            canPlay: true,
            canPause: true,
            canGoNext: true,
            canGoPrevious: true,
            canSeek: false,
            pos: 0,
            length: 0,
            available: false,
            updatedAt: null
        };
        this.playerList = [];
        this.lastRequestedAlbumArtUrl = '';
        this.albumArtForUrl = '';
        this.pcMediaState = {
            player: 'This PC',
            title: '',
            artist: '',
            album: '',
            isPlaying: false,
            volume: 50,
            pos: 0,
            length: 0,
            available: false
        };
    }

    getCapabilities() {
        return ['kdeconnect.mpris', 'kdeconnect.mpris.request'];
    }

    guessMime(url, buf) {
        if (url) {
            const ext = path.extname(url).toLowerCase();
            if (ext === '.png') return 'image/png';
            if (ext === '.webp') return 'image/webp';
            if (ext === '.gif') return 'image/gif';
            if (ext === '.bmp') return 'image/bmp';
        }
        if (buf && buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
        if (buf && buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
        if (buf && buf.length > 3 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp';
        return 'image/jpeg';
    }

    payloadToDataUrl(buf, url) {
        return `data:${this.guessMime(url, buf)};base64,${buf.toString('base64')}`;
    }

    handlePacket(device, packet, payload) {
        if (packet.type === 'kdeconnect.mpris') {
            const body = packet.body || {};

            // Player list response (from a requestPlayerList request).
            if (Array.isArray(body.playerList)) {
                this.playerList = body.playerList;
                const target = this.playerList.includes(this.mediaState.player)
                    ? this.mediaState.player
                    : this.playerList[0] || '';
                if (target) {
                    this.sendRequest(device, { player: target, requestNowPlaying: true, requestVolume: true });
                }
                return;
            }

            // The phone only transfers album art after we ask for it: it replies with a
            // binary payload attached to a packet flagged `transferringAlbumArt: true`.
            if (body.transferringAlbumArt) {
                if (payload && payload.length > 0) {
                    this.mediaState = {
                        ...this.mediaState,
                        albumArt: this.payloadToDataUrl(payload, body.albumArtUrl),
                        albumArtUrl: body.albumArtUrl || this.mediaState.albumArtUrl,
                        updatedAt: Date.now()
                    };
                    this.albumArtForUrl = body.albumArtUrl || this.lastRequestedAlbumArtUrl;
                    this.emitState(device);
                } else {
                    // Transfer failed; allow a future metadata packet to retry.
                    this.lastRequestedAlbumArtUrl = '';
                }
                return;
            }

            const hasNowPlaying = Object.prototype.hasOwnProperty.call(body, 'nowPlaying');
            const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title');

            // Album art arrives as a binary payload, as an http(s) URL the renderer can
            // load directly, or as a kdeconnect:// URL that must be requested as a payload.
            // `albumArtForUrl` tracks which URL our current art belongs to so we know when a
            // new song's art must be (re)requested even though old art is still cached.
            let albumArt = this.mediaState.albumArt || '';
            let albumArtUrl = this.mediaState.albumArtUrl || '';
            if (payload && payload.length > 0) {
                albumArt = this.payloadToDataUrl(payload, body.albumArtUrl);
                this.albumArtForUrl = body.albumArtUrl || this.albumArtForUrl;
            } else if (body.albumArtUrl && /^https?:\/\//i.test(body.albumArtUrl)) {
                albumArt = body.albumArtUrl;
                this.albumArtForUrl = body.albumArtUrl;
            }
            if (body.albumArtUrl) albumArtUrl = body.albumArtUrl;

            // The phone formats nowPlaying as "Artist - Title". Prefer the separate title/artist
            // fields when the phone sends them, otherwise split the combined string so the title
            // shows only the song name (artist is rendered on its own line below).
            let title = this.mediaState.title;
            let artist = this.mediaState.artist;
            if (hasTitle && typeof body.title === 'string' && body.title) {
                title = body.title;
            } else if (hasNowPlaying && body.nowPlaying) {
                const parsed = parseNowPlaying(body.nowPlaying);
                title = parsed.title || body.nowPlaying;
            } else if (hasNowPlaying) {
                title = body.nowPlaying || '';
            }
            if (Object.prototype.hasOwnProperty.call(body, 'artist') && typeof body.artist === 'string') {
                artist = body.artist;
            } else if (hasNowPlaying && body.nowPlaying) {
                const parsed = parseNowPlaying(body.nowPlaying);
                if (parsed.artist) artist = parsed.artist;
            }

            this.mediaState = {
                player: body.player || this.mediaState.player,
                title,
                artist,
                album: Object.prototype.hasOwnProperty.call(body, 'album') ? (body.album || '') : this.mediaState.album,
                albumArt,
                albumArtUrl,
                isPlaying: typeof body.isPlaying === 'boolean' ? body.isPlaying : this.mediaState.isPlaying,
                volume: typeof body.volume === 'number' ? body.volume : this.mediaState.volume,
                canPlay: typeof body.canPlay === 'boolean' ? body.canPlay : this.mediaState.canPlay,
                canPause: typeof body.canPause === 'boolean' ? body.canPause : this.mediaState.canPause,
                canGoNext: typeof body.canGoNext === 'boolean' ? body.canGoNext : this.mediaState.canGoNext,
                canGoPrevious: typeof body.canGoPrevious === 'boolean' ? body.canGoPrevious : this.mediaState.canGoPrevious,
                canSeek: typeof body.canSeek === 'boolean' ? body.canSeek : this.mediaState.canSeek,
                pos: typeof body.pos === 'number' ? Math.floor(body.pos / 1000) : this.mediaState.pos,
                length: typeof body.length === 'number' ? Math.floor(body.length / 1000) : this.mediaState.length,
                available: !!(title || artist),
                updatedAt: Date.now()
            };

            // A non-http(s) art URL (e.g. kdeconnect://artUri/...) means the image must be
            // pulled over as a payload. Ask the phone for it when we don't already have art
            // for THIS url (first song) or when the url changed (new song).
            if (albumArtUrl && !/^https?:\/\//i.test(albumArtUrl) && this.mediaState.player &&
                albumArtUrl !== this.albumArtForUrl &&
                albumArtUrl !== this.lastRequestedAlbumArtUrl) {
                this.lastRequestedAlbumArtUrl = albumArtUrl;
                this.sendRequest(device, { player: this.mediaState.player, albumArtUrl });
            }

            if (this.mediaState.title || this.mediaState.artist) {
                console.log(`[MprisPlugin] ${device.info.name} Media: "${this.mediaState.title}" by ${this.mediaState.artist} [${this.mediaState.isPlaying ? 'PLAYING' : 'PAUSED'}]`);
            }

            this.emitState(device);
        } else if (packet.type === 'kdeconnect.mpris.request') {
            const body = packet.body || {};

            // The phone wants our player list so it can show/control the PC player.
            if (body.requestPlayerList) {
                this.sendPcPlayerList(device);
            }

            // requestNowPlaying / requestVolume / requestPlayerStatus target our player: answer
            // with current state. requestPlayerStatus is the legacy KDE Connect field the Android
            // app still sends when it (re)opens media controls.
            const isOurPlayer = !body.player || body.player === this.pcMediaState.player;
            if (isOurPlayer && (body.requestNowPlaying || body.requestVolume || body.requestPlayerStatus)) {
                this.broadcastPcState(device);
            }

            // The phone is asking to control PC playback (action / setVolume / seek).
            console.log(`[MprisPlugin] ${device.info.name} -> PC request:`, JSON.stringify(body));
            if (this.emitter) {
                this.emitter.emit('pcMediaRequest', {
                    deviceId: device.info.id,
                    body
                });
            }
        }
    }

    emitState(device) {
        if (this.emitter) {
            this.emitter.emit('mediaStateChanged', {
                deviceId: device.info.id,
                ...this.mediaState
            });
        }
    }

    sendRequest(device, body) {
        if (!device || !body) return false;
        return device.sendPacket({
            id: Date.now(),
            type: 'kdeconnect.mpris.request',
            body
        });
    }

    sendAction(device, action) {
        if (!device || !action) return false;

        // Valid actions: "Play", "Pause", "PlayPause", "Next", "Previous", "Stop"
        const body = { action };
        if (this.mediaState.player) body.player = this.mediaState.player;
        console.log(`[MprisPlugin] Sending action "${action}"${body.player ? ` to player "${body.player}"` : ''} on ${device.info.name}`);
        return this.sendRequest(device, body);
    }

    setVolume(device, volume) {
        if (!device) return false;
        const body = { setVolume: Math.min(100, Math.max(0, volume)) };
        if (this.mediaState.player) body.player = this.mediaState.player;
        return this.sendRequest(device, body);
    }

    // Ask the phone to seek its player. Android's MprisReceiverPlugin only honors an
    // absolute `SetPosition` (ms); the legacy `setPos` and relative `seek` fields are
    // ignored, which is why the phone's seek bar snapped back to the old position.
    sendSeek(device, body) {
        if (!device || !body) return false;
        const req = {};
        if (typeof body.SetPosition === 'number') {
            req.SetPosition = Math.round(body.SetPosition);
        } else if (typeof body.setPos === 'number') {
            req.SetPosition = Math.round(body.setPos);
        } else if (typeof body.seek === 'number') {
            // Relative seeks are unsupported by the Android receiver; fall back to an
            // absolute SetPosition derived from the current position.
            req.SetPosition = Math.round((this.mediaState.pos + body.seek / 1000) * 1000);
        }
        if (this.mediaState.player) req.player = this.mediaState.player;
        return this.sendRequest(device, req);
    }

    // Ask the phone for its players + current now-playing state. Uses the modern
    // KDE Connect request fields (requestPlayerList / requestNowPlaying / requestVolume).
    requestMediaState(device) {
        if (!device) return;
        this.sendRequest(device, { requestPlayerList: true });
        this.sendRequest(device, {
            requestNowPlaying: true,
            requestVolume: true,
            ...(this.mediaState.player ? { player: this.mediaState.player } : {})
        });
    }

    // Re-request just the current player's state. The phone doesn't always push volume
    // changes on its own (Apple Music doesn't report PlaybackInfo changes), so the bridge
    // calls this periodically to keep the PC's volume bar in sync.
    refreshCurrentPlayer(device) {
        if (!device || !this.mediaState.player) return;
        this.sendRequest(device, { player: this.mediaState.player, requestNowPlaying: true, requestVolume: true });
    }

    // Advertise our PC player so the phone can discover and control it.
    sendPcPlayerList(device) {
        if (!device) return;
        device.sendPacket({
            id: Date.now(),
            type: 'kdeconnect.mpris',
            body: {
                playerList: [this.pcMediaState.player],
                supportAlbumArtPayload: false
            }
        });
        // Follow up with an immediate status packet so the player shows up on the phone with
        // controls/state right away instead of waiting for its own requestPlayerStatus round-trip.
        this.broadcastPcState(device);
    }

    // Broadcast the PC's media session to the phone (pos/length in ms per protocol).
    broadcastPcState(device, state) {
        if (!device) return;
        if (state) this.pcMediaState = { ...this.pcMediaState, ...state };
        const s = this.pcMediaState;
        const packet = {
            id: Date.now(),
            type: 'kdeconnect.mpris',
            body: {
                player: s.player || 'This PC',
                nowPlaying: s.title || '',
                artist: s.artist || '',
                album: s.album || '',
                isPlaying: !!s.isPlaying,
                volume: typeof s.volume === 'number' ? s.volume : 50,
                canPlay: true,
                canPause: true,
                canGoNext: true,
                canGoPrevious: true,
                canSeek: true,
                supportAlbumArtPayload: false,
                pos: Math.floor((s.pos || 0) * 1000),
                length: Math.floor((s.length || 0) * 1000)
            }
        };
        device.sendPacket(packet);
    }
}

module.exports = MprisPlugin;
