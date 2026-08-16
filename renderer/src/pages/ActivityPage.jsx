import React, { useEffect, useMemo, useState } from 'react';
import { Bell, ClipboardList, History, Phone, Trash2, RefreshCw } from 'lucide-react';
import { Button, EmptyState, Panel, SearchBar, Tabs } from '../ui-kit';
import { useApp } from '../appStore';
import { timeAgo, clockTime } from '../lib/utils';

const icons = {
    notification: Bell,
    clipboard: ClipboardList,
    call: Phone
};

function buildItems(notifications, callHistory, clips) {
    const items = [];
    notifications.forEach((n) => {
        items.push({
            id: `n-${n.id}`,
            kind: 'notification',
            time: n.time || Date.now(),
            title: n.appName || 'Notification',
            detail: n.title ? `${n.title} — ${n.text || ''}` : n.text || ''
        });
    });
    callHistory.forEach((c) => {
        items.push({
            id: `c-${c.id}`,
            kind: 'call',
            time: c.time || Date.now(),
            title: c.name || c.number || 'Unknown caller',
            detail: `${c.type} · ${c.number || '—'} · ${c.durationSecs ? `${Math.floor(c.durationSecs / 60)}m ${c.durationSecs % 60}s` : 'no answer'}`
        });
    });
    (clips || []).forEach((cb) => {
        items.push({
            id: `cb-${cb.id}`,
            kind: 'clipboard',
            time: cb.time || Date.now(),
            title: 'Clipboard',
            detail: cb.content && cb.content.length > 120 ? cb.content.slice(0, 120) + '…' : cb.content || ''
        });
    });
    return items.sort((a, b) => (b.time || 0) - (a.time || 0));
}

export default function ActivityPage() {
    const { toast, notifications, callHistory, clearCallHistory, clearAllNotifications } = useApp();
    const [clips, setClips] = useState([]);
    const [items, setItems] = useState(null);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState('all');

    const loadClips = () => {
        if (window.api && typeof window.api.invoke === 'function') {
            window.api.invoke('get-clipboard-history')
                .then((list) => {
                    if (Array.isArray(list)) setClips(list);
                })
                .catch(() => {});
        }
    };

    useEffect(() => {
        loadClips();
    }, []);

    const built = useMemo(() => buildItems(notifications, callHistory, clips), [notifications, callHistory, clips]);
    const list = items ?? built;

    const filtered = useMemo(
        () =>
            list.filter(
                (i) => (filter === 'all' || i.kind === filter) && (i.title + i.detail).toLowerCase().includes(query.toLowerCase())
            ),
        [list, filter, query]
    );

    const clearAll = () => {
        setItems([]);
        clearCallHistory();
        clearAllNotifications();
        setClips([]);
        if (window.api && window.api.send) window.api.send('clear-clipboard-history');
        toast({ title: 'Activity cleared', description: 'The local timeline history was removed.' });
    };

    return (
        <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
                <SearchBar value={query} onChange={setQuery} placeholder="Search activity" className="w-[260px]" />
                <Tabs
                    value={filter}
                    onChange={setFilter}
                    tabs={[
                        { key: 'all', label: 'All' },
                        { key: 'notification', label: 'Notifications' },
                        { key: 'clipboard', label: 'Clipboard' },
                        { key: 'call', label: 'Calls' }
                    ]}
                />
                <Button className="ml-auto" variant="ghost" onClick={() => { setItems(null); loadClips(); }}>
                    <RefreshCw className="h-4 w-4" /> Refresh
                </Button>
                <Button variant="ghost" onClick={clearAll}>
                    <Trash2 className="h-4 w-4" /> Clear activity
                </Button>
            </div>

            <div className="lb-scroll flex-1 p-5">
                <div className="mx-auto max-w-[900px]">
                    {filtered.length === 0 ? (
                        <EmptyState
                            icon={History}
                            title={list.length === 0 ? 'No activity recorded' : 'No matching activity'}
                            description={
                                list.length === 0
                                    ? 'LinkBridge logs every sync between your phone and this PC. New events appear here as they happen.'
                                    : 'Try a different search term or switch the filter.'
                            }
                        />
                    ) : (
                        <Panel className="p-1.5">
                            <div className="relative pl-[86px]">
                                <span className="absolute bottom-3 left-[78px] top-3 w-px bg-border" />
                                {filtered.map((a) => {
                                    const Icon = icons[a.kind];
                                    return (
                                        <div key={a.id} className="group relative flex items-start gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-surface-2">
                                            <span className="absolute left-[-86px] top-3.5 w-[62px] text-right text-[11.5px] tabular-nums text-muted-foreground">
                                                {timeAgo(a.time)}
                                            </span>
                                            <span className="absolute left-[-12px] top-[15px] flex h-[18px] w-[18px] items-center justify-center rounded-full border border-border bg-surface text-primary">
                                                <Icon className="h-2.5 w-2.5" />
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[13px] font-medium">{a.title}</span>
                                                    <span className="text-[11px] tabular-nums text-muted-foreground">{clockTime(a.time)}</span>
                                                </div>
                                                <div className="truncate text-[12.5px] text-muted-foreground">{a.detail}</div>
                                            </div>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="opacity-0 group-hover:opacity-100"
                                                onClick={() => setItems((l) => l.filter((x) => x.id !== a.id))}
                                            >
                                                Remove
                                            </Button>
                                        </div>
                                    );
                                })}
                            </div>
                        </Panel>
                    )}
                </div>
            </div>
        </div>
    );
}
