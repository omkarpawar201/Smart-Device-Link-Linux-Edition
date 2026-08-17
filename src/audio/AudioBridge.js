const EventEmitter = require('events');
const { execFile, spawn } = require('child_process');

// HFP call audio on Linux (BlueZ + PipeWire native bluez5 backend).
//
// When a call is active, PipeWire exposes the Bluetooth SCO transport as two
// node "streams" (media.class Audio/Source = phone voice, Audio/Sink = audio
// going to the phone). Routing = pw-link those nodes to the default sink /
// default source. Requires bluetoothd to run WITHOUT its built-in hfp-hf/hfp-ag
// plugins so PipeWire can own the Hands-Free profile (scripts/setup-linux-hfp.sh).

// Both roles are matched because the PC can end up as the Hands-Free unit
// (headset-head-unit profile, role hfp_hf) or as the Audio Gateway
// (audio-gateway profile, role hfp_ag) depending on what the phone advertises
// over SDP. Matching only the HF values silently missed AG-role SCO nodes.
const HFP_ROLE_VALUES = ['hfp_hf', 'hfp-hf', 'hsp_hs', 'hsp-hs', 'hfp_ag', 'hfp-ag', 'hsp_ag', 'hsp-ag'];
const HFP_PROFILE_VALUES = ['hfp-hf', 'hfp_hf', 'hsp-hs', 'hsp_hs', 'hfp-ag', 'hfp_ag', 'hsp-ag', 'hsp_ag'];
const HFP_NAME_MARKERS = ['headset-head-unit', 'headset_hs', 'audio-gateway', '.sco.', 'sco_source', 'sco_sink'];
const NODE_RETRY_MS = 700;
const NODE_WAIT_MS = 12000;
const NODE_BG_RETRY_MS = 3000;

function execLine(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, {
            timeout: opts.timeout || 6000,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true
        }, (e, stdout, stderr) => {
            resolve({ ok: !e, code: e ? e.code : 0, out: stdout || '', err: stderr || '' });
        });
    });
}

class AudioBridge extends EventEmitter {
    constructor() {
        super();
        this.isAudioRoutingActive = false;
        this.isMicMuted = false;
        this.audioOutputTarget = 'PC_SPEAKERS'; // 'PC_SPEAKERS' | 'PHONE_EARPIECE'
        this.phoneMac = null;

        this._linux = process.platform === 'linux';
        this._routingTimer = null;
        this._bgRetry = null;
        this._linkPair = null; // { fromPhone: [out, in], toPhone: [out, in] }
        this._currentCard = null;
        this._lastMicSource = null;
        // Optional explicit PC input (mic) to route to the phone. When null the
        // system default source is used. Set via setMicrophoneSource().
        this.micSource = null;
    }

    setPhoneMac(mac) {
        this.phoneMac = mac || null;
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    _exec(cmd, args, opts) {
        return execLine(cmd, args, opts);
    }

    _wantMac() {
        return this.phoneMac ? String(this.phoneMac).toUpperCase().replace(/[^0-9A-F]/g, '') : '';
    }

    _matchesMac(props) {
        const want = this._wantMac();
        if (!want) return true;
        let got = props['api.bluez5.address'] || '';
        if (!got) {
            const dn = String(props['device.name'] || '');
            const idx = dn.indexOf('bluez_card.');
            got = idx >= 0 ? dn.slice(idx + 'bluez_card.'.length) : dn;
        }
        got = got.toUpperCase().replace(/[^0-9A-F]/g, '');
        if (!got) return true;
        return got.includes(want) || want.includes(got);
    }

    // The SCO loopback nodes embed the address in their name:
    // bluez_input.<addr>.<n> / bluez_output.<addr>.<n> (addr uses '_' separators).
    _macInName(name) {
        const want = this._wantMac();
        if (!want) return true;
        const m = /^bluez_(?:input|output)\.([0-9A-F_]+)\./.exec(String(name || '').toUpperCase());
        if (!m) return false;
        const got = m[1].replace(/[^0-9A-F]/g, '');
        return got.includes(want) || want.includes(got);
    }

    async _pwNodes() {
        const res = await this._exec('pw-dump', [], { timeout: 5000 });
        if (!res.ok) {
            console.warn('[AudioBridge] pw-dump failed:', res.err.trim() || res.out.trim());
            return [];
        }
        try {
            const arr = JSON.parse(res.out);
            return Array.isArray(arr) ? arr.filter((o) => o && o.type === 'PipeWire:Interface:Node') : [];
        } catch (e) {
            console.warn('[AudioBridge] pw-dump parse error:', e.message);
            return [];
        }
    }

    // SCO node codec ids: CVSD=0x01, mSBC=0x02, transport: A2DP=2, SCO=3.
    _isHfpNode(props, name) {
        const role = props['api.bluez5.role'] || '';
        const profile = props['api.bluez5.profile'] || '';
        if (HFP_ROLE_VALUES.includes(role)) return true;
        if (HFP_PROFILE_VALUES.includes(profile)) return true;
        if (HFP_NAME_MARKERS.some((m) => (name || '').includes(m))) return true;
        // Native-backend SCO nodes are named bluez_input.<addr>.<n> /
        // bluez_output.<addr>.<n>, the same scheme A2DP media nodes use. Treat
        // them as HFP unless they are explicitly an A2DP role/profile.
        if (/^bluez_(input|output)\./.test(name || '')) {
            const A2DP = /a2dp|aac|sbc|ldac|aptx|opus/i;
            if (!A2DP.test(role) && !A2DP.test(profile)) return true;
        }
        // Fall back to the transport/codec props (SCO transport, CVSD/mSBC).
        const transport = Number(props['api.bluez5.transport']);
        const codec = Number(props['api.bluez5.codec']);
        if (transport === 3) return true;
        if (codec === 1 || codec === 2) return true;
        return false;
    }

    // Returns { sinkNode, sourceNode } node names for the phone's HFP SCO nodes.
    async _findHfpNodes() {
        const nodes = await this._pwNodes();
        const found = { sinkNode: null, sourceNode: null };
        const sco = [];
        for (const o of nodes) {
            const props = (o.info && o.info.props) || {};
            const name = props['node.name'] || '';
            if (!name.includes('bluez')) continue;
            if (!this._matchesMac(props) && !this._macInName(name)) continue;
            if (!this._isHfpNode(props, name)) continue;
            // The native-backend SCO loopback nodes encode direction in their
            // name: bluez_output.<addr>.<n> = Audio/Sink (PC mic -> phone),
            // bluez_input.<addr>.<n> = Audio/Source (phone voice -> PC).
            // media.class on these loopback nodes may not be exposed as a
            // top-level prop, so rely on the name prefix, not media.class.
            if (!found.sinkNode && /^bluez_output\./.test(name)) {
                found.sinkNode = name;
            } else if (!found.sourceNode && /^bluez_input\./.test(name)) {
                found.sourceNode = name;
            }
            sco.push({ props, params: (o.info && o.info.params) || [] });
        }
        if (sco.length) this._logScoCodec(sco);
        return found;
    }

    // Logs the negotiated SCO codec/sample rate from the node props + params.
    _logScoCodec(scoList) {
        const codecNames = { 1: 'CVSD', 2: 'mSBC' };
        for (const { props, params } of scoList) {
            const codec = Number(props['api.bluez5.codec']);
            const name = props['node.name'] || '?';
            const bits = [];
            if (codec) bits.push(`codec=${codecNames[codec] || codec}`);
            // pw-dump exposes params either as a list of {key,value} or as an
            // object keyed by param name — handle both.
            const entries = Array.isArray(params) ? params : Object.keys(params || {}).map((k) => ({ key: k, value: params[k] }));
            const allRates = new Set();
            for (const prm of entries) {
                if (!/format/i.test(prm.key || '')) continue;
                const val = prm.value;
                const walk = (v) => {
                    if (!v || typeof v !== 'object') return;
                    if (Array.isArray(v)) { v.forEach(walk); return; }
                    if ('rate' in v) {
                        const rates = Array.isArray(v.rate) ? v.rate : [v.rate];
                        rates.forEach((r) => allRates.add(String(r)));
                    }
                    Object.values(v).forEach(walk);
                };
                walk(val);
            }
            if (allRates.size) bits.push(`rate=${[...allRates].join(',')}`);
            console.log(`[AudioBridge] SCO node ${name}${bits.length ? ' (' + bits.join(', ') + ')' : ''}`);
        }
    }

    // Default output/input as node names, never pointing back at the phone.
    async _resolveDefaultNodes() {
        const defSink = (await this._exec('pactl', ['get-default-sink'])).out.trim();
        const defSource = (await this._exec('pactl', ['get-default-source'])).out.trim();
        const isBlue = (n) => n && n.toLowerCase().includes('bluez');

        // Prefer the user-selected PC microphone; fall back to the default source.
        let source = this.micSource || defSource || null;
        if (isBlue(source)) source = null;
        let sink = isBlue(defSink) ? null : defSink || null;

        if (!sink || !source) {
            const nodes = await this._pwNodes();
            for (const o of nodes) {
                const props = (o.info && o.info.props) || {};
                const name = props['node.name'] || '';
                const mc = props['media.class'] || '';
                if (props['device.bus'] === 'bluetooth') continue;
                if (!sink && mc === 'Audio/Sink') sink = name;
                if (!source && mc === 'Audio/Source') source = name;
            }
        }
        return { sink, source };
    }

    async _findBlueCard() {
        if (this._currentCard) return this._currentCard;
        const res = await this._exec('pactl', ['list', 'cards']);
        if (!res.ok) return null;
        const want = this._wantMac();
        const lines = res.out.split('\n');
        let card = null;
        let inCard = false;
        for (const raw of lines) {
            const t = raw.replace(/^\s*/, '');
            if (t.startsWith('Card #')) {
                inCard = false;
                card = null;
                continue;
            }
            const nameM = t.match(/^Name:\s*(bluez_card\.[0-9A-F_]+)$/i);
            if (nameM) {
                inCard = true;
                card = nameM[1];
                continue;
            }
            if (inCard && want && /^Device\.String:\s*/i.test(t)) {
                if (t.toUpperCase().replace(/[^0-9A-F]/g, '').includes(want)) {
                    this._currentCard = card;
                    return card;
                }
            }
        }
        return card; // fallback: first bluez card
    }

    async _setCardProfile(profile) {
        const card = await this._findBlueCard();
        if (!card) {
            console.warn('[AudioBridge] No bluez card found to switch profile');
            return false;
        }
        const res = await this._exec('pactl', ['set-card-profile', card, profile], { timeout: 8000 });
        if (!res.ok) {
            console.warn(`[AudioBridge] set-card-profile ${profile} failed:`, res.err.trim() || res.out.trim());
            return false;
        }
        return true;
    }

    // All profiles available on the bluez card as { name, description }.
    async _cardProfiles() {
        const res = await this._exec('pactl', ['list', 'cards']);
        if (!res.ok) return [];
        const card = await this._findBlueCard();
        if (!card) return [];
        const lines = res.out.split('\n');
        const profiles = [];
        let inCard = false;
        for (const raw of lines) {
            const t = raw.replace(/^\s*/, '');
            if (t.startsWith('Card #')) inCard = false;
            if (t === `Name: ${card}`) {
                inCard = true;
                continue;
            }
            if (!inCard) continue;
            const m = t.match(/^([\w.-]+):\s*(.*)$/);
            if (m && !/^(Name|Driver|Owner|Active Profile|Properties|Part|Port|Flags|Description):/i.test(t)) {
                profiles.push({ name: m[1], description: m[2] || '' });
            }
        }
        return profiles;
    }

    // Picks the best HFP-capable profile that actually exists on the card.
    // Preference order: wideband (mSBC) over narrowband (CVSD), then the
    // Hands-Free role over the Audio Gateway role. The old code hardcoded a
    // fallback of 'headset-head-unit', which does not exist on cards that only
    // expose an 'audio-gateway' profile (silent no-op every call).
    async _findHfpProfile() {
        const profiles = await this._cardProfiles();
        const hfp = profiles.filter((p) => /headset-head-unit|audio-gateway|headset-head-unit-msbc|audio-gateway-msbc/.test(p.name));
        if (!hfp.length) return null;
        const rank = (p) => {
            const wide = /msbc|wideband|headset-head-unit$|headset-head-unit-msbc$|audio-gateway-msbc$/.test(p.name) ? 0 : 1;
            const hf = /headset-head-unit/.test(p.name) ? 0 : 1;
            return wide * 2 + hf;
        };
        hfp.sort((a, b) => rank(a) - rank(b));
        return hfp[0].name;
    }

    // Best-effort: make sure the phone is connected over Bluetooth (HFP
    // authorization auto-accepted by the default-agent).
    async _ensureHfpConnected() {
        const mac = this.phoneMac;
        if (!mac) return;
        const info = await this._exec('bluetoothctl', ['info', mac], { timeout: 8000 });
        if (info.ok && /Connected:\s*yes/i.test(info.out)) return;
        console.log(`[AudioBridge] Connecting Bluetooth HFP to ${mac}...`);
        const child = spawn('bluetoothctl', [], { stdio: ['pipe', 'ignore', 'ignore'] });
        const cmds = ['agent on', 'default-agent', `connect ${mac}`, 'quit'];
        cmds.forEach((c, i) => setTimeout(() => {
            try { child.stdin.write(c + '\n'); } catch (e) { /* closed */ }
        }, 400 + i * 600));
        await new Promise((r) => setTimeout(r, 12000));
        try { child.stdin.end(); } catch (e) { /* ignore */ }
        try { child.kill(); } catch (e) { /* ignore */ }
    }

    async _tryLink() {
        const { sinkNode, sourceNode } = await this._findHfpNodes();
        if (!sinkNode || !sourceNode) {
            return { linked: false, reason: 'HFP nodes not up yet' };
        }
        const { sink, source } = await this._resolveDefaultNodes();
        if (!sink || !source) {
            console.warn('[AudioBridge] No PC output/input node available for routing');
            return { linked: false, reason: 'no default PC audio nodes' };
        }

        // phone voice -> PC speakers, PC mic -> phone. WirePlumber often
        // auto-links these same ports already ("File exists"), which is fine.
        const ok = (r) => r.ok || /File exists/i.test(r.err || '');
        const r1 = await this._exec('pw-link', [sourceNode, sink], { timeout: 5000 });
        const r2 = await this._exec('pw-link', [source, sinkNode], { timeout: 5000 });

        if (ok(r1) && ok(r2)) {
            this._linkPair = { fromPhone: [sourceNode, sink], toPhone: [source, sinkNode] };
            this._lastMicSource = source;
            console.log(`[AudioBridge] Routed: ${sourceNode} -> ${sink} and ${source} -> ${sinkNode}`);
            return { linked: true };
        }
        // Roll back any half-created link.
        await this._exec('pw-link', ['-d', sourceNode, sink], { timeout: 3000 });
        await this._exec('pw-link', ['-d', source, sinkNode], { timeout: 3000 });
        console.warn('[AudioBridge] pw-link failed:', (r1.err || r2.err).trim());
        return { linked: false, reason: (r1.err || r2.err).trim() };
    }

    _unlink() {
        const p = this._linkPair;
        this._linkPair = null;
        if (!p) return;
        this._exec('pw-link', ['-d', ...p.fromPhone], { timeout: 3000 });
        this._exec('pw-link', ['-d', ...p.toPhone], { timeout: 3000 });
    }

    // ------------------------------------------------------------------
    // Public API (same surface the renderer + bridge already use)
    // ------------------------------------------------------------------

    startAudioRouting() {
        this.audioOutputTarget = 'PC_SPEAKERS';

        if (!this._linux) {
            console.log('[AudioBridge] Binding Windows CoreAudio / SCO Call Loopback...');
            this.isAudioRoutingActive = true;
            this.emit('audioRoutingStateChanged', { active: true, target: this.audioOutputTarget });
            return true;
        }

        if (this.isAudioRoutingActive) return true;
        this.isAudioRoutingActive = true;
        this.emit('audioRoutingStateChanged', { active: true, target: this.audioOutputTarget });

        this._route().catch((e) => console.warn('[AudioBridge] routing error:', e.message));
        return true;
    }

    async _route() {
        this._clearTimers();
        if (this._linkPair) this._unlink();

        const profile = await this._findHfpProfile();
        if (profile) {
            await this._setCardProfile(profile);
        } else {
            // Leave the current profile untouched: forcing a hardcoded profile
            // that does not exist on this card silently broke routing setup.
            console.warn('[AudioBridge] No HFP-capable profile found on the bluez card; leaving profile as-is');
        }

        const attempt = async (depth) => {
            if (!this.isAudioRoutingActive) return;
            const res = await this._tryLink();
            if (res.linked) return;
            if (depth < NODE_WAIT_MS / NODE_RETRY_MS) {
                this._routingTimer = setTimeout(() => attempt(depth + 1), NODE_RETRY_MS);
            } else {
                console.warn('[AudioBridge] HFP nodes never appeared; keeping routing armed (background retry)');
                this._bgRetry = setInterval(() => {
                    if (!this.isAudioRoutingActive || this._linkPair) {
                        clearInterval(this._bgRetry);
                        this._bgRetry = null;
                        return;
                    }
                    this._tryLink().catch(() => {});
                }, NODE_BG_RETRY_MS);
            }
        };
        // Kick the phone into HFP quickly without blocking routing.
        this._ensureHfpConnected().catch(() => {});
        await attempt(0);
    }

    stopAudioRouting() {
        const wasActive = this.isAudioRoutingActive;
        this.isAudioRoutingActive = false;
        if (!this._linux) {
            if (wasActive) {
                this.emit('audioRoutingStateChanged', { active: false, target: this.audioOutputTarget });
            }
            return;
        }
        this._clearTimers();
        this._unlink();
        this.emit('audioRoutingStateChanged', { active: false, target: this.audioOutputTarget });
    }

    _clearTimers() {
        if (this._routingTimer) {
            clearTimeout(this._routingTimer);
            this._routingTimer = null;
        }
        if (this._bgRetry) {
            clearInterval(this._bgRetry);
            this._bgRetry = null;
        }
    }

    setMicrophoneMuted(muted) {
        this.isMicMuted = !!muted;
        console.log(`[AudioBridge] PC Microphone Mute set to: ${this.isMicMuted}`);

        if (this._linux) {
            // Mute the exact PC mic we routed to the phone (not the whole default).
            if (this._linkPair && this._linkPair.toPhone && this._linkPair.toPhone[0]) {
                this._lastMicSource = this._linkPair.toPhone[0];
            }
            const mic = this._lastMicSource;
            if (mic) {
                this._exec('pactl', ['set-source-mute', mic, this.isMicMuted ? '1' : '0']).catch(() => {});
            } else {
                this._exec('pactl', ['get-default-source']).then((res) => {
                    const src = res.out.trim();
                    if (src) {
                        this._lastMicSource = src;
                        this._exec('pactl', ['set-source-mute', src, this.isMicMuted ? '1' : '0']).catch(() => {});
                    }
                });
            }
        }

        this.emit('micMuteStateChanged', { muted: this.isMicMuted });
        return this.isMicMuted;
    }

    // Lists real PC microphone inputs (non-monitor, non-Bluetooth) for the UI.
    async listPcMicrophones() {
        if (!this._linux) return [];
        const res = await this._exec('pactl', ['list', 'sources']);
        if (!res.ok) return [];
        const out = [];
        const lines = res.out.split('\n');
        let name = null;
        let desc = null;
        let monitor = false;
        for (const raw of lines) {
            const t = raw.replace(/^\s*/, '');
            const nameM = t.match(/^Name:\s*(\S+)$/);
            const descM = t.match(/^Description:\s*(.+)$/);
            if (nameM) {
                if (name && !monitor && !name.toLowerCase().includes('bluez')) {
                    out.push({ name, description: desc || name });
                }
                name = nameM[1];
                desc = null;
                monitor = name.includes('.monitor');
            } else if (descM) {
                desc = descM[1].trim();
            }
        }
        if (name && !monitor && !name.toLowerCase().includes('bluez')) {
            out.push({ name, description: desc || name });
        }
        return out;
    }

    // The PC input that will be (or is being) routed to the phone.
    async _resolvedMic() {
        if (this.micSource) return this.micSource;
        if (this._lastMicSource) return this._lastMicSource;
        const res = await this._exec('pactl', ['get-default-source']);
        const src = res.out.trim();
        return src && !src.toLowerCase().includes('bluez') ? src : null;
    }

    setMicrophoneSource(name) {
        const next = name ? String(name) : null;
        this.micSource = next;
        this._lastMicSource = next;
        console.log(`[AudioBridge] PC microphone for call routing: ${next || '(default)'}`);
        // If a call is already being routed, immediately re-route to the new mic.
        if (this.isAudioRoutingActive && this._linux) {
            this._route().catch((e) => console.warn('[AudioBridge] re-route error:', e.message));
        }
        return this.micSource;
    }

    getMicrophoneSource() {
        return this.micSource || null;
    }

    async setMicrophoneGain(percent) {
        if (!this._linux) return null;
        const pct = Math.max(0, Math.min(200, Number(percent) || 100));
        const mic = await this._resolvedMic();
        if (!mic) return null;
        this._exec('pactl', ['set-source-volume', mic, `${Math.round(pct)}%`]).catch(() => {});
        console.log(`[AudioBridge] PC microphone gain set to ${Math.round(pct)}% on ${mic}`);
        return pct;
    }

    async getMicrophoneGain() {
        if (!this._linux) return null;
        const mic = await this._resolvedMic();
        if (!mic) return null;
        const res = await this._exec('pactl', ['get-source-volume', mic]);
        const m = res.out.match(/(\d+)%/);
        return m ? parseInt(m[1], 10) : 100;
    }

    transferCallAudioToPhone() {
        console.log('[AudioBridge] Transferring Call Audio from PC -> Phone Earpiece...');
        this.audioOutputTarget = 'PHONE_EARPIECE';
        this.isAudioRoutingActive = false;
        this._clearTimers();
        this._unlink();
        if (this._linux) this._setCardProfile('off').catch(() => {});
        this.emit('audioRoutingStateChanged', { active: false, target: this.audioOutputTarget });
        this.emit('callAudioTransferred', { target: 'PHONE_EARPIECE' });
    }

    transferCallAudioToPc() {
        console.log('[AudioBridge] Transferring Call Audio from Phone -> PC Speakers...');
        this.audioOutputTarget = 'PC_SPEAKERS';
        this.startAudioRouting();
        this.emit('callAudioTransferred', { target: 'PC_SPEAKERS' });
    }
}

module.exports = AudioBridge;
