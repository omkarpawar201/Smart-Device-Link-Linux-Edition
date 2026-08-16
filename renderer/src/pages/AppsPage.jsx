import React, { useMemo, useState } from 'react';
import { AppWindow, ExternalLink, Pin, Star } from 'lucide-react';
import { Button, EmptyState, Panel, SearchBar, SectionTitle, StatusBadge, Tabs } from '../ui-kit';
import { useApp } from '../appStore';

const seed = [
    { id: 'ap1', name: 'WhatsApp', color: '#25D366', initials: 'WA', favorite: true, category: 'Social' },
    { id: 'ap2', name: 'Instagram', color: '#E1306C', initials: 'IG', favorite: false, category: 'Social' },
    { id: 'ap3', name: 'YouTube', color: '#FF0033', initials: 'YT', favorite: true, category: 'Media' },
    { id: 'ap4', name: 'Chrome', color: '#1A73E8', initials: 'CH', favorite: false, category: 'Tools' },
    { id: 'ap5', name: 'Spotify', color: '#1DB954', initials: 'SP', favorite: true, category: 'Media' },
    { id: 'ap6', name: 'Telegram', color: '#2AABEE', initials: 'TG', favorite: false, category: 'Social' },
    { id: 'ap7', name: 'Gmail', color: '#EA4335', initials: 'GM', favorite: false, category: 'Productivity' },
    { id: 'ap8', name: 'Maps', color: '#34A853', initials: 'MP', favorite: false, category: 'Tools' },
    { id: 'ap9', name: 'Gallery', color: '#7C5CFF', initials: 'GA', favorite: false, category: 'Media' },
    { id: 'ap10', name: 'Settings', color: '#607D8B', initials: 'ST', favorite: false, category: 'System' },
    { id: 'ap11', name: 'Notion', color: '#3F3F3F', initials: 'NO', favorite: false, category: 'Productivity' },
    { id: 'ap12', name: 'Paytm', color: '#00BAF2', initials: 'PT', favorite: false, category: 'Finance' }
];

export default function AppsPage() {
    const { toast, deviceName } = useApp();
    const [list, setList] = useState(seed);
    const [tab, setTab] = useState('all');
    const [query, setQuery] = useState('');
    const [pinned, setPinned] = useState(['ap1', 'ap5']);

    const rows = useMemo(
        () =>
            list
                .filter((a) => (tab === 'favorites' ? a.favorite : tab === 'pinned' ? pinned.includes(a.id) : true))
                .filter((a) => (a.name + a.category).toLowerCase().includes(query.toLowerCase())),
        [list, tab, query, pinned]
    );

    return (
        <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
                <SearchBar value={query} onChange={setQuery} placeholder="Search installed apps" className="w-[250px]" />
                <Tabs
                    value={tab}
                    onChange={setTab}
                    tabs={[
                        { key: 'all', label: 'All apps', count: list.length },
                        { key: 'favorites', label: 'Favorites' },
                        { key: 'pinned', label: 'Pinned', count: pinned.length }
                    ]}
                />
                <StatusBadge tone="accent" className="ml-auto">App streaming ships with the mirroring backend</StatusBadge>
            </div>

            <div className="lb-scroll flex-1 p-5">
                {rows.length === 0 ? (
                    <EmptyState icon={AppWindow} title="No apps match" description="Try a different search term, or switch back to All apps." />
                ) : (
                    <div className="mx-auto max-w-[1180px]">
                        <SectionTitle title={`${rows.length} apps on ${deviceName}`} />
                        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
                            {rows.map((a) => (
                                <Panel key={a.id} className="group p-3 transition-all hover:-translate-y-px hover:border-primary/40">
                                    <div className="flex items-center gap-3">
                                        <div className="flex h-10 w-10 items-center justify-center rounded-[11px] text-[13px] font-bold text-white shadow-panel" style={{ background: a.color }}>
                                            {a.initials}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-[13px] font-semibold">{a.name}</div>
                                            <div className="text-[11.5px] text-muted-foreground">{a.category}</div>
                                        </div>
                                        <button onClick={() => setList((l) => l.map((x) => (x.id === a.id ? { ...x, favorite: !x.favorite } : x)))} aria-label="Favorite">
                                            <Star className={`h-3.5 w-3.5 ${a.favorite ? 'fill-warning text-warning' : 'text-muted-foreground'}`} />
                                        </button>
                                    </div>
                                    <div className="mt-2.5 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                                        <Button size="sm" variant="primary" className="flex-1 justify-center" onClick={() => toast({ title: `Opening ${a.name}`, description: `Launched on ${deviceName}.` })}>
                                            <ExternalLink className="h-3.5 w-3.5" /> Open on phone
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="subtle"
                                            onClick={() => {
                                                setPinned((p) => (p.includes(a.id) ? p.filter((x) => x !== a.id) : [...p, a.id]));
                                                toast({ title: pinned.includes(a.id) ? `${a.name} unpinned` : `${a.name} pinned to LinkBridge` });
                                            }}
                                        >
                                            <Pin className={`h-3.5 w-3.5 ${pinned.includes(a.id) ? 'fill-primary text-primary' : ''}`} />
                                        </Button>
                                    </div>
                                </Panel>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
