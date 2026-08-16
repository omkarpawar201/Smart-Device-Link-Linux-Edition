import React from 'react';
import {
    Activity,
    AppWindow,
    BatteryMedium,
    Bell,
    Bot,
    Camera,
    ChevronsUpDown,
    ClipboardList,
    Files,
    Home,
    Images,
    Link2,
    MessageSquare,
    Music4,
    Phone,
    Settings,
    Smartphone,
    Users
} from 'lucide-react';
import { useApp } from '../appStore';
import { cn } from '../lib/utils';
import { StatusBadge } from '../ui-kit';

const groups = [
    {
        label: 'Overview',
        items: [
            { key: 'home', label: 'Home', icon: Home },
            { key: 'activity', label: 'Activity', icon: Activity }
        ]
    },
    {
        label: 'Communication',
        items: [
            { key: 'notifications', label: 'Notifications', icon: Bell },
            { key: 'messages', label: 'Messages', icon: MessageSquare },
            { key: 'calls', label: 'Calls', icon: Phone },
            { key: 'contacts', label: 'Contacts', icon: Users }
        ]
    },
    {
        label: 'Content',
        items: [
            { key: 'photos', label: 'Photos', icon: Images },
            { key: 'files', label: 'Files', icon: Files },
            { key: 'clipboard', label: 'Clipboard', icon: ClipboardList }
        ]
    },
    {
        label: 'Device',
        items: [
            { key: 'apps', label: 'Apps', icon: AppWindow },
            { key: 'media', label: 'Media', icon: Music4 },
            { key: 'camera', label: 'Camera', icon: Camera },
            { key: 'screen', label: 'Phone Screen', icon: Smartphone }
        ]
    },
    {
        label: 'Intelligence',
        items: [{ key: 'ai', label: 'AI Assistant', icon: Bot }]
    },
    {
        label: 'System',
        items: [{ key: 'settings', label: 'Settings', icon: Settings }]
    }
];

export default function Sidebar({ onSwitchDevice }) {
    const { route, setRoute, connection, deviceName, battery, notifications } = useApp();

    return (
        <aside className="flex w-[228px] shrink-0 flex-col border-r border-border bg-rail xl:w-[248px]">
            <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
                <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-primary text-primary-foreground shadow-panel">
                    <Link2 className="h-4 w-4" strokeWidth={2.4} />
                </div>
                <div className="min-w-0">
                    <div className="text-[14px] font-semibold leading-tight tracking-tight">LinkBridge</div>
                    <div className="truncate text-[11px] text-muted-foreground">Your phone. Your workspace.</div>
                </div>
            </div>

            <nav className="lb-scroll flex-1 px-2 pb-2">
                {groups.map((g) => (
                    <div key={g.label} className="mb-1.5">
                        <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
                            {g.label}
                        </div>
                        {g.items.map((item) => {
                            const active = route === item.key;
                            const badge = item.key === 'notifications' ? notifications.length : undefined;
                            return (
                                <button
                                    key={item.key}
                                    onClick={() => setRoute(item.key)}
                                    className={cn(
                                        'lb-focus group relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] transition-colors',
                                        active
                                            ? 'bg-surface font-medium text-foreground shadow-panel'
                                            : 'text-rail-foreground/85 hover:bg-surface/60 hover:text-foreground'
                                    )}
                                >
                                    <span
                                        className={cn(
                                            'absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-all',
                                            active ? 'opacity-100' : 'opacity-0'
                                        )}
                                    />
                                    <item.icon
                                        className={cn('h-4 w-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')}
                                        strokeWidth={active ? 2.2 : 1.9}
                                    />
                                    <span className="truncate">{item.label}</span>
                                    {badge !== undefined && badge > 0 && connection === 'connected' && (
                                        <span
                                            className={cn(
                                                'ml-auto rounded-full px-1.5 py-px text-[10px] font-semibold',
                                                active ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
                                            )}
                                        >
                                            {badge > 99 ? '99+' : badge}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                ))}
            </nav>

            <button
                onClick={onSwitchDevice}
                className="lb-focus m-2 rounded-lg border border-border bg-surface p-2.5 text-left transition-colors hover:border-border-strong"
            >
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Connected device
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex h-8 w-6 items-center justify-center rounded-[5px] border border-border-strong bg-surface-2">
                        <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-medium">{deviceName}</div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                            <StatusBadge
                                tone={connection === 'connected' ? 'success' : connection === 'connecting' ? 'warning' : 'danger'}
                                className="px-1.5 py-0 text-[10px]"
                            >
                                {connection === 'connected' ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Disconnected'}
                            </StatusBadge>
                        </div>
                    </div>
                    <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    <BatteryMedium className="h-3.5 w-3.5" />
                    Battery {battery}%
                    <span className="ml-auto h-1 w-16 overflow-hidden rounded-full bg-secondary">
                        <span className="block h-full rounded-full bg-success" style={{ width: `${battery}%` }} />
                    </span>
                </div>
            </button>
        </aside>
    );
}
