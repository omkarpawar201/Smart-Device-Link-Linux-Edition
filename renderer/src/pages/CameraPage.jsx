import React, { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Circle, Download, Image as ImageIcon, Play, PlugZap, RefreshCcw, Square, SwitchCamera, Trash2, Video, WifiOff, Zap } from 'lucide-react';
import { Button, EmptyState, Panel, SectionTitle, StatusBadge } from '../ui-kit';
import { useApp } from '../appStore';

const api = () => window.api;

export default function CameraPage() {
    const { toast, deviceName } = useApp();

    const [driverDevices, setDriverDevices] = useState([]);
    const [driverLoading, setDriverLoading] = useState(true);
    const [installing, setInstalling] = useState(false);
    const [stream, setStream] = useState(null);
    const [url, setUrl] = useState('');
    const [source, setSource] = useState('wifi');
    const [res, setRes] = useState('720p');
    const [fps, setFps] = useState(30);
    const [shots, setShots] = useState([]);
    const [live, setLive] = useState(false);
    const [activeBuf, setActiveBuf] = useState(0);
    const activeBufRef = useRef(0);
    const bufA = useRef(null);
    const bufB = useRef(null);
    const visibleUrl = useRef(null);
    const pendingUrl = useRef(null);

    const refreshDriver = async () => {
        if (!api() || typeof api().invoke !== 'function') return;
        try {
            const res = await api().invoke('webcam:driver-status');
            setDriverDevices((res && res.devices) || []);
        } catch (e) {
            setDriverDevices([]);
        } finally {
            setDriverLoading(false);
        }
    };

    const refreshStream = async () => {
        if (!api() || typeof api().invoke !== 'function') return;
        try {
            const s = await api().invoke('webcam:status');
            setStream(s);
        } catch (e) { /* ignore */ }
    };

    useEffect(() => {
        refreshDriver();
        refreshStream();
        if (!api()) return undefined;
        const offStatus = api().onWebcamStatus
            ? api().onWebcamStatus((s) => {
                  setStream(s);
              })
            : null;
        const offDriver = api().onWebcamDriverStatus
            ? api().onWebcamDriverStatus((s) => setDriverDevices((s && s.devices) || []))
            : null;
        // Live preview: the main process pushes each decoded JPEG frame over
        // IPC. We load it into the hidden <img> as an in-memory object URL and
        // only make it visible once decoded — no disk reads, no URL reloads, so
        // the preview cannot flash or show half-loaded images.
        const offFrame = api().onWebcamFrame
            ? api().onWebcamFrame((bytes) => {
                  if (!(bytes && bytes.byteLength > 0)) return;
                  const hidden = activeBufRef.current === 0 ? bufB.current : bufA.current;
                  if (!hidden) return;
                  if (pendingUrl.current) {
                      URL.revokeObjectURL(pendingUrl.current);
                      pendingUrl.current = null;
                  }
                  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
                  const show = () => {
                      if (pendingUrl.current === url) pendingUrl.current = null;
                      if (visibleUrl.current) URL.revokeObjectURL(visibleUrl.current);
                      visibleUrl.current = url;
                      activeBufRef.current = 1 - activeBufRef.current;
                      setActiveBuf(activeBufRef.current);
                      setLive(true);
                  };
                  hidden.onload = show;
                  hidden.onerror = () => {
                      if (pendingUrl.current === url) pendingUrl.current = null;
                      URL.revokeObjectURL(url);
                  };
                  pendingUrl.current = url;
                  hidden.src = url;
              })
            : null;
        return () => {
            if (offStatus) offStatus();
            if (offDriver) offDriver();
            if (offFrame) offFrame();
            if (visibleUrl.current) URL.revokeObjectURL(visibleUrl.current);
            if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
        };
    }, []);

    const running = !!(stream && stream.running);
    const feedDown = running && stream && stream.feedUp === false;

    const installDriver = async () => {
        setInstalling(true);
        try {
            const res = await api().invoke('webcam:install-driver', { name: 'Phone Camera', devices: 1 });
            if (res && res.ok) {
                toast({ title: 'Virtual camera installed', description: 'Select "Phone Camera" in Teams, Zoom, OBS, etc.' });
            } else {
                toast({ title: 'Install failed', description: (res && res.error) || 'Unknown error' });
            }
        } catch (e) {
            toast({ title: 'Install failed', description: e.message });
        } finally {
            setInstalling(false);
            refreshDriver();
        }
    };

    const uninstallDriver = async () => {
        try {
            const res = await api().invoke('webcam:uninstall-driver');
            toast({ title: res && res.ok ? 'Virtual camera removed' : 'Uninstall failed', description: !res || res.ok ? undefined : res.error });
        } catch (e) {
            toast({ title: 'Uninstall failed', description: e.message });
        }
        refreshDriver();
    };

    const start = () => {
        if (source === 'usb') {
            api().send('webcam:start', { source: 'usb', res, fps });
        } else {
            api().send('webcam:start', { source: 'wifi', url: url.trim(), res, fps });
        }
    };

    const stop = () => {
        api().send('webcam:stop');
    };

    const toggleCamera = async () => {
        try {
            const res = await api().invoke('webcam:toggle-camera');
            if (res && res.ok) {
                toast({ title: 'Camera switched', description: 'Front / rear camera toggled on the phone.' });
            } else {
                toast({ title: 'Switch failed', description: (res && res.error) || 'Unknown error' });
            }
        } catch (e) {
            toast({ title: 'Switch failed', description: e.message });
        }
    };

    const snapshot = async () => {
        try {
            const res = await api().invoke('webcam:snapshot');
            if (res && res.ok) {
                setShots((s) => [{ id: Date.now(), path: res.path }, ...s].slice(0, 6));
                toast({ title: 'Snapshot saved', description: res.path });
            } else {
                toast({ title: 'Snapshot failed', description: (res && res.error) || 'No frame yet' });
            }
        } catch (e) {
            toast({ title: 'Snapshot failed', description: e.message });
        }
    };

    const hasDriver = driverDevices.length > 0;

    // No driver installed → install prompt.
    if (!driverLoading && !hasDriver) {
        return (
            <div className="flex h-full items-center justify-center">
                <EmptyState
                    icon={CameraOff}
                    tone="warning"
                    title="Virtual camera not installed"
                    description="Install the bundled UnityCapture driver so meeting apps can use your phone as a webcam. It registers a DirectShow capture device called “Phone Camera” (requires admin once)."
                    action={
                        <>
                            <Button variant="primary" onClick={installDriver} disabled={installing}>
                                {installing ? 'Installing…' : 'Install “Phone Camera”'}
                            </Button>
                            <Button variant="subtle" onClick={refreshDriver}>Check again</Button>
                        </>
                    }
                />
            </div>
        );
    }

    // Driver installed but not streaming → connection screen.
    if (!running) {
        return (
            <div className="flex h-full items-center justify-center">
                <EmptyState
                    icon={Zap}
                    title="Phone webcam is ready"
                    description={`In the DIY Phone Link app on ${deviceName}, tap “Start camera server”. Then pick how the PC connects and start the stream. The preview appears here; meeting apps see it as “Phone Camera”.`}
                    action={
                        <div className="flex w-full max-w-md flex-col items-center gap-3">
                            <div className="flex w-full items-center gap-1 rounded-lg border border-border bg-surface-2 p-1 text-[12.5px]">
                                {['wifi', 'usb'].map((s) => (
                                    <button
                                        key={s}
                                        onClick={() => setSource(s)}
                                        className={`flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${source === s ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                                    >
                                        {s === 'wifi' ? 'Wi-Fi' : 'USB (ADB)'}
                                    </button>
                                ))}
                            </div>
                            {source === 'wifi' ? (
                                <input
                                    value={url}
                                    onChange={(e) => setUrl(e.target.value)}
                                    placeholder={`http://<phone-ip>:8080/shot.jpg  (defaults to ${deviceName}’s address)`}
                                    className="h-9 w-full rounded-md border border-border bg-surface-2 px-3 text-[12.5px] outline-none focus:border-primary"
                                />
                            ) : (
                                <p className="w-full text-left text-[11.5px] text-muted-foreground">
                                    Connect the phone over USB, enable USB debugging, and leave the camera server running on it. The PC tunnels the stream with adb forward.
                                </p>
                            )}
                            <div className="flex w-full items-center justify-between gap-2">
                                <div className="flex flex-col gap-1">
                                    <div className="flex items-center gap-1 rounded-lg border border-border bg-surface-2 p-1 text-[12.5px]">
                                        {['720p', '1080p', '4K'].map((r) => (
                                            <button
                                                key={r}
                                                onClick={() => setRes(r)}
                                                className={`rounded-md px-3 py-1.5 font-medium transition-colors ${res === r ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                                            >
                                                {r}
                                            </button>
                                        ))}
                                    </div>
                                    <div className="flex items-center gap-1 rounded-lg border border-border bg-surface-2 p-1 text-[12.5px]">
                                        {[30, 60].map((f) => (
                                            <button
                                                key={f}
                                                onClick={() => setFps(f)}
                                                className={`rounded-md px-3 py-1.5 font-medium transition-colors ${fps === f ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                                            >
                                                {f} FPS
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="flex flex-col gap-2">
                                    <Button variant="primary" onClick={start}><Play className="h-4 w-4" /> Start stream</Button>
                                    <Button variant="subtle" onClick={uninstallDriver}><Trash2 className="h-4 w-4" /> Remove driver</Button>
                                </div>
                            </div>
                        </div>
                    }
                />
            </div>
        );
    }

    const statusBadge = feedDown
        ? <StatusBadge tone="danger">Feed unavailable</StatusBadge>
        : (stream.consumer ? <StatusBadge tone="success">Streaming {stream.fps} fps</StatusBadge> : <StatusBadge tone="warning">No app capturing</StatusBadge>);

    return (
        <div className="flex h-full">
            <div className="flex min-w-0 flex-1 flex-col p-5">
                <div className="mb-3 flex items-center gap-3">
                    <div>
                        <h2 className="text-[16px] font-semibold tracking-tight">Phone Camera</h2>
                        <p className="text-[12.5px] text-muted-foreground">
                            {stream.size ? `${stream.size.width} × ${stream.size.height}` : '…'} · {driverDevices.map((d) => d.Name).join(', ') || 'Phone Camera'}
                        </p>
                    </div>
                    {statusBadge}
                    <Button variant="ghost" className="ml-auto" onClick={stop}><Square className="h-4 w-4" /> Stop</Button>
                </div>

                <Panel className="relative flex flex-1 items-center justify-center overflow-hidden bg-[oklch(0.13_0.02_250)] p-0">
                    {running ? (
                        <div className="absolute inset-0">
                            <img
                                ref={bufA}
                                alt="Live phone camera"
                                decoding="async"
                                className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-75 ${activeBuf === 0 && live ? 'opacity-100' : 'opacity-0'}`}
                            />
                            <img
                                ref={bufB}
                                alt="Live phone camera"
                                decoding="async"
                                className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-75 ${activeBuf === 1 && live ? 'opacity-100' : 'opacity-0'}`}
                            />
                            {!live && (
                                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                                    <Camera className="h-8 w-8 animate-pulse" />
                                    <span className="text-[12px]">Waiting for the first frame…</span>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center gap-2 text-muted-foreground">
                            <Camera className="h-8 w-8 animate-pulse" />
                            <span className="text-[12px]">Waiting for the first frame…</span>
                        </div>
                    )}
                    {feedDown && (
                        <div className="absolute left-4 top-4 flex max-w-[70%] items-center gap-2 rounded-md bg-black/55 px-2.5 py-1.5 text-[11.5px] font-medium text-white backdrop-blur">
                            <WifiOff className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">Phone feed down — {stream.feedError || 'check the camera server in the DIY app'}</span>
                        </div>
                    )}
                    <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-5">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10 rounded-full bg-black/40 text-white hover:bg-black/60"
                            onClick={toggleCamera}
                            aria-label="Switch camera"
                            title="Switch front / rear camera on the phone"
                        >
                            <SwitchCamera className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10 rounded-full bg-black/40 text-white hover:bg-black/60"
                            onClick={snapshot}
                            aria-label="Snapshot"
                            title="Save current frame to Pictures"
                        >
                            <Download className="h-4 w-4" />
                        </Button>
                        <button
                            onClick={snapshot}
                            className="flex h-16 w-16 items-center justify-center rounded-full border-4 border-white/80 bg-white/20 backdrop-blur transition-transform active:scale-95"
                            aria-label="Capture snapshot"
                        >
                            <Circle className="h-9 w-9 fill-white text-white" />
                        </button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10 rounded-full bg-black/40 text-white hover:bg-black/60"
                            onClick={refreshStream}
                            aria-label="Refresh"
                        >
                            <RefreshCcw className="h-4 w-4" />
                        </Button>
                    </div>
                </Panel>
            </div>

            <aside className="hidden w-[262px] shrink-0 border-l border-border bg-surface p-4 lg:block">
                <SectionTitle title="Virtual camera" />
                <div className="mb-1.5 flex items-center justify-between text-[12px] text-muted-foreground">
                    <span>Installed devices</span>
                    <span className="font-medium text-foreground">{driverDevices.length}</span>
                </div>
                <ul className="mb-3 space-y-1.5">
                    {driverDevices.map((d) => (
                        <li key={d.Clsid} className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12px]">
                            <Camera className="h-3.5 w-3.5 text-primary" /> {d.Name}
                        </li>
                    ))}
                </ul>
                <Button variant="subtle" size="sm" className="w-full" onClick={installDriver} disabled={installing}>
                    <PlugZap className="h-3.5 w-3.5" /> {installing ? 'Installing…' : 'Repair driver'}
                </Button>
                <Button variant="ghost" size="sm" className="mt-1.5 w-full text-destructive" onClick={uninstallDriver}>
                    <Trash2 className="h-3.5 w-3.5" /> Remove driver
                </Button>

                <SectionTitle className="mt-5" title="Stream info" />
                <div className="space-y-2 text-[12px]">
                    <div className="flex justify-between"><span className="text-muted-foreground">Resolution</span><span className="font-medium">{stream.size ? `${stream.size.width} × ${stream.size.height}` : '…'}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">FPS</span><span className="font-medium">{stream.fps}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Frames sent</span><span className="font-medium">{stream.frames}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Consumer</span><span className="font-medium">{stream.consumer ? 'Yes' : 'No'}</span></div>
                </div>

                <SectionTitle className="mt-5" title="Snapshots" />
                {shots.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted-foreground">
                        <ImageIcon className="mx-auto mb-1.5 h-4 w-4" />
                        Snapshots are saved to Pictures
                    </div>
                ) : (
                    <div className="grid grid-cols-3 gap-1.5">
                        {shots.map((s) => (
                            <div key={s.id} className="aspect-square overflow-hidden rounded-md border border-border bg-surface-2">
                                <img src={`webcam-frame://latest?t=${s.id}`} alt="" className="h-full w-full object-cover" />
                            </div>
                        ))}
                    </div>
                )}
                <div className="mt-3 flex gap-2 text-[11.5px] text-muted-foreground">
                    <Video className="h-3.5 w-3.5" /> Meeting apps see “Phone Camera”
                </div>
            </aside>
        </div>
    );
}
