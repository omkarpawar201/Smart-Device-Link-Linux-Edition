import React from 'react';
import { Mic, MicOff, Monitor, Phone, PhoneOff, Smartphone, BellOff } from 'lucide-react';
import { Avatar, Button } from '../ui-kit';
import { useApp } from '../appStore';
import { cn } from '../lib/utils';

export function IncomingCallOverlay() {
    const { incomingCall, call, answerCall, declineCall, muteRinger } = useApp();
    // Only the ringing phase shows the Answer/Decline buttons; once the call is
    // active only the in-call panel should render (they share the same corner).
    if (!incomingCall || !call) return null;

    const name = call.name || 'Unknown Caller';
    const number = call.number || 'Unknown Number';

    return (
        <div className="fixed bottom-5 right-5 z-[60] w-[320px] animate-in fade-in slide-in-from-bottom-3 rounded-xl border border-border-strong bg-popover shadow-float">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
                <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
                Incoming call
            </div>
            <div className="flex items-center gap-3 px-4 py-4">
                <Avatar name={name} size={44} />
                <div>
                    <div className="text-[15px] font-semibold">{name}</div>
                    <div className="text-[12.5px] text-muted-foreground">{number} · Mobile</div>
                </div>
            </div>
            <div className="grid grid-cols-3 gap-2 px-4 pb-4">
                <Button variant="subtle" onClick={muteRinger} className="h-9 justify-center" title="Silence ringer">
                    <BellOff className="h-4 w-4" />
                </Button>
                <Button variant="danger" onClick={declineCall} className="h-9 justify-center">
                    <PhoneOff className="h-4 w-4" /> Decline
                </Button>
                <Button variant="success" onClick={answerCall} className="h-9 justify-center">
                    <Phone className="h-4 w-4" /> Answer
                </Button>
            </div>
        </div>
    );
}

export function ActiveCallPanel() {
    const { call, callDurationSecs, endCall, toggleMute, toggleAudioTarget, toast, micSources, selectedMic, micGain, selectMic, adjustMicGain } = useApp();
    if (!call) return null;

    const name = call.name || 'Unknown Caller';
    const isMuted = !!call.isMuted;
    const audioTarget = call.audioTarget || 'PC_SPEAKERS';
    const mm = String(Math.floor(callDurationSecs / 60)).padStart(2, '0');
    const ss = String(callDurationSecs % 60).padStart(2, '0');

    return (
        <div className="fixed bottom-5 right-5 z-[60] w-[330px] animate-in fade-in slide-in-from-bottom-3 overflow-hidden rounded-xl border border-border-strong bg-popover shadow-float">
            <div className="flex items-center justify-between border-b border-border bg-accent/60 px-4 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-foreground">On call · {name}</span>
                <button onClick={endCall} className="text-muted-foreground hover:text-foreground" aria-label="End">
                    <PhoneOff className="h-3.5 w-3.5" />
                </button>
            </div>
            <div className="flex items-center gap-3 px-4 py-4">
                <Avatar name={name} size={44} />
                <div>
                    <div className="text-[15px] font-semibold">{name}</div>
                    <div className="font-mono text-[13px] tabular-nums text-primary">{mm}:{ss}</div>
                </div>
            </div>
            <div className="grid grid-cols-3 gap-1.5 px-3 pb-3">
                {[
                    { icon: isMuted ? MicOff : Mic, label: 'Mute', on: isMuted, act: () => toggleMute(!isMuted) },
                    { icon: Monitor, label: 'PC audio', on: audioTarget === 'PC_SPEAKERS', act: toggleAudioTarget },
                    {
                        icon: Smartphone,
                        label: 'Phone audio',
                        on: audioTarget !== 'PC_SPEAKERS',
                        act: () => toast({ title: 'Audio transfer', description: 'Audio moves through the bridge.' })
                    }
                ].map((c) => (
                    <button
                        key={c.label}
                        onClick={c.act}
                        className={cn(
                            'lb-focus flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11px] transition-colors',
                            c.on ? 'border-primary/40 bg-accent text-accent-foreground' : 'border-border bg-surface-2 text-muted-foreground hover:text-foreground'
                        )}
                    >
                        <c.icon className="h-4 w-4" />
                        {c.label}
                    </button>
                ))}
            </div>
            {micSources.length > 0 && (
                <div className="space-y-1.5 border-t border-border px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                        <label className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Mic</label>
                        <select
                            value={selectedMic || ''}
                            onChange={(e) => selectMic(e.target.value || null)}
                            className="lb-focus h-7 max-w-[200px] flex-1 rounded-md border border-border bg-surface-2 px-1.5 text-[11.5px] text-foreground outline-none"
                        >
                            <option value="">System default</option>
                            {micSources.map((s) => (
                                <option key={s.name} value={s.name}>{s.description || s.name}</option>
                            ))}
                        </select>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <label className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Gain</label>
                        <input
                            type="range"
                            min="20"
                            max="200"
                            step="5"
                            value={micGain}
                            onChange={(e) => adjustMicGain(Number(e.target.value))}
                            className="h-1.5 flex-1 accent-[var(--primary)]"
                        />
                        <span className="w-9 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{micGain}%</span>
                    </div>
                </div>
            )}
            <div className="px-4 pb-4">
                <Button variant="danger" onClick={endCall} className="h-9 w-full justify-center">
                    <PhoneOff className="h-4 w-4" /> End call
                </Button>
            </div>
        </div>
    );
}
