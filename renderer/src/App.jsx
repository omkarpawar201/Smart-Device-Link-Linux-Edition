import React, { useState } from 'react';
import { Loader2, PlugZap, Smartphone } from 'lucide-react';
import { useApp, NAV_KEYS } from './appStore';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import ToastStack from './components/ToastStack';
import { IncomingCallOverlay, ActiveCallPanel } from './components/CallOverlays';
import { Button, EmptyState, Modal, StatusBadge } from './ui-kit';

import HomePage from './pages/HomePage';
import ActivityPage from './pages/ActivityPage';
import NotificationsPage from './pages/NotificationsPage';
import MessagesPage from './pages/MessagesPage';
import CallsPage from './pages/CallsPage';
import ContactsPage from './pages/ContactsPage';
import PhotosPage from './pages/PhotosPage';
import FilesPage from './pages/FilesPage';
import ClipboardPage from './pages/ClipboardPage';
import AppsPage from './pages/AppsPage';
import MediaPage from './pages/MediaPage';
import CameraPage from './pages/CameraPage';
import ScreenPage from './pages/ScreenPage';
import AIPage from './pages/AIPage';
import SettingsPage from './pages/SettingsPage';

const meta = {
    home: { title: 'Home', subtitle: 'Overview of your connected phone' },
    activity: { title: 'Activity', subtitle: 'Unified phone and PC timeline' },
    notifications: { title: 'Notifications', subtitle: 'Mirrored from your phone' },
    messages: { title: 'Messages', subtitle: 'SMS and MMS from your desktop' },
    calls: { title: 'Calls', subtitle: 'Recent calls and dialling' },
    contacts: { title: 'Contacts', subtitle: 'Address book synced from your phone' },
    photos: { title: 'Photos', subtitle: 'Gallery mirrored from DCIM' },
    files: { title: 'Files', subtitle: 'Browse and transfer phone storage' },
    clipboard: { title: 'Clipboard', subtitle: 'Shared clipboard history' },
    apps: { title: 'Apps', subtitle: 'Installed Android applications' },
    media: { title: 'Media', subtitle: 'Playback control centre' },
    camera: { title: 'Camera', subtitle: 'Remote camera controller' },
    screen: { title: 'Phone Screen', subtitle: 'Live mirroring session' },
    ai: { title: 'AI Assistant', subtitle: 'Device intelligence for your phone' },
    settings: { title: 'Settings', subtitle: 'Configure LinkBridge' }
};

const pages = {
    home: HomePage,
    activity: ActivityPage,
    notifications: NotificationsPage,
    messages: MessagesPage,
    calls: CallsPage,
    contacts: ContactsPage,
    photos: PhotosPage,
    files: FilesPage,
    clipboard: ClipboardPage,
    apps: AppsPage,
    media: MediaPage,
    camera: CameraPage,
    screen: ScreenPage,
    ai: AIPage,
    settings: SettingsPage
};

export default function App() {
    const { route, connection, reconnect, setRoute, deviceName } = useApp();
    const [deviceSwitcher, setDeviceSwitcher] = useState(false);
    const Page = pages[route];
    const info = meta[route];
    const gated = connection !== 'connected' && route !== 'settings';

    return (
        <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
            <Sidebar onSwitchDevice={() => setDeviceSwitcher(true)} />

            <main className="flex min-w-0 flex-1 flex-col">
                <TopBar title={info.title} subtitle={info.subtitle} />
                <div className="min-h-0 flex-1">
                    {gated ? (
                        connection === 'connecting' ? (
                            <EmptyState
                                icon={Loader2}
                                tone="warning"
                                title="Connecting to your phone"
                                description={`Negotiating a secure channel with ${deviceName} over your local network. This usually takes a few seconds.`}
                            />
                        ) : (
                            <EmptyState
                                icon={PlugZap}
                                tone="danger"
                                title="Your phone isn't connected"
                                description="Make sure the phone link app is running on your Android phone and both devices are on the same network."
                                action={
                                    <>
                                        <Button variant="primary" onClick={reconnect}>Reconnect</Button>
                                        <Button variant="subtle" onClick={() => setRoute('settings')}>Open connection settings</Button>
                                    </>
                                }
                            />
                        )
                    ) : (
                        <Page />
                    )}
                </div>
            </main>

            <IncomingCallOverlay />
            <ActiveCallPanel />
            <ToastStack />

            <Modal
                open={deviceSwitcher}
                onClose={() => setDeviceSwitcher(false)}
                title="Switch device"
                description="Choose which paired phone LinkBridge should bridge to."
                footer={
                    <>
                        <Button variant="subtle" onClick={() => setDeviceSwitcher(false)}>Close</Button>
                        <Button variant="primary" onClick={() => { setDeviceSwitcher(false); setRoute('settings'); }}>Pair new device</Button>
                    </>
                }
            >
                <div className="space-y-2">
                    {NAV_KEYS.length && (
                        <button
                            onClick={() => setDeviceSwitcher(false)}
                            className="lb-focus flex w-full items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-left transition-colors hover:border-primary/50"
                        >
                            <div className="flex h-9 w-7 items-center justify-center rounded-md border border-border-strong bg-surface">
                                <Smartphone className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="text-[13px] font-medium">{deviceName}</div>
                                <div className="text-[11.5px] text-muted-foreground">Linked phone</div>
                            </div>
                            <StatusBadge tone={connection === 'connected' ? 'success' : 'neutral'}>
                                {connection === 'connected' ? 'Connected' : 'Disconnected'}
                            </StatusBadge>
                        </button>
                    )}
                </div>
            </Modal>
        </div>
    );
}
