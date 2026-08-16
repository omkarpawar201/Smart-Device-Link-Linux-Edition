import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertTriangle,
    Camera as CameraIcon,
    Crosshair,
    MonitorSmartphone,
    Play,
    RefreshCw,
    RotateCw,
    Smartphone,
    Square
} from 'lucide-react';
import { Button, EmptyState, Panel, SectionTitle, StatusBadge } from '../ui-kit';
import { useApp } from '../appStore';

const BEZEL = 14;
const AREA_PAD = 20;
const isTcpSerial = (s) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s || '');
const transportLabel = (s) => (isTcpSerial(s) ? 'ADB over Wi-Fi' : 'USB');

export default function ScreenPage() {
    const { deviceName, toast } = useApp();
    const [devices, setDevices] = useState([]);
    const [selectedSerial, setSelectedSerial] = useState('');
    const [bins, setBins] = useState({ scrcpy: null, adb: null });
    const [running, setRunning] = useState(false);
    const [activeSerial, setActiveSerial] = useState(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [turnScreenOff, setTurnScreenOff] = useState(false);
    const [stayAwake, setStayAwake] = useState(true);
    const [maxFps, setMaxFps] = useState(30);
    const [deviceSize, setDeviceSize] = useState(null);
    const [rotated, setRotated] = useState(false);
    const [screenshotting, setScreenshotting] = useState(false);
    const [modelDim, setModelDim] = useState(null);
    const [showBoundary, setShowBoundary] = useState(false);
    const [mirrorRect, setMirrorRect] = useState(null);
    const [holeRect, setHoleRect] = useState(null);
    const [docked, setDocked] = useState(false);

    const runningRef = useRef(false);
    const embeddedRef = useRef(false);
    const selectedSerialRef = useRef('');
    const holeRef = useRef(null);
    const areaRef = useRef(null);
    const sizeRef = useRef({ width: 1080, height: 2400 });

    const pushMove = useCallback(() => {
        const el = holeRef.current;
        if (!el || !runningRef.current) return;
        const r = el.getBoundingClientRect();
        window.api.send('mirror:move-window', {
            rect: { x: r.left, y: r.top, width: r.width, height: r.height },
            dpr: window.devicePixelRatio || 1
        });
    }, []);

    const embedNow = useCallback(async () => {
        if (embeddedRef.current) return;
        const el = holeRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const res = await window.api.invoke('mirror:embed-window', {
            rect: { x: r.left, y: r.top, width: r.width, height: r.height },
            dpr: window.devicePixelRatio || 1
        });
        if (res && res.ok) {
            embeddedRef.current = true;
            pushMove();
        } else {
            setTimeout(() => {
                if (!runningRef.current) return;
                const el2 = holeRef.current;
                if (!el2) return;
                const r2 = el2.getBoundingClientRect();
                window.api.invoke('mirror:embed-window', {
                    rect: { x: r2.left, y: r2.top, width: r2.width, height: r2.height },
                    dpr: window.devicePixelRatio || 1
                }).then((res2) => {
                    if (res2 && res2.ok) {
                        embeddedRef.current = true;
                        pushMove();
                    } else {
                        setError('Could not dock the mirror window into the phone model.');
                    }
                });
            }, 900);
        }
    }, [pushMove]);

    const refreshDevices = useCallback(async () => {
        setLoading(true);
        try {
            const res = await window.api.invoke('mirror:list-devices');
            if (res && res.ok) {
                setBins({ scrcpy: res.scrcpy, adb: res.adb });
                const list = res.devices || [];
                setDevices(list);
                if (!runningRef.current && !selectedSerialRef.current) {
                    const online = list.filter((d) => d.state === 'device');
                    const tcp = online.find((d) => d.isTcpip) || online[0];
                    if (tcp) {
                        setSelectedSerial(tcp.serial);
                        selectedSerialRef.current = tcp.serial;
                    }
                }
            } else {
                setError((res && res.error) || 'Failed to list adb devices');
            }
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refreshDevices();
        if (window.api && window.api.onMirrorStatus) {
            window.api.onMirrorStatus((status) => {
                runningRef.current = !!status.running;
                setRunning(runningRef.current);
                setActiveSerial(status.serial || null);
                setDocked(!!status.embedded);
                if (status.error) setError(status.error);
                if (status.running && !status.embedded) {
                    embeddedRef.current = false;
                    window.api
                        .invoke('mirror:get-size', { serial: status.serial })
                        .then((s) => {
                            if (s && s.ok) {
                                sizeRef.current = { width: s.width, height: s.height };
                                setDeviceSize({ width: s.width, height: s.height });
                            }
                        })
                        .catch(() => {});
                    // Fallback if the main-process auto-dock didn't land.
                    setTimeout(embedNow, 2000);
                }
            });
        }
    }, [refreshDevices, embedNow]);

    const sz = deviceSize || sizeRef.current;
    const ratio = rotated ? sz.height / sz.width : sz.width / sz.height;

    useEffect(() => {
        const update = () => {
            const area = areaRef.current;
            if (!area) return;
            // clientWidth/Height include the container's p-5 padding; subtract it
            // so the model sits inside the padded area instead of touching edges.
            const aw = (area.clientWidth || 0) - AREA_PAD * 2;
            const ah = (area.clientHeight || 0) - AREA_PAD * 2;
            if (aw <= 0 || ah <= 0) return;
            let width = aw;
            let height = width / ratio;
            if (height > ah) {
                height = ah;
                width = height * ratio;
            }
            setModelDim({ width: Math.floor(width), height: Math.floor(height) });
        };
        update();
        const ro = new ResizeObserver(update);
        if (areaRef.current) ro.observe(areaRef.current);
        window.addEventListener('resize', update);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', update);
        };
    }, [ratio]);

    // Keep the docked window glued to the phone-model hole on rotate / resize.
    useEffect(() => {
        if (!running || !modelDim) return undefined;
        const el = holeRef.current;
        if (!el) return undefined;
        const ro = new ResizeObserver(() => pushMove());
        ro.observe(el);
        return () => ro.disconnect();
    }, [running, modelDim, rotated, deviceSize, pushMove]);

    // Boundary overlay: poll the real window rect while the toggle is on.
    useEffect(() => {
        if (!showBoundary || !running) {
            setMirrorRect(null);
            setHoleRect(null);
            return undefined;
        }
        let alive = true;
        const poll = async () => {
            if (!alive) return;
            const hole = holeRef.current;
            if (hole) {
                const hr = hole.getBoundingClientRect();
                setHoleRect({ x: hr.left, y: hr.top, width: hr.width, height: hr.height });
            }
            try {
                const res = await window.api.invoke('mirror:get-rect');
                if (!alive) return;
                if (res && res.ok && res.rect && res.scale) {
                    const s = res.scale || 1;
                    setMirrorRect({
                        x: res.rect.x / s,
                        y: res.rect.y / s,
                        width: res.rect.width / s,
                        height: res.rect.height / s
                    });
                }
            } catch (e) {
                /* non-fatal */
            }
        };
        poll();
        const t = setInterval(poll, 400);
        return () => {
            alive = false;
            clearInterval(t);
        };
    }, [showBoundary, running]);

    // Ctrl+Alt+B toggles the alignment boundary overlay.
    useEffect(() => {
        const onKey = (e) => {
            if (e.ctrlKey && e.altKey && (e.key === 'b' || e.key === 'B')) {
                e.preventDefault();
                setShowBoundary((v) => !v);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const start = () => {
        setError('');
        selectedSerialRef.current = selectedSerial;
        // Ask scrcpy to open at (roughly) the hole size so the pre-dock window
        // doesn't flash huge; position is corrected by the embed calibration.
        const hole = holeRef.current ? holeRef.current.getBoundingClientRect() : null;
        window.api.send('mirror:start', {
            serial: selectedSerial || undefined,
            turnScreenOff,
            stayAwake,
            maxFps,
            embedded: true,
            embedRect: hole
                ? { x: hole.left, y: hole.top, width: hole.width, height: hole.height }
                : null
        });
        toast({ title: 'Starting mirror…' });
    };

    const stop = () => {
        embeddedRef.current = false;
        window.api.send('mirror:stop');
    };

    const rotate = () => setRotated((r) => !r);

    const screenshot = async () => {
        setScreenshotting(true);
        try {
            const res = await window.api.invoke('mirror:screenshot');
            if (res && res.ok) {
                toast({ title: 'Screenshot saved', description: res.path });
            } else {
                toast({ title: 'Screenshot failed', description: (res && res.error) || 'unknown error' });
            }
        } catch (e) {
            toast({ title: 'Screenshot failed', description: e.message });
        } finally {
            setScreenshotting(false);
        }
    };

    const focusMirror = () => {
        window.api.send('mirror:focus-window');
        // Manual recovery if the main-process auto-dock didn't land.
        if (runningRef.current) embedNow();
    };

    const hasScrcpy = !!bins.scrcpy;
    const onlineDevice = devices.find((d) => d.serial === activeSerial);

    return (
        <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
                <div>
                    <h3 className="text-[15px] font-semibold">Screen Mirroring</h3>
                    <p className="text-[12px] text-muted-foreground">
                        Control {deviceName} from the PC — tap, swipe, type, use apps.
                    </p>
                </div>
                <div className="ml-auto flex gap-1.5">
                    {running ? (
                        <>
                            <Button variant="ghost" size="sm" onClick={rotate} title="Rotate the phone model">
                                <RotateCw className="h-4 w-4" /> Rotate
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setShowBoundary((v) => !v)}
                                title="Toggle alignment boundary overlay (Ctrl+Alt+B)"
                            >
                                <Crosshair className="h-4 w-4" /> {showBoundary ? 'Hide boundary' : 'Show boundary'}
                            </Button>
                            {running && !docked && (
                                <Button variant="ghost" size="sm" onClick={embedNow} title="Retry docking the mirror window">
                                    <MonitorSmartphone className="h-4 w-4" /> Retry dock
                                </Button>
                            )}
                            <Button variant="ghost" size="sm" onClick={screenshot} disabled={screenshotting}>
                                <CameraIcon className="h-4 w-4" /> {screenshotting ? 'Capturing…' : 'Screenshot'}
                            </Button>
                            <Button variant="destructive" size="sm" onClick={stop}>
                                <Square className="h-4 w-4" /> End session
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button variant="ghost" size="sm" onClick={refreshDevices} disabled={loading}>
                                <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /> Refresh
                            </Button>
                            <Button variant="primary" size="sm" onClick={start} disabled={!hasScrcpy || devices.length === 0}>
                                <Play className="h-4 w-4" /> Start Mirroring
                            </Button>
                        </>
                    )}
                </div>
            </div>

            {!hasScrcpy && (
                <div className="flex items-start gap-3 border-b border-destructive/40 bg-destructive/10 px-5 py-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <div className="text-[12.5px] leading-relaxed text-muted-foreground">
                        <b className="text-foreground">scrcpy not found.</b> Install it with{' '}
                        <code className="rounded bg-surface-3 px-1.5 py-0.5 text-[11.5px]">winget install Genymobile.scrcpy</code> and restart the app.
                    </div>
                </div>
            )}

            <div className="flex min-h-0 flex-1">
                <div ref={areaRef} className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden p-5">
                    {modelDim ? (
                        <div
                            onClick={focusMirror}
                            className="relative cursor-pointer select-none"
                            style={{
                                width: modelDim.width,
                                height: modelDim.height,
                                padding: BEZEL,
                                borderRadius: 12,
                                border: '1px solid rgba(255,255,255,0.16)',
                                background: 'linear-gradient(150deg, #23262d 0%, #14161b 45%, #0d0f13 100%)',
                                boxShadow: '0 24px 60px -16px rgba(0,0,0,0.7), inset 0 0 0 1px rgba(0,0,0,0.5)'
                            }}
                        >
                            {/* centred punch-hole camera, sits in the top bezel */}
                            <div
                                className="absolute left-1/2 z-10 -translate-x-1/2"
                                style={{
                                    top: 3,
                                    width: 8,
                                    height: 8,
                                    borderRadius: 99,
                                    background: 'radial-gradient(circle at 35% 30%, #1c2026, #05070a 70%)',
                                    border: '1px solid rgba(255,255,255,0.18)'
                                }}
                            />
                            {/* side buttons */}
                            <div className="absolute -right-[3px] flex flex-col gap-1.5" style={{ top: BEZEL + 30 }}>
                                <div style={{ width: 3, height: 24, borderRadius: 2, background: '#262a32' }} />
                                <div style={{ width: 3, height: 38, borderRadius: 2, background: '#262a32' }} />
                            </div>
                            <div
                                ref={holeRef}
                                data-mirror-hole
                                className="h-full w-full overflow-hidden"
                                style={{ background: '#000', borderRadius: 6 }}
                            >
                                {running ? (
                                    docked ? (
                                        <div className="h-full w-full" />
                                    ) : (
                                        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-b from-[oklch(0.32_0.05_240)] to-[oklch(0.18_0.03_250)] text-center text-white/80">
                                            <MonitorSmartphone className="h-6 w-6 opacity-60" />
                                            <span className="text-[11px]">Docking live mirror…</span>
                                        </div>
                                    )
                                ) : (
                                    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-gradient-to-b from-[oklch(0.32_0.05_240)] to-[oklch(0.18_0.03_250)] text-center text-white/90">
                                        <div className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-white/12">
                                            <Smartphone className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <div className="text-[13px] font-semibold">Ready to mirror</div>
                                            <div className="mt-0.5 max-w-[180px] text-[11px] text-white/60">
                                                The live screen will appear inside this phone when you start a session.
                                            </div>
                                        </div>
                                        <Button
                                            variant="primary"
                                            size="sm"
                                            onClick={start}
                                            disabled={!hasScrcpy || devices.length === 0}
                                        >
                                            <Play className="h-4 w-4" /> Start Mirroring
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <EmptyState
                            icon={MonitorSmartphone}
                            tone="neutral"
                            title="Screen Mirroring"
                            description="Configure the device on the right, then press Start Mirroring. The mirrored screen appears inside the phone model."
                        />
                    )}
                </div>

                <aside className="hidden w-[250px] shrink-0 overflow-y-auto border-l border-border p-4 lg:block">
                    {running ? (
                        <>
                            <SectionTitle title="Session" />
                            <Panel className="divide-y divide-border text-[12.5px]">
                                {[
                                    ['Device', onlineDevice?.model || deviceName],
                                    ['Serial', activeSerial || '—'],
                                    ['Resolution', deviceSize ? `${deviceSize.width} × ${deviceSize.height}` : '—'],
                                    ['Frame rate', `${maxFps} fps`],
                                    ['Transport', transportLabel(activeSerial)]
                                ].map(([k, v]) => (
                                    <div key={k} className="flex justify-between gap-2 px-3 py-2">
                                        <span className="text-muted-foreground">{k}</span>
                                        <span className="truncate font-medium">{v}</span>
                                    </div>
                                ))}
                            </Panel>
                            <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
                                Click the phone to focus it, then tap = tap, drag = swipe, scroll = scroll, and type to send
                                keyboard input. The stream is local — frames never leave your network.
                            </p>
                            <Button variant="subtle" className="mt-3 w-full justify-center" onClick={stop}>
                                <Square className="h-4 w-4" /> End mirroring session
                            </Button>
                        </>
                    ) : (
                        <>
                            <SectionTitle title="Device" />
                            <Panel className="p-4">
                                <div className="mb-2 text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">
                                    Phone ({devices.length > 0 ? transportLabel(selectedSerial) : 'ADB over Wi-Fi'})
                                </div>
                                {devices.length === 0 ? (
                                    <div className="flex flex-col gap-2 text-[12.5px] text-muted-foreground">
                                        <div className="flex items-center gap-2">
                                            <Smartphone className="h-4 w-4 shrink-0" />
                                            <span className="font-medium text-foreground">No device connected</span>
                                        </div>
                                        <p className="leading-relaxed">
                                            Enable <b className="text-foreground">Wireless Debugging</b> on the phone, then connect it:
                                        </p>
                                        <code className="w-full overflow-x-auto whitespace-nowrap rounded-md bg-surface-3 px-2.5 py-1.5 font-mono text-[11px] text-foreground">
                                            adb connect &lt;ip&gt;:&lt;port&gt;
                                        </code>
                                        <Button variant="subtle" size="sm" className="mt-1 w-full justify-center" onClick={refreshDevices} disabled={loading}>
                                            <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Scan for devices
                                        </Button>
                                    </div>
                                ) : (
                                    <select
                                        value={selectedSerial}
                                        onChange={(e) => setSelectedSerial(e.target.value)}
                                        disabled={running}
                                        className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px] outline-none focus:border-primary"
                                    >
                                        {devices.map((d) => (
                                            <option key={d.serial} value={d.serial} disabled={d.state !== 'device'}>
                                                {d.model || d.kind || 'Android device'} — {d.serial}{' '}
                                                {d.state !== 'device' ? `(${d.state})` : ''}
                                            </option>
                                        ))}
                                    </select>
                                )}
                            </Panel>

                            <SectionTitle className="mt-4" title="Options" />
                            <Panel className="space-y-3 p-4">
                                <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted-foreground">
                                    <input type="checkbox" checked={turnScreenOff} onChange={(e) => setTurnScreenOff(e.target.checked)} />
                                    Turn phone screen off while mirroring
                                </label>
                                <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted-foreground">
                                    <input type="checkbox" checked={stayAwake} onChange={(e) => setStayAwake(e.target.checked)} />
                                    Keep phone awake
                                </label>
                                <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                                    Max FPS
                                    <select
                                        value={maxFps}
                                        onChange={(e) => setMaxFps(Number(e.target.value))}
                                        className="ml-auto rounded-md border border-border bg-surface-2 px-2 py-1 text-[12.5px] outline-none focus:border-primary"
                                    >
                                        <option value={30}>30</option>
                                        <option value={60}>60</option>
                                    </select>
                                </label>
                            </Panel>

                            {error && (
                                <div className="mt-3 whitespace-pre-wrap rounded-md bg-destructive/10 px-3 py-2 text-[12px] leading-relaxed text-destructive">
                                    {error}
                                </div>
                            )}

                            <Button
                                variant="primary"
                                className="mt-4 w-full justify-center"
                                onClick={start}
                                disabled={!hasScrcpy || devices.length === 0}
                            >
                                <Play className="h-4 w-4" /> Start Mirroring
                            </Button>
                        </>
                    )}
                </aside>
            </div>

            {showBoundary && (
                <div className="pointer-events-none fixed inset-0 z-[999]">
                    {holeRect && (
                        <div
                            style={{
                                position: 'fixed',
                                left: holeRect.x,
                                top: holeRect.y,
                                width: holeRect.width,
                                height: holeRect.height,
                                border: '1px dashed rgba(34,197,94,0.95)',
                                boxShadow: '0 0 0 1px rgba(34,197,94,0.25)',
                                zIndex: 999
                            }}
                        />
                    )}
                    {mirrorRect && (
                        <div
                            style={{
                                position: 'fixed',
                                left: mirrorRect.x,
                                top: mirrorRect.y,
                                width: mirrorRect.width,
                                height: mirrorRect.height,
                                border: '2px dashed rgba(239,68,68,0.95)',
                                zIndex: 1000
                            }}
                        />
                    )}
                    {holeRect && mirrorRect && (
                        <div className="pointer-events-auto fixed right-4 top-4 z-[1001] rounded-lg border border-border bg-popover/95 px-3 py-2 font-mono text-[11px] shadow-float backdrop-blur">
                            <div className="mb-1 font-sans text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Boundary · green = frame · red = mirror
                            </div>
                            <div className="text-emerald-400">
                                hole {Math.round(holeRect.x)},{Math.round(holeRect.y)} {Math.round(holeRect.width)}x{Math.round(holeRect.height)}
                            </div>
                            <div className="text-red-400">
                                mirror {Math.round(mirrorRect.x)},{Math.round(mirrorRect.y)} {Math.round(mirrorRect.width)}x{Math.round(mirrorRect.height)}
                            </div>
                            <div className="mt-1 text-foreground/80">
                                dx {Math.round(mirrorRect.x - holeRect.x)} · dy {Math.round(mirrorRect.y - holeRect.y)} · scale{' '}
                                {(mirrorRect.width / holeRect.width).toFixed(3)}x {(mirrorRect.height / holeRect.height).toFixed(3)}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
