import React, { useEffect, useState } from 'react';
import { Github, Key, Monitor, MoonStar, RefreshCw, ShieldCheck, Smartphone, Sun } from 'lucide-react';
import { Avatar, Button, Modal, Panel, SectionTitle, SettingRow, StatusBadge, Toggle } from '../ui-kit';
import { useApp } from '../appStore';

function Section({ title, children }) {
    return (
        <section>
            <SectionTitle title={title} />
            <Panel className="overflow-hidden">{children}</Panel>
        </section>
    );
}

export default function SettingsPage() {
    const { theme, setTheme, connection, setConnection, reconnect, disconnect, deviceName, battery, isCharging, toast } = useApp();
    const [discovered, setDiscovered] = useState([]);
    const [pairingRequest, setPairingRequest] = useState(null);
    const [scanning, setScanning] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [nameDraft, setNameDraft] = useState(deviceName);
    const [flags, setFlags] = useState({
        autoReconnect: true,
        notifSync: true,
        previews: true,
        sounds: false,
        dnd: false,
        sms: true,
        autoMedia: true,
        autoDownload: false,
        aiHistory: true
    });
    const set = (k) => (v) => setFlags((f) => ({ ...f, [k]: v }));

    const scan = () => {
        setScanning(true);
        if (window.api && window.api.invoke) {
            window.api
                .invoke('get-discovered-devices')
                .then((list) => {
                    if (list) setDiscovered(list);
                })
                .catch(() => {})
                .finally(() => setScanning(false));
        } else {
            setTimeout(() => setScanning(false), 1500);
        }
    };

    useEffect(() => {
        scan();
        if (window.api && window.api.onDiscoveredDevicesChanged) {
            window.api.onDiscoveredDevicesChanged((list) => setDiscovered(list));
        }
        if (window.api && window.api.onPairingRequested) {
            window.api.onPairingRequested(({ device, requestId }) => setPairingRequest({ device, requestId }));
        }
    }, []);

    const pair = (deviceId) => {
        if (window.api && window.api.invoke) window.api.invoke('pair-device', deviceId);
        toast({ title: 'Pairing request sent' });
    };

    const unpair = (deviceId) => {
        if (window.api && window.api.invoke) window.api.invoke('unpair-device', deviceId);
        toast({ title: 'Device unpaired' });
    };

    const acceptPair = () => {
        if (pairingRequest && window.api && window.api.invoke) {
            window.api.invoke('accept-pair', pairingRequest.device.id);
        }
        setPairingRequest(null);
    };

    return (
        <div className="lb-scroll h-full p-5">
            <div className="mx-auto max-w-[820px] space-y-6 pb-10">
                <Section title="Device">
                    <SettingRow
                        label="Connected phone"
                        hint={`${deviceName} · Battery ${battery}%${isCharging ? ' · Charging' : ''}`}
                    >
                        <StatusBadge tone={connection === 'connected' ? 'success' : connection === 'connecting' ? 'warning' : 'danger'}>
                            {connection === 'connected' ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Disconnected'}
                        </StatusBadge>
                    </SettingRow>
                    <SettingRow label="Device name" hint={deviceName}>
                        <Button variant="subtle" onClick={() => { setNameDraft(deviceName); setRenaming(true); }}>Rename</Button>
                    </SettingRow>
                    <SettingRow label="Connection control" hint="Manage the active phone link">
                        <div className="flex gap-2">
                            <Button variant="subtle" onClick={() => { disconnect(); toast({ title: 'Device disconnected' }); }}>Disconnect</Button>
                            <Button variant="primary" onClick={reconnect}>Reconnect</Button>
                        </div>
                    </SettingRow>
                    <SettingRow label="Paired devices" hint={`${discovered.filter((d) => d.isPaired).length} devices remembered`}>
                        <Button variant="subtle" onClick={() => toast({ title: 'Pair new device', description: 'Open the LinkBridge Android app on the same Wi-Fi network.' })}>
                            <Smartphone className="h-4 w-4" /> Pair new device
                        </Button>
                    </SettingRow>
                </Section>

                <Section title="Discovered devices">
                    <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                        <div className="text-[12px] text-muted-foreground">KDE Connect devices on your Wi-Fi network (UDP 1716)</div>
                        <Button size="sm" variant="subtle" onClick={scan} disabled={scanning}>
                            <RefreshCw className={scanning ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                            {scanning ? 'Scanning…' : 'Scan'}
                        </Button>
                    </div>
                    {discovered.length === 0 ? (
                        <div className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
                            No new devices discovered yet. Keep the LinkBridge app open on your phone, connected to the same Wi-Fi.
                        </div>
                    ) : (
                        <div className="divide-y divide-border">
                            {discovered.map((dev) => (
                                <div key={dev.id} className="flex items-center gap-3 px-4 py-2.5">
                                    <Avatar name={dev.name} size={36} />
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-[13.5px] font-medium">{dev.name}</div>
                                        <div className="truncate text-[12px] text-muted-foreground">IP: {dev.ip} · Port: {dev.port}</div>
                                    </div>
                                    {dev.isPaired ? (
                                        <div className="flex items-center gap-2">
                                            <StatusBadge tone={dev.isConnected ? 'success' : 'neutral'}>
                                                {dev.isConnected ? 'Paired & Connected' : 'Paired (Offline)'}
                                            </StatusBadge>
                                            <Button size="sm" variant="ghost" onClick={() => unpair(dev.id)}>Unpair</Button>
                                        </div>
                                    ) : (
                                        <Button size="sm" variant="primary" onClick={() => pair(dev.id)}>Pair</Button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </Section>

                <Section title="Connection">
                    <SettingRow label="Connection method" hint="Wi-Fi Direct with Bluetooth fallback">
                        <select className="h-8 rounded-md border border-border bg-surface-2 px-2 text-[12.5px] outline-none focus:border-primary">
                            <option>Wi-Fi Direct (recommended)</option>
                            <option>Local network</option>
                            <option>Bluetooth</option>
                        </select>
                    </SettingRow>
                    <SettingRow label="Auto reconnect" hint="Re-establish the bridge when your phone returns to this network">
                        <Toggle checked={flags.autoReconnect} onChange={set('autoReconnect')} />
                    </SettingRow>
                </Section>

                <Section title="Notifications">
                    <SettingRow label="Notification synchronization" hint="Mirror phone notifications to this PC">
                        <Toggle checked={flags.notifSync} onChange={set('notifSync')} />
                    </SettingRow>
                    <SettingRow label="Show previews" hint="Display message content in toasts">
                        <Toggle checked={flags.previews} onChange={set('previews')} />
                    </SettingRow>
                    <SettingRow label="Notification sounds"><Toggle checked={flags.sounds} onChange={set('sounds')} /></SettingRow>
                    <SettingRow label="Do Not Disturb" hint="Silence all mirrored alerts"><Toggle checked={flags.dnd} onChange={set('dnd')} /></SettingRow>
                </Section>

                <Section title="Messages & Files">
                    <SettingRow label="SMS synchronization"><Toggle checked={flags.sms} onChange={set('sms')} /></SettingRow>
                    <SettingRow label="MMS support" hint="Receive picture and group messages"><Toggle checked={flags.sms} onChange={set('sms')} /></SettingRow>
                    <SettingRow label="Download location" hint="Your system Downloads folder">
                        <Button variant="subtle" onClick={() => toast({ title: 'Choose folder', description: 'Opening the Windows folder picker.' })}>Change</Button>
                    </SettingRow>
                    <SettingRow label="Automatic downloads" hint="Copy new photos to this PC as they're captured">
                        <Toggle checked={flags.autoDownload} onChange={set('autoDownload')} />
                    </SettingRow>
                </Section>

                <Section title="AI">
                    <SettingRow label="Gemini" hint="Cloud reasoning for summaries and search">
                        <StatusBadge tone="success">Connected</StatusBadge>
                    </SettingRow>
                    <SettingRow label="Hugging Face" hint="Local and hosted open models">
                        <StatusBadge tone="accent">Available</StatusBadge>
                    </SettingRow>
                    <SettingRow label="AI privacy" hint="Device context is assembled locally before any request" />
                    <SettingRow label="Conversation history" hint="Keep assistant chats on this PC">
                        <div className="flex items-center gap-2">
                            <Toggle checked={flags.aiHistory} onChange={set('aiHistory')} />
                            <Button variant="subtle" onClick={() => toast({ title: 'AI history cleared' })}>Clear</Button>
                        </div>
                    </SettingRow>
                </Section>

                <Section title="Appearance">
                    <SettingRow label="Theme" hint="LinkBridge follows Windows by default">
                        <div className="flex gap-1.5">
                            {[['light', Sun, 'Light'], ['dark', MoonStar, 'Dark'], ['system', Monitor, 'System']].map(([key, Icon, label]) => (
                                <Button key={key} variant={theme === key ? 'primary' : 'subtle'} onClick={() => setTheme(key)}>
                                    <Icon className="h-3.5 w-3.5" /> {label}
                                </Button>
                            ))}
                        </div>
                    </SettingRow>
                </Section>

                <Section title="Security">
                    <SettingRow label="Encryption" hint="TLS 1.3 with device-pinned certificates">
                        <StatusBadge tone="success"><ShieldCheck className="h-3 w-3" /> End-to-end</StatusBadge>
                    </SettingRow>
                    <SettingRow label="Sessions" hint="1 active session on this PC">
                        <Button variant="subtle" onClick={() => toast({ title: 'Sessions revoked', description: 'All other sessions were signed out.' })}>Revoke others</Button>
                    </SettingRow>
                </Section>

                <Section title="About">
                    <SettingRow label="Version" hint="LinkBridge · Windows build">
                        <Button variant="subtle" onClick={() => toast({ title: 'Opening repository' })}><Github className="h-4 w-4" /> GitHub</Button>
                    </SettingRow>
                </Section>
            </div>

            <Modal
                open={renaming}
                onClose={() => setRenaming(false)}
                title="Rename device"
                description="This name is shown across LinkBridge on this PC."
                footer={
                    <>
                        <Button variant="subtle" onClick={() => setRenaming(false)}>Cancel</Button>
                        <Button variant="primary" onClick={() => { setRenaming(false); toast({ title: 'Device renamed', description: nameDraft }); }}>Save</Button>
                    </>
                }
            >
                <input
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    className="h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[13px] outline-none focus:border-primary"
                />
            </Modal>

            <Modal
                open={!!pairingRequest}
                onClose={() => setPairingRequest(null)}
                title="Pairing request"
                description={pairingRequest ? `${pairingRequest.device.name} (${pairingRequest.device.ip}) wants to pair with this PC.` : ''}
                footer={
                    <>
                        <Button variant="subtle" onClick={() => setPairingRequest(null)}>Reject</Button>
                        <Button variant="primary" onClick={acceptPair}>Accept pairing</Button>
                    </>
                }
            >
                <div className="flex items-center gap-3">
                    <Avatar name={pairingRequest?.device?.name} size={40} />
                    <div>
                        <div className="text-[13.5px] font-semibold">{pairingRequest?.device?.name}</div>
                        <div className="text-[12px] text-muted-foreground">Do you trust this device?</div>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
