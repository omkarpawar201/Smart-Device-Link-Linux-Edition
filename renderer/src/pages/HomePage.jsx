import React, { useEffect, useState } from 'react';
import {
    BatteryMedium,
    Bot,
    Camera,
    FileUp,
    MapPin,
    MessageSquarePlus,
    Music2,
    Pause,
    Play,
    Signal,
    SkipBack,
    SkipForward,
    Smartphone,
    Wifi,
    X
} from 'lucide-react';
import { Avatar, Button, Panel, Progress, SectionTitle, StatusBadge } from '../ui-kit';
import { useApp } from '../appStore';
import { timeAgo, formatDuration, cn } from '../lib/utils';

function greeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
}

function NowPlaying() {
    const { phoneMedia, phoneAction, deviceName, toast } = useApp();
    const hasMedia = phoneMedia.available || phoneMedia.title || phoneMedia.artist;
    const length = phoneMedia.length || 0;
    const pos = phoneMedia.pos || 0;
    const progress = length > 0 ? Math.min(100, (pos / length) * 100) : 0;

    if (!hasMedia) {
        return (
            <Panel className="p-3.5">
                <div className="flex items-center gap-3">
                    <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-primary">
                        <Music2 className="h-6 w-6" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-semibold">Nothing playing</div>
                        <div className="mt-0.5 text-[12.5px] text-muted-foreground">Start music on {deviceName} to control it here.</div>
                    </div>
                </div>
                <Button variant="subtle" className="mt-3 w-full justify-center" onClick={() => toast({ title: 'Syncing media state' })}>
                    Sync now
                </Button>
            </Panel>
        );
    }

    return (
        <Panel className="p-3.5">
            <div className="flex gap-3">
                <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-gradient-to-br from-primary/40 to-surface-2">
                    {phoneMedia.albumArt ? (
                        <img src={phoneMedia.albumArt} alt="" className="h-full w-full object-cover" />
                    ) : (
                        <Music2 className="h-6 w-6 text-primary" />
                    )}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{phoneMedia.title || 'Unknown track'}</div>
                    <div className="truncate text-[12.5px] text-muted-foreground">{phoneMedia.artist || 'Unknown artist'}</div>
                    <div className="mt-1">
                        <StatusBadge tone="accent">{phoneMedia.player || 'Phone'} · {deviceName}</StatusBadge>
                    </div>
                </div>
            </div>
            <Progress value={progress} className="mt-3" />
            <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
                <span>{formatDuration(pos)}</span>
                <span>{formatDuration(length)}</span>
            </div>
            <div className="mt-2 flex items-center justify-center gap-2">
                <Button variant="ghost" size="icon" onClick={() => phoneAction('Previous')} aria-label="Previous">
                    <SkipBack className="h-4 w-4" />
                </Button>
                <Button variant="primary" size="icon" onClick={() => phoneAction('PlayPause')} aria-label="Play/pause">
                    {phoneMedia.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </Button>
                <Button variant="ghost" size="icon" onClick={() => phoneAction('Next')} aria-label="Next">
                    <SkipForward className="h-4 w-4" />
                </Button>
            </div>
        </Panel>
    );
}

export default function HomePage() {
    const { setRoute, toast, notifications, dismissNotification, battery, isCharging, deviceState, connection, callHistory, deviceName } = useApp();
    const [photos, setPhotos] = useState([]);

    useEffect(() => {
        let cancelled = false;
        if (window.api && typeof window.api.invoke === 'function') {
            window.api
                .invoke('get-photos')
                .then((list) => {
                    if (!cancelled && Array.isArray(list)) setPhotos(list);
                })
                .catch(() => {});
        }
        return () => {
            cancelled = true;
        };
    }, []);

    const stats = [
        {
            label: 'Battery',
            value: `${battery}%`,
            hint: isCharging ? 'Charging' : 'Not charging',
            icon: BatteryMedium,
            tone: 'success'
        },
        {
            label: 'Network',
            value: deviceState.networkType && deviceState.networkType !== 'Offline' && deviceState.networkType !== 'NA' ? deviceState.networkType : connection === 'connected' ? 'Wi-Fi' : 'Offline',
            hint: deviceState.wifi ? 'Connected · local' : 'Not connected',
            icon: Wifi,
            tone: 'accent'
        },
        {
            label: 'Signal',
            value: deviceState.signal ? String(deviceState.signal) : '—',
            hint: connection === 'connected' ? 'Link active' : 'No link',
            icon: Signal,
            tone: 'success'
        },
        {
            label: 'Device',
            value: connection === 'connected' ? 'Online' : 'Offline',
            hint: deviceState.name || 'No Device Connected',
            icon: Smartphone,
            tone: 'neutral'
        }
    ];

    const quickActions = [
        { label: 'Send file', icon: FileUp, act: () => setRoute('files') },
        { label: 'Phone screen', icon: Smartphone, act: () => setRoute('screen') },
        { label: 'Find phone', icon: MapPin, act: () => { window.api && window.api.send && window.api.send('ring-phone'); toast({ title: 'Ringing device', description: 'Playing an alert at full volume for 30 seconds.' }); } },
        { label: 'Open camera', icon: Camera, act: () => setRoute('camera') },
        { label: 'New message', icon: MessageSquarePlus, act: () => setRoute('messages') },
        { label: 'AI Assistant', icon: Bot, act: () => setRoute('ai') }
    ];

    return (
        <div className="lb-scroll h-full p-5">
            <div className="mx-auto max-w-[1180px] space-y-6">
                <div>
                    <h2 className="text-[22px] font-semibold tracking-tight">{greeting()}</h2>
                    <p className="text-[13px] text-muted-foreground">
                        {connection === 'connected' ? `${deviceName} is connected and ready.` : 'No device connected yet — open Settings to pair a phone.'}
                    </p>
                </div>

                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    {stats.map((s) => (
                        <Panel key={s.label} className="flex items-center gap-3 p-3.5">
                            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface-2 text-primary">
                                <s.icon className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                                <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{s.label}</div>
                                <div className="truncate text-[16px] font-semibold leading-tight">{s.value}</div>
                                <div className="truncate text-[11.5px] text-muted-foreground">{s.hint}</div>
                            </div>
                        </Panel>
                    ))}
                </div>

                <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
                    <section>
                        <SectionTitle
                            title="Recent notifications"
                            action={
                                <Button variant="ghost" size="sm" onClick={() => setRoute('notifications')}>
                                    Open centre
                                </Button>
                            }
                        />
                        <Panel className="divide-y divide-border">
                            {notifications.length === 0 ? (
                                <div className="px-3.5 py-6 text-center text-[12.5px] text-muted-foreground">No active notifications from your phone.</div>
                            ) : (
                                notifications.slice(0, 5).map((n) => (
                                    <div key={n.id} className="group flex items-center gap-3 px-3.5 py-2.5">
                                        <Avatar name={n.appName || n.packageName} size={32} />
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                <span className="text-[12.5px] font-semibold">{n.appName}</span>
                                                <span className="text-[12px] text-muted-foreground">· {n.title}</span>
                                                <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">{timeAgo(n.time)}</span>
                                            </div>
                                            <div className="truncate text-[12.5px] text-muted-foreground">“{n.text}”</div>
                                        </div>
                                        <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                                            {n.requestReplyId && (
                                                <Button size="sm" variant="subtle" onClick={() => setRoute('notifications')}>
                                                    Reply
                                                </Button>
                                            )}
                                            <Button size="sm" variant="ghost" onClick={() => { dismissNotification(n.id); toast({ title: 'Notification dismissed', app: n.appName }); }}>
                                                Dismiss
                                            </Button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </Panel>

                        <SectionTitle
                            className="mt-5"
                            title="Recent photos"
                            action={
                                <Button variant="ghost" size="sm" onClick={() => setRoute('photos')}>
                                    Open gallery
                                </Button>
                            }
                        />
                        <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
                            {(photos.length ? photos : [null, null, null, null, null, null]).slice(0, 6).map((p, i) => (
                                <button
                                    key={p ? p.id : `ph-${i}`}
                                    onClick={() => setRoute('photos')}
                                    className="lb-focus group relative aspect-square overflow-hidden rounded-lg border border-border"
                                >
                                    {p ? (
                                        <img src={p.url} alt={p.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
                                    ) : (
                                        <div className="flex h-full w-full items-center justify-center bg-surface-2 text-muted-foreground">
                                            <Smartphone className="h-4 w-4 opacity-50" />
                                        </div>
                                    )}
                                </button>
                            ))}
                        </div>
                    </section>

                    <section className="space-y-5">
                        <div>
                            <SectionTitle title="Currently playing" />
                            <NowPlaying />
                        </div>

                        <div>
                            <SectionTitle title="Quick actions" />
                            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                                {quickActions.map((a) => (
                                    <button
                                        key={a.label}
                                        onClick={a.act}
                                        className="lb-focus flex flex-col items-start gap-2 rounded-lg border border-border bg-surface p-3 text-left shadow-panel transition-all hover:-translate-y-px hover:border-primary/40"
                                    >
                                        <a.icon className="h-4 w-4 text-primary" />
                                        <span className="text-[12.5px] font-medium">{a.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div>
                            <SectionTitle title="Today at a glance" />
                            <Panel className="divide-y divide-border">
                                {callHistory.length === 0 ? (
                                    <div className="px-3.5 py-4 text-center text-[12.5px] text-muted-foreground">No call activity recorded yet.</div>
                                ) : (
                                    callHistory.slice(0, 4).map((a) => (
                                        <div key={a.id} className="flex gap-3 px-3.5 py-2.5">
                                            <span className={cn('w-[62px] shrink-0 text-[11.5px] tabular-nums text-muted-foreground')}>{timeAgo(a.time)}</span>
                                            <div className="min-w-0">
                                                <div className="text-[12.5px] font-medium capitalize">{a.type} call</div>
                                                <div className="truncate text-[12px] text-muted-foreground">{a.name} · {a.number}</div>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </Panel>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
