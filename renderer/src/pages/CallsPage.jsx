import React, { useMemo, useState } from 'react';
import { CheckCheck, History, MicOff, Phone, PhoneOff, PhoneIncoming, PhoneMissed, PhoneOutgoing, Send, Trash2, Volume2 } from 'lucide-react';
import { Button, EmptyState, Panel, Tabs } from '../ui-kit';
import { useApp } from '../appStore';
import { clockTime, timeAgo, formatDuration } from '../lib/utils';

const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

function typeIcon(type) {
    if (type === 'incoming') return PhoneIncoming;
    if (type === 'missed') return PhoneMissed;
    return PhoneOutgoing;
}

function ActiveCallCard() {
    const { activeCall, callDurationSecs, endCall, toggleMute, toggleAudioTarget, muteRinger, call } = useApp();
    if (!activeCall) return null;
    return (
        <Panel className="border-primary/30 bg-primary/5 p-4">
            <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Phone className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{activeCall.name}</div>
                    <div className="text-[12px] tabular-nums text-muted-foreground">
                        {activeCall.number} · {formatDuration(callDurationSecs)}
                    </div>
                </div>
                <div className="flex gap-1.5">
                    <Button size="icon" variant="subtle" onClick={() => toggleMute(!call.isMuted)} aria-label="Mute">
                        <MicOff className={call.isMuted ? 'h-4 w-4 text-destructive' : 'h-4 w-4'} />
                    </Button>
                    <Button size="icon" variant="subtle" onClick={toggleAudioTarget} aria-label="Audio target">
                        <Volume2 className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="subtle" onClick={muteRinger} aria-label="Mute ringer">
                        <PhoneOff className="h-4 w-4" />
                    </Button>
                    <Button variant="destructive" size="icon" onClick={endCall} aria-label="Hang up">
                        <PhoneOff className="h-4 w-4" />
                    </Button>
                </div>
            </div>
        </Panel>
    );
}

export default function CallsPage() {
    const { callHistory, startCall, answerCall, declineCall, removeHistory, clearCallHistory, toast } = useApp();
    const [number, setNumber] = useState('');
    const [tab, setTab] = useState('all');

    const filtered = useMemo(
        () => (tab === 'all' ? callHistory : callHistory.filter((c) => c.type === tab)),
        [callHistory, tab]
    );

    const dial = () => {
        if (!number.trim()) return;
        startCall(number.trim());
        toast({ title: `Calling ${number.trim()}` });
        setNumber('');
    };

    return (
        <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
                <Tabs
                    value={tab}
                    onChange={setTab}
                    tabs={[
                        { key: 'all', label: 'All' },
                        { key: 'incoming', label: 'Incoming' },
                        { key: 'outgoing', label: 'Outgoing' },
                        { key: 'missed', label: 'Missed' }
                    ]}
                />
                <Button className="ml-auto" variant="ghost" onClick={() => { clearCallHistory(); toast({ title: 'Call history cleared' }); }}>
                    <Trash2 className="h-4 w-4" /> Clear history
                </Button>
            </div>

            <div className="lb-scroll flex-1 p-5">
                <div className="mx-auto grid max-w-[980px] grid-cols-1 gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
                    <Panel className="flex flex-col p-4">
                        <h3 className="mb-3 text-[14px] font-semibold">Dial pad</h3>
                        <div className="text-center text-[28px] tabular-nums tracking-wider">
                            {number || <span className="text-muted-foreground">—— ——</span>}
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2">
                            {keys.map((k) => (
                                <button
                                    key={k}
                                    onClick={() => setNumber((n) => n + k)}
                                    className="lb-focus rounded-lg border border-border bg-surface-2 py-2.5 text-[16px] font-medium transition-colors hover:bg-surface-3"
                                >
                                    {k}
                                </button>
                            ))}
                        </div>
                        <div className="mt-3 flex items-center justify-center gap-2">
                            <Button className="flex-1" variant="ghost" onClick={() => setNumber('')}>
                                Clear
                            </Button>
                            <Button variant="primary" onClick={dial} disabled={!number.trim()}>
                                <Send className="h-4 w-4" /> Call
                            </Button>
                        </div>
                    </Panel>

                    <section>
                        <ActiveCallCard />
                        <div className="mt-3">
                            <h3 className="mb-2 px-1 text-[14px] font-semibold">Recent calls</h3>
                            <Panel className="divide-y divide-border">
                                {filtered.length === 0 ? (
                                    <EmptyState
                                        icon={History}
                                        title={tab === 'all' ? 'No calls yet' : `No ${tab} calls`}
                                        description="Calls made, answered, and missed from your phone are logged here."
                                    />
                                ) : (
                                    filtered.map((c) => {
                                        const Icon = typeIcon(c.type);
                                        return (
                                            <div key={c.id} className="group flex items-center gap-3 px-3.5 py-2.5">
                                                <div
                                                    className={`flex h-9 w-9 items-center justify-center rounded-full ${
                                                        c.type === 'missed' ? 'bg-destructive/10 text-destructive' : 'bg-surface-2 text-primary'
                                                    }`}
                                                >
                                                    <Icon className="h-4 w-4" />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-[13px] font-medium">{c.name || c.number}</div>
                                                    <div className="truncate text-[12px] text-muted-foreground">
                                                        {c.number} · {c.type} {c.durationSecs ? `· ${formatDuration(c.durationSecs)}` : ''} · {timeAgo(c.time)}
                                                    </div>
                                                </div>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="opacity-0 group-hover:opacity-100"
                                                    onClick={() => removeHistory(c.id)}
                                                >
                                                    Remove
                                                </Button>
                                            </div>
                                        );
                                    })
                                )}
                            </Panel>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
