import { useState, useEffect, useCallback } from 'react';

const EMPTY_PHONE = { available: false };
const PC_MEDIA_CACHE = {
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

export default function useMedia() {
    const [phoneMedia, setPhoneMedia] = useState(EMPTY_PHONE);
    const [pcMedia, setPcMedia] = useState(() => ({ ...PC_MEDIA_CACHE }));

    const applyPcMedia = useCallback((updater) => {
        setPcMedia((prev) => {
            const patch = typeof updater === 'function' ? updater(prev) : updater;
            const merged = { ...prev, ...patch };
            Object.assign(PC_MEDIA_CACHE, merged);
            return merged;
        });
    }, []);

    const sendPcCommand = useCallback((command) => {
        if (window.api && window.api.send) window.api.send('pc-media-command', command);
    }, []);

    const handlePcRequest = useCallback(
        (body) => {
            const { action, setVolume, seek, setPos, SetPosition, Seek } = body;
            if (typeof setVolume === 'number') {
                applyPcMedia({ volume: Math.max(0, Math.min(100, setVolume)) });
            } else if (action === 'Play') {
                applyPcMedia({ isPlaying: true });
            } else if (action === 'Pause' || action === 'Stop') {
                applyPcMedia({ isPlaying: false });
            } else if (action === 'PlayPause') {
                applyPcMedia((prev) => ({ isPlaying: !prev.isPlaying }));
            } else if (action === 'Next' || action === 'Previous') {
                console.log(`[Media] PC session received "${action}"`);
            } else if (typeof SetPosition === 'number') {
                applyPcMedia({ pos: Math.max(0, SetPosition / 1000) });
                sendPcCommand({ setPos: SetPosition });
            } else if (typeof Seek === 'number') {
                applyPcMedia((prev) => ({ pos: Math.max(0, (prev.pos || 0) + Seek / 1e6) }));
                sendPcCommand({ seek: Math.round(Seek / 1000) });
            } else if (action === 'Seek' && typeof seek === 'number') {
                applyPcMedia((prev) => ({ pos: Math.max(0, (prev.pos || 0) + seek / 1000) }));
                sendPcCommand({ seek });
            } else if (action === 'SetPos' && typeof setPos === 'number') {
                applyPcMedia({ pos: Math.max(0, setPos / 1000) });
                sendPcCommand({ setPos });
            }
        },
        [applyPcMedia, sendPcCommand]
    );

    const onPcAction = useCallback(
        (action) => {
            handlePcRequest({ action });
            sendPcCommand({ action });
        },
        [handlePcRequest, sendPcCommand]
    );

    const onPcVolume = useCallback(
        (volume) => {
            applyPcMedia({ volume: Math.max(0, Math.min(100, volume)) });
            sendPcCommand({ setVolume: Math.max(0, Math.min(100, volume)) });
        },
        [applyPcMedia, sendPcCommand]
    );

    const onPcSeek = useCallback(
        (posSecs) => {
            applyPcMedia({ pos: Math.max(0, posSecs) });
            sendPcCommand({ setPos: Math.round(posSecs * 1000) });
        },
        [applyPcMedia, sendPcCommand]
    );

    const syncPhone = useCallback(() => {
        if (window.api && window.api.send) window.api.send('media-control', { action: 'GetState' });
    }, []);

    useEffect(() => {
        if (window.api && window.api.send) {
            window.api.send('media-control', { action: 'GetState' });
        }
    }, []);

    useEffect(() => {
        if (window.api && window.api.onMediaStateChanged) {
            window.api.onMediaStateChanged((m) => setPhoneMedia((prev) => ({ ...prev, ...m })));
        }
        if (window.api && window.api.onPcMediaRequest) {
            window.api.onPcMediaRequest(({ body }) => handlePcRequest(body));
        }
        if (window.api && window.api.onPcMediaState) {
            window.api.onPcMediaState((state) => {
                if (typeof state.volume === 'number') state.volume = Math.max(0, Math.min(100, state.volume));
                applyPcMedia(state);
            });
        }
    }, [handlePcRequest, applyPcMedia]);

    useEffect(() => {
        const timer = setInterval(() => {
            setPhoneMedia((prev) => {
                if (!prev.isPlaying || !prev.length) return prev;
                return { ...prev, pos: (prev.pos || 0) + 1 };
            });
        }, 1000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        const timer = setInterval(() => {
            setPcMedia((prev) => {
                if (!prev.isPlaying || !prev.length) return prev;
                return { ...prev, pos: (prev.pos || 0) + 1 };
            });
        }, 1000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (window.api && window.api.send) {
            window.api.send('pc-media-state-changed', {
                player: pcMedia.player,
                title: pcMedia.title,
                artist: pcMedia.artist,
                album: pcMedia.album,
                isPlaying: pcMedia.isPlaying,
                volume: pcMedia.volume,
                pos: pcMedia.pos,
                length: pcMedia.length,
                available: !!(pcMedia.title || pcMedia.artist)
            });
        }
    }, [pcMedia]);

    const handlePhoneAction = useCallback((action) => {
        if (action === 'Play') setPhoneMedia((prev) => ({ ...prev, isPlaying: true }));
        else if (action === 'Pause') setPhoneMedia((prev) => ({ ...prev, isPlaying: false }));
        else if (action === 'PlayPause') setPhoneMedia((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
        if (window.api && window.api.send) window.api.send('media-control', { action });
        setTimeout(() => window.api && window.api.send && window.api.send('media-control', { action: 'GetState' }), 400);
    }, []);

    const handlePhoneVolume = useCallback((newVol) => {
        setPhoneMedia((prev) => ({ ...prev, volume: newVol }));
        if (window.api && window.api.send) window.api.send('media-control', { action: 'setVolume', volume: newVol });
    }, []);

    const handlePhoneSeek = useCallback((posSecs) => {
        setPhoneMedia((prev) => ({ ...prev, pos: posSecs }));
        if (window.api && window.api.send) window.api.send('media-control', { action: 'SetPos', setPos: Math.round(posSecs * 1000) });
    }, []);

    return {
        phoneMedia,
        pcMedia,
        syncPhone,
        phoneAction: handlePhoneAction,
        phoneVolume: handlePhoneVolume,
        phoneSeek: handlePhoneSeek,
        pcAction: onPcAction,
        pcVolume: onPcVolume,
        pcSeek: onPcSeek
    };
}
