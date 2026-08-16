import React from 'react';
import { ListMusic, Music2, Pause, Play, RefreshCw, Repeat, Shuffle, SkipBack, SkipForward, Volume2 } from 'lucide-react';
import { Button, EmptyState, Panel, Progress, SectionTitle, StatusBadge } from '../ui-kit';
import { useApp } from '../appStore';
import { formatDuration } from '../lib/utils';

export default function MediaPage() {
    const { phoneMedia, pcMedia, syncPhone, phoneAction, phoneVolume, phoneSeek, pcAction, pcVolume, pcSeek, deviceName } = useApp();

    const phoneLen = phoneMedia.length || 0;
    const phonePct = phoneLen > 0 ? Math.min(100, ((phoneMedia.pos || 0) / phoneLen) * 100) : 0;
    const phoneHas = phoneMedia.available || phoneMedia.title || phoneMedia.artist;

    const pcLen = pcMedia.length || 0;
    const pcPct = pcLen > 0 ? Math.min(100, ((pcMedia.pos || 0) / pcLen) * 100) : 0;
    const pcHas = pcMedia.available || pcMedia.title || pcMedia.artist;

    return (
        <div className="lb-scroll h-full p-5">
            <div className="mx-auto grid max-w-[1080px] gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
                <Panel className="p-5">
                    <div className="flex gap-5">
                        <div
                            className="flex h-[168px] w-[168px] shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border shadow-panel"
                            style={{
                                background: 'radial-gradient(120% 120% at 30% 20%, oklch(0.35_0.10_270) 0%, oklch(0.20_0.06_250) 60%, oklch(0.14_0.03_240) 100%)'
                            }}
                        >
                            {phoneMedia.albumArt ? (
                                <img src={phoneMedia.albumArt} alt={phoneMedia.album || 'artwork'} className="h-full w-full object-cover" />
                            ) : (
                                <Music2 className="h-10 w-10 text-white/70" />
                            )}
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col">
                            <StatusBadge tone="accent" className="self-start">
                                {phoneMedia.player || 'Phone player'} · {deviceName}
                            </StatusBadge>
                            <h2 className="mt-2 truncate text-[22px] font-semibold tracking-tight">{phoneHas ? phoneMedia.title : 'Nothing playing'}</h2>
                            <div className="text-[13.5px] text-muted-foreground">{phoneHas ? phoneMedia.artist || 'Unknown artist' : 'Start music on your phone to control it here.'}</div>
                            <div className="text-[12.5px] text-muted-foreground">{phoneMedia.album || ''}</div>

                            <div className="mt-auto">
                                <input
                                    type="range"
                                    min={0}
                                    max={Math.max(1, phoneLen)}
                                    value={Math.min(phoneMedia.pos || 0, phoneLen)}
                                    onChange={(e) => phoneSeek(Number(e.target.value))}
                                    className="w-full accent-[var(--color-primary)]"
                                    aria-label="Seek"
                                    disabled={!phoneHas}
                                />
                                <div className="flex justify-between text-[11.5px] tabular-nums text-muted-foreground">
                                    <span>{formatDuration(phoneMedia.pos || 0)}</span>
                                    <span>{formatDuration(phoneLen)}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="mt-5 flex items-center gap-2">
                        <Button variant="ghost" size="icon" onClick={syncPhone} aria-label="Sync state"><RefreshCw className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" onClick={() => phoneAction('Previous')} aria-label="Previous"><SkipBack className="h-4 w-4" /></Button>
                        <Button variant="primary" size="icon" className="h-10 w-10" onClick={() => phoneAction('PlayPause')} aria-label="Play/pause">
                            {phoneMedia.isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => phoneAction('Next')} aria-label="Next"><SkipForward className="h-4 w-4" /></Button>

                        <div className="ml-auto flex w-[180px] items-center gap-2">
                            <Volume2 className="h-4 w-4 text-muted-foreground" />
                            <input
                                type="range"
                                min={0}
                                max={100}
                                value={phoneMedia.volume ?? 0}
                                onChange={(e) => phoneVolume(Number(e.target.value))}
                                className="w-full accent-[var(--color-primary)]"
                                aria-label="Volume"
                            />
                            <span className="w-7 text-right text-[11.5px] tabular-nums text-muted-foreground">{phoneMedia.volume ?? 0}</span>
                        </div>
                    </div>
                </Panel>

                <div>
                    <SectionTitle title="PC playback" action={<Button variant="ghost" size="sm"><ListMusic className="h-3.5 w-3.5" /> This PC</Button>} />
                    <Panel className="p-4">
                        {!pcHas ? (
                            <div className="py-6 text-center text-[12.5px] text-muted-foreground">
                                <Music2 className="mx-auto mb-2 h-6 w-6 opacity-60" />
                                No media playing on this PC right now.
                            </div>
                        ) : (
                            <>
                                <div className="flex items-center gap-3">
                                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-primary/40 to-surface-3 text-primary">
                                        <Music2 className="h-5 w-5" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-[13px] font-medium">{pcMedia.title}</div>
                                        <div className="truncate text-[12px] text-muted-foreground">{pcMedia.artist} {pcMedia.album ? `· ${pcMedia.album}` : ''}</div>
                                    </div>
                                    <Button variant="ghost" size="icon" onClick={() => pcAction('PlayPause')} aria-label="Play/pause">
                                        {pcMedia.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                                    </Button>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={Math.max(1, pcLen)}
                                    value={Math.min(pcMedia.pos || 0, pcLen)}
                                    onChange={(e) => pcSeek(Number(e.target.value))}
                                    className="mt-3 w-full accent-[var(--color-primary)]"
                                    aria-label="Seek"
                                />
                                <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
                                    <span>{formatDuration(pcMedia.pos || 0)}</span>
                                    <span>{formatDuration(pcLen)}</span>
                                </div>
                                <div className="mt-3 flex items-center gap-2">
                                    <Button variant="ghost" size="icon" onClick={() => pcAction('Previous')} aria-label="Previous"><SkipBack className="h-4 w-4" /></Button>
                                    <Button variant="ghost" size="icon" onClick={() => pcAction('Next')} aria-label="Next"><SkipForward className="h-4 w-4" /></Button>
                                    <Button variant="ghost" size="icon" aria-label="Repeat"><Repeat className="h-4 w-4" /></Button>
                                    <Button variant="ghost" size="icon" aria-label="Shuffle"><Shuffle className="h-4 w-4" /></Button>
                                    <div className="ml-auto flex w-[130px] items-center gap-2">
                                        <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
                                        <input
                                            type="range"
                                            min={0}
                                            max={100}
                                            value={pcMedia.volume ?? 0}
                                            onChange={(e) => pcVolume(Number(e.target.value))}
                                            className="w-full accent-[var(--color-primary)]"
                                            aria-label="Volume"
                                        />
                                    </div>
                                </div>
                            </>
                        )}
                    </Panel>

                    <SectionTitle className="mt-5" title="Controls work both ways" />
                    <Panel className="p-4">
                        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                            LinkBridge mirrors playback state and volume between {deviceName} and this PC. Pause, skip, and seek on either
                            device — both stay in sync over Wi-Fi.
                        </p>
                        <div className="mt-3">
                            <Progress value={phoneHas ? phonePct : 0} />
                        </div>
                    </Panel>
                </div>
            </div>
        </div>
    );
}
