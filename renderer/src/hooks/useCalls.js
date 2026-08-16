import { useState, useEffect, useCallback, useRef } from 'react';

const HISTORY_KEY = 'dpl_call_history';

function loadHistory() {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }
}

function persistHistory(history) {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
        // storage unavailable — ignore
    }
}

export default function useCalls() {
    const [call, setCall] = useState(null);
    const [history, setHistory] = useState(loadHistory);
    const [durationSecs, setDurationSecs] = useState(0);
    const callRef = useRef(null);
    callRef.current = call;
    // True while the user initiated an outgoing call from the PC, so a later
    // "talking" packet is not mistaken for an answered incoming call.
    const dialingRef = useRef(false);

    const appendHistory = useCallback((entry) => {
        setHistory((prev) => {
            const next = [entry, ...prev];
            persistHistory(next);
            return next;
        });
    }, []);

    const removeHistory = useCallback((id) => {
        setHistory((prev) => {
            const next = prev.filter((e) => e.id !== id);
            persistHistory(next);
            return next;
        });
    }, []);

    const clearHistory = useCallback(() => {
        setHistory([]);
        persistHistory([]);
    }, []);

    // Duration ticker while a call is active
    useEffect(() => {
        if (!call || call.status !== 'ACTIVE') {
            setDurationSecs(0);
            return undefined;
        }
        const startedAt = call.startedAt || Date.now();
        const tick = () => setDurationSecs(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [call && call.id, call && call.status, call && call.startedAt]);

    const handleIncoming = useCallback((data) => {
        setCall((prev) => {
            // A richer telephony packet may follow the generic one — keep existing
            // caller info only when we already have a real ringing call. A fresh
            // call.ring must replace a call that was (mis)classified as outgoing
            // active, e.g. when the phone only reported "talking" earlier.
            if (prev && prev.status === 'RINGING' && prev.number && prev.number !== 'Unknown Number') return prev;
            dialingRef.current = false;
            const fresh = {
                id: `call_${Date.now()}`,
                type: 'incoming',
                status: 'RINGING',
                name: data.contactName || data.name || 'Unknown Caller',
                number: data.phoneNumber || data.number || 'Unknown Number',
                thumbnail: data.phoneThumbnail || data.thumbnail || null,
                startedAt: null,
                isMuted: false,
                audioTarget: 'PC_SPEAKERS'
            };
            callRef.current = fresh;
            return fresh;
        });
    }, []);

    const handleTalking = useCallback((data) => {
        setCall((prev) => {
            const existing = prev || callRef.current;
            if (existing) {
                // A ringing call becomes active (answered); a call with no ringing is outgoing.
                const type = existing.status === 'RINGING'
                    ? 'incoming'
                    : (existing.type || (dialingRef.current ? 'outgoing' : 'incoming'));
                const active = {
                    ...existing,
                    type,
                    status: 'ACTIVE',
                    startedAt: existing.startedAt || Date.now()
                };
                callRef.current = active;
                return active;
            }
            // No prior call: either we dialed from the PC (outgoing) or the phone
            // reported a call that is already connected without ever ringing the
            // PC (answered incoming) — e.g. MIUI suppressed the ringing packet.
            const isOutgoing = dialingRef.current;
            const fresh = {
                id: `call_${Date.now()}`,
                type: isOutgoing ? 'outgoing' : 'incoming',
                status: 'ACTIVE',
                name: data.contactName || data.phoneNumber || 'Unknown Caller',
                number: data.phoneNumber || data.number || 'Unknown Number',
                thumbnail: data.phoneThumbnail || data.thumbnail || null,
                startedAt: Date.now(),
                isMuted: false,
                audioTarget: 'PC_SPEAKERS'
            };
            callRef.current = fresh;
            return fresh;
        });
    }, []);

    const finalize = useCallback((snapshot) => {
        const prev = snapshot || callRef.current;
        if (prev) {
            const duration = prev.startedAt ? Math.max(0, Math.floor((Date.now() - prev.startedAt) / 1000)) : 0;
            appendHistory({
                id: `h_${Date.now()}`,
                type: prev.type || 'incoming',
                name: prev.name || 'Unknown Caller',
                number: prev.number || 'Unknown Number',
                time: Date.now(),
                durationSecs: prev.status === 'ACTIVE' ? duration : 0
            });
        }
        dialingRef.current = false;
        callRef.current = null;
        setCall(null);
    }, [appendHistory]);

    // A ringing call that ends without being answered is followed by a `missedCall` packet from
    // the phone, so wait for it before finalizing to avoid logging the same call twice.
    const pendingMissedTimer = useRef(null);

    const handleEnded = useCallback(() => {
        const prev = callRef.current;
        if (!prev) return;
        if (prev.status === 'ACTIVE') {
            finalize(prev);
        } else {
            if (pendingMissedTimer.current) clearTimeout(pendingMissedTimer.current);
            const snapshot = prev;
            pendingMissedTimer.current = setTimeout(() => {
                const current = callRef.current;
                if (!current || current.id === snapshot.id) finalize(snapshot);
            }, 3000);
            setCall(null);
        }
    }, [finalize]);

    const handleMissed = useCallback((data) => {
        if (pendingMissedTimer.current) {
            clearTimeout(pendingMissedTimer.current);
            pendingMissedTimer.current = null;
        }
        appendHistory({
            id: `h_${Date.now()}`,
            type: 'missed',
            name: data.contactName || data.phoneNumber || 'Unknown Caller',
            number: data.phoneNumber || 'Unknown Number',
            time: Date.now(),
            durationSecs: 0
        });
        dialingRef.current = false;
        callRef.current = null;
        setCall(null);
    }, [appendHistory]);

    // Clear any pending missed-call fallback timer on unmount
    useEffect(() => {
        return () => {
            if (pendingMissedTimer.current) clearTimeout(pendingMissedTimer.current);
        };
    }, []);

    const answer = useCallback(() => {
        if (window.api && window.api.send) window.api.send('answer-call-audio');
        setCall((prev) => (prev ? { ...prev, status: 'ACTIVE', startedAt: Date.now() } : prev));
    }, []);

    const decline = useCallback(() => {
        if (window.api && window.api.send) window.api.send('hangup-call-audio');
        dialingRef.current = false;
        callRef.current = null;
        setCall(null);
    }, []);

    const hangup = useCallback(() => {
        if (window.api && window.api.send) window.api.send('hangup-call-audio');
        dialingRef.current = false;
        finalize();
    }, [finalize]);

    const toggleMute = useCallback((muted) => {
        if (window.api && window.api.send) window.api.send('toggle-mute-audio', { muted });
        setCall((prev) => (prev ? { ...prev, isMuted: muted } : prev));
    }, []);

    const toggleAudioTarget = useCallback(() => {
        setCall((prev) => {
            if (!prev) return prev;
            const next = prev.audioTarget === 'PC_SPEAKERS' ? 'PHONE_EARPIECE' : 'PC_SPEAKERS';
            if (window.api && window.api.send) window.api.send('transfer-call-audio', { target: next });
            return { ...prev, audioTarget: next };
        });
    }, []);

    const muteRinger = useCallback(() => {
        if (window.api && window.api.send) window.api.send('mute-ringer');
    }, []);

    const dial = useCallback((number) => {
        const clean = (number || '').toString().trim();
        if (!clean) return;
        if (window.api && window.api.send) window.api.send('dial-number', { number: clean });
        dialingRef.current = true;
        const outgoing = {
            id: `call_${Date.now()}`,
            type: 'outgoing',
            status: 'ACTIVE',
            name: clean,
            number: clean,
            thumbnail: null,
            startedAt: Date.now(),
            isMuted: false,
            audioTarget: 'PC_SPEAKERS'
        };
        callRef.current = outgoing;
        setCall(outgoing);
    }, []);

    // Register telephony listeners once (guarded against React StrictMode double-mount)
    const registered = useRef(false);
    useEffect(() => {
        if (registered.current) return;
        registered.current = true;

        if (!window.api) return;
        if (window.api.onIncomingCall) window.api.onIncomingCall(handleIncoming);
        if (window.api.onCallTalking) window.api.onCallTalking(handleTalking);
        if (window.api.onCallEnded) window.api.onCallEnded(handleEnded);
        if (window.api.onMissedCall) window.api.onMissedCall(handleMissed);
    }, [handleIncoming, handleTalking, handleEnded, handleMissed]);

    return {
        call,
        history,
        durationSecs,
        answer,
        decline,
        hangup,
        toggleMute,
        toggleAudioTarget,
        muteRinger,
        dial,
        removeHistory,
        clearHistory
    };
}
