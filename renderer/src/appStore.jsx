import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import useCalls from './hooks/useCalls';
import useMedia from './hooks/useMedia';

const AppContext = createContext(null);

export const NAV_KEYS = [
    'home',
    'activity',
    'notifications',
    'messages',
    'calls',
    'contacts',
    'photos',
    'files',
    'clipboard',
    'apps',
    'media',
    'camera',
    'screen',
    'ai',
    'settings'
];

export function AppProvider({ children }) {
    const [route, setRoute] = useState('home');
    const [theme, setTheme] = useState('dark');
    const [systemDark, setSystemDark] = useState(false);

    const [deviceState, setDeviceState] = useState({
        name: 'No Device Connected',
        connected: false,
        battery: 0,
        isCharging: false,
        signal: 0,
        networkType: 'Offline',
        wifi: false,
        bluetooth: false
    });
    const [connection, setConnection] = useState('disconnected');
    const [notifications, setNotifications] = useState([]);
    const [toasts, setToasts] = useState([]);

    const calls = useCalls();
    const media = useMedia();

    const registered = useRef(false);
    const reconnectTimer = useRef(null);

    const applyDeviceStatus = useCallback((patch) => {
        setDeviceState((prev) => {
            const next = { ...prev, ...patch };
            if (next.connected) {
                setConnection('connected');
            } else {
                setConnection((c) => (c === 'connecting' ? c : 'disconnected'));
            }
            return next;
        });
    }, []);

    // Device status + notification IPC wiring (StrictMode-safe)
    useEffect(() => {
        if (registered.current) return;
        registered.current = true;

        if (!window.api) return;

        if (window.api.onDeviceStatusChanged) {
            window.api.onDeviceStatusChanged((newStatus) => applyDeviceStatus(newStatus));
        }

        if (typeof window.api.invoke === 'function') {
            const res = window.api.invoke('get-notifications');
            if (res && typeof res.then === 'function') {
                res.then((list) => {
                    if (Array.isArray(list)) setNotifications(list);
                }).catch((err) => console.error(err));
            }
        }
        if (window.api.onNotificationReceived) {
            window.api.onNotificationReceived((newNotif) => {
                setNotifications((prev) => [newNotif, ...prev.filter((n) => n.id !== newNotif.id)]);
            });
        }
        if (window.api.onNotificationDismissed) {
            window.api.onNotificationDismissed(({ id }) => {
                setNotifications((prev) => prev.filter((n) => n.id !== id));
            });
        }
        if (window.api.onSystemWarning) {
            window.api.onSystemWarning((w) => {
                toast({ title: w && w.code ? String(w.code).replace(/_/g, ' ') : 'Warning', description: w && w.message ? w.message : '' });
            });
        }
    }, [applyDeviceStatus]);

    // Theme resolution
    useEffect(() => {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        setSystemDark(mq.matches);
        const on = (e) => setSystemDark(e.matches);
        mq.addEventListener('change', on);
        return () => mq.removeEventListener('change', on);
    }, []);

    const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

    useEffect(() => {
        document.documentElement.classList.toggle('dark', resolvedTheme === 'dark');
    }, [resolvedTheme]);

    // Cleanup reconnect fallback timer
    useEffect(() => {
        return () => {
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        };
    }, []);

    const toast = useCallback((t) => {
        const id = `t-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        setToasts((list) => [...list, { ...t, id }].slice(-4));
        setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 5200);
    }, []);

    const dismissToast = useCallback((id) => {
        setToasts((list) => list.filter((x) => x.id !== id));
    }, []);

    const reconnect = useCallback(() => {
        if (connection === 'connecting') return;
        setConnection('connecting');
        if (window.api && window.api.send) window.api.send('phone-link:connect', {});
        if (window.api && typeof window.api.invoke === 'function') {
            window.api.invoke('get-discovered-devices').catch(() => {});
        }
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(() => {
            setConnection((c) => {
                if (c === 'connecting') return 'disconnected';
                return c;
            });
        }, 8000);
        toast({ title: 'Connecting', description: 'Negotiating a secure channel with your phone…' });
    }, [connection, toast]);

    const disconnect = useCallback(() => {
        if (window.api && window.api.send) window.api.send('phone-link:disconnect');
        setConnection('disconnected');
        toast({ title: 'Device disconnected' });
    }, [toast]);

    const deviceName = deviceState.connected && deviceState.name ? deviceState.name : 'No Device Connected';
    const battery = deviceState.battery || 0;

    // Notification actions
    const refreshNotifications = useCallback(() => {
        if (window.api && typeof window.api.invoke === 'function') {
            window.api.invoke('get-notifications')
                .then((list) => {
                    if (Array.isArray(list)) setNotifications(list);
                })
                .catch(() => {});
        }
    }, []);

    const dismissNotification = useCallback((id) => {
        if (window.api && window.api.send) window.api.send('dismiss-notification', { id });
        setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, []);

    const clearAllNotifications = useCallback(() => {
        if (window.api && window.api.send) window.api.send('clear-all-notifications');
        setNotifications([]);
    }, []);

    const replyToNotification = useCallback((requestReplyId, text) => {
        if (!text || !text.trim()) return;
        if (window.api && window.api.send) window.api.send('send-reply', { requestReplyId, text: text.trim() });
    }, []);

    const simulateCall = useCallback(() => {
        if (window.api && window.api.send) window.api.send('simulate-call');
    }, []);

    const value = useMemo(
        () => ({
            route,
            setRoute,
            theme,
            setTheme,
            resolvedTheme,
            deviceState,
            connection,
            setConnection,
            reconnect,
            disconnect,
            deviceName,
            battery,
            isCharging: deviceState.isCharging,
            toasts,
            toast,
            dismissToast,
            notifications,
            refreshNotifications,
            dismissNotification,
            clearAllNotifications,
            replyToNotification,
            simulateCall,
            call: calls.call,
            callHistory: calls.history,
            callDurationSecs: calls.durationSecs,
            answerCall: calls.answer,
            declineCall: calls.decline,
            endCall: calls.hangup,
            toggleMute: calls.toggleMute,
            toggleAudioTarget: calls.toggleAudioTarget,
            muteRinger: calls.muteRinger,
            startCall: calls.dial,
            removeHistory: calls.removeHistory,
            clearCallHistory: calls.clearHistory,
            incomingCall: calls.call && calls.call.status === 'RINGING',
            activeCall: calls.call && calls.call.status === 'ACTIVE' ? calls.call : null,
            ...media
        }),
        [
            route,
            theme,
            resolvedTheme,
            deviceState,
            connection,
            reconnect,
            disconnect,
            deviceName,
            battery,
            toasts,
            toast,
            dismissToast,
            notifications,
            refreshNotifications,
            dismissNotification,
            clearAllNotifications,
            replyToNotification,
            simulateCall,
            calls.call,
            calls.history,
            calls.durationSecs,
            calls.answer,
            calls.decline,
            calls.hangup,
            calls.toggleMute,
            calls.toggleAudioTarget,
            calls.muteRinger,
            calls.dial,
            calls.removeHistory,
            calls.clearHistory,
            media
        ]
    );

    return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
    const ctx = useContext(AppContext);
    if (!ctx) throw new Error('useApp must be used inside AppProvider');
    return ctx;
}
