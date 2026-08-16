import React from 'react';
import { Bluetooth, Minus, MoonStar, RefreshCw, Signal, Square, Sun, Wifi, X } from 'lucide-react';
import { Button, StatusBadge } from '../ui-kit';
import { useApp } from '../appStore';

export default function TopBar({ title, subtitle }) {
    const { connection, reconnect, resolvedTheme, setTheme, deviceState, toast } = useApp();

    const onResync = () => {
        reconnect();
        toast({ title: 'Resyncing', description: 'Re-establishing the LinkBridge session…' });
    };

    return (
        <header
            className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border bg-surface px-4"
            style={{ WebkitAppRegion: 'drag' }}
        >
            <div className="min-w-0">
                <h1 className="truncate text-[15px] font-semibold leading-tight tracking-tight">{title}</h1>
                {subtitle && <p className="truncate text-[11.5px] text-muted-foreground">{subtitle}</p>}
            </div>

            <div className="ml-auto flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' }}>
                <div className="hidden items-center gap-3 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-[11.5px] text-muted-foreground lg:flex">
                    <span className={`flex items-center gap-1.5 ${deviceState.wifi ? '' : 'opacity-40'}`}>
                        <Wifi className="h-3.5 w-3.5" /> Wi-Fi
                    </span>
                    <span className={`flex items-center gap-1.5 ${deviceState.signal ? '' : 'opacity-40'}`}>
                        <Signal className="h-3.5 w-3.5" /> {deviceState.signal || '—'}
                    </span>
                    <span className={`flex items-center gap-1.5 ${deviceState.bluetooth ? '' : 'opacity-40'}`}>
                        <Bluetooth className="h-3.5 w-3.5" /> BT
                    </span>
                </div>

                <StatusBadge
                    tone={connection === 'connected' ? 'success' : connection === 'connecting' ? 'warning' : 'danger'}
                >
                    {connection === 'connected' ? 'Bridge active' : connection === 'connecting' ? 'Connecting…' : 'Bridge offline'}
                </StatusBadge>

                <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon-sm" title="Resync device" onClick={onResync}>
                        <RefreshCw className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Toggle theme"
                        onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                    >
                        {resolvedTheme === 'dark' ? <Sun className="h-4 w-4" /> : <MoonStar className="h-4 w-4" />}
                    </Button>
                </div>

                <div className="ml-1 hidden items-center gap-0.5 border-l border-border pl-2 md:flex">
                    <button
                        className="flex h-7 w-9 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
                        aria-label="Minimize"
                        onClick={() => window.api && window.api.minimizeWindow()}
                    >
                        <Minus className="h-3.5 w-3.5" />
                    </button>
                    <button
                        className="flex h-7 w-9 items-center justify-center rounded text-muted-foreground hover:bg-secondary"
                        aria-label="Maximize"
                        onClick={() => window.api && window.api.maximizeWindow()}
                    >
                        <Square className="h-3 w-3" />
                    </button>
                    <button
                        className="flex h-7 w-9 items-center justify-center rounded text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
                        aria-label="Close"
                        onClick={() => window.api && window.api.closeWindow()}
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
        </header>
    );
}
