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
    const [theme, setThemeState] = useState('dark');
    const [accentColor, setAccentColorState] = useState('blue');
    const [autoStart, setAutoStartState] = useState(false);
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

    // Fetch settings on startup
    useEffect(() => {
        if (window.api && window.api.invoke) {
            window.api.invoke('get-settings')
                .then((cfg) => {
                    if (cfg) {
                        if (cfg.theme) setThemeState(cfg.theme);
                        if (cfg.accentColor) setAccentColorState(cfg.accentColor);
                        if (cfg.autoStart !== undefined) setAutoStartState(!!cfg.autoStart);
                    }
                })
                .catch((e) => console.error('[appStore] load settings failed:', e));
        }
    }, []);

    // Theme resolution system listener
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

        const root = document.documentElement;
        const accents = {
            blue: {
                primary: 'oklch(0.55 0.098 205)',
                ring: 'oklch(0.55 0.098 205)',
                accent: 'oklch(0.94 0.018 205)',
                accentForeground: 'oklch(0.36 0.06 205)',
                dark: {
                    primary: 'oklch(0.72 0.1 200)',
                    ring: 'oklch(0.72 0.1 200)',
                    accent: 'oklch(0.32 0.03 205)',
                    accentForeground: 'oklch(0.86 0.06 200)'
                }
            },
            violet: {
                primary: 'oklch(0.55 0.15 290)',
                ring: 'oklch(0.55 0.15 290)',
                accent: 'oklch(0.94 0.03 290)',
                accentForeground: 'oklch(0.36 0.08 290)',
                dark: {
                    primary: 'oklch(0.72 0.15 290)',
                    ring: 'oklch(0.72 0.15 290)',
                    accent: 'oklch(0.32 0.04 290)',
                    accentForeground: 'oklch(0.86 0.08 290)'
                }
            },
            emerald: {
                primary: 'oklch(0.55 0.12 140)',
                ring: 'oklch(0.55 0.12 140)',
                accent: 'oklch(0.94 0.02 140)',
                accentForeground: 'oklch(0.36 0.06 140)',
                dark: {
                    primary: 'oklch(0.72 0.12 140)',
                    ring: 'oklch(0.72 0.12 140)',
                    accent: 'oklch(0.32 0.03 140)',
                    accentForeground: 'oklch(0.86 0.06 140)'
                }
            },
            rose: {
                primary: 'oklch(0.55 0.14 15)',
                ring: 'oklch(0.55 0.14 15)',
                accent: 'oklch(0.94 0.03 15)',
                accentForeground: 'oklch(0.36 0.08 15)',
                dark: {
                    primary: 'oklch(0.72 0.14 15)',
                    ring: 'oklch(0.72 0.14 15)',
                    accent: 'oklch(0.32 0.04 15)',
                    accentForeground: 'oklch(0.86 0.08 15)'
                }
            },
            amber: {
                primary: 'oklch(0.65 0.12 70)',
                ring: 'oklch(0.65 0.12 70)',
                accent: 'oklch(0.94 0.02 70)',
                accentForeground: 'oklch(0.42 0.08 70)',
                dark: {
                    primary: 'oklch(0.75 0.12 70)',
                    ring: 'oklch(0.75 0.12 70)',
                    accent: 'oklch(0.35 0.03 70)',
                    accentForeground: 'oklch(0.88 0.06 70)'
                }
            }
        };

        const activeAccent = accents[accentColor] || accents.blue;
        const colors = resolvedTheme === 'dark' ? activeAccent.dark : activeAccent;

        root.style.setProperty('--primary', colors.primary);
        root.style.setProperty('--ring', colors.ring);
        root.style.setProperty('--accent', colors.accent);
        root.style.setProperty('--accent-foreground', colors.accentForeground);
    }, [resolvedTheme, accentColor]);

    const setTheme = useCallback((val) => {
        setThemeState(val);
        if (window.api && window.api.invoke) {
            window.api.invoke('save-settings', { theme: val }).catch(() => {});
        }
    }, []);

    const setAccentColor = useCallback((val) => {
        setAccentColorState(val);
        if (window.api && window.api.invoke) {
            window.api.invoke('save-settings', { accentColor: val }).catch(() => {});
        }
    }, []);

    const setAutoStart = useCallback((val) => {
        setAutoStartState(val);
        if (window.api && window.api.invoke) {
            window.api.invoke('save-settings', { autoStart: val }).catch(() => {});
        }
    }, []);

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

    const sendNotificationAction = useCallback((requestId, actionKey) => {
        if (window.api && window.api.send) window.api.send('send-notification-action', { requestId, actionKey });
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
            accentColor,
            setAccentColor,
            autoStart,
            setAutoStart,
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
            sendNotificationAction,
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
            micSources: calls.micSources,
            selectedMic: calls.selectedMic,
            micGain: calls.micGain,
            selectMic: calls.selectMic,
            adjustMicGain: calls.adjustMicGain,
            incomingCall: calls.call && calls.call.status === 'RINGING',
            activeCall: calls.call && calls.call.status === 'ACTIVE' ? calls.call : null,
            ...media
        }),
        [
            route,
            theme,
            resolvedTheme,
            accentColor,
            autoStart,
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
            sendNotificationAction,
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
            calls.micSources,
            calls.selectedMic,
            calls.micGain,
            calls.selectMic,
            calls.adjustMicGain,
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
