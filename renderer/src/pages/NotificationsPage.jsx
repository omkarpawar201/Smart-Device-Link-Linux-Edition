import React, { useEffect, useMemo, useState } from 'react';
import { Bell, BellOff, CheckCheck, Reply } from 'lucide-react';
import { Avatar, Button, EmptyState, Panel, SearchBar, StatusBadge } from '../ui-kit';
import { useApp } from '../appStore';
import { timeAgo } from '../lib/utils';

export default function NotificationsPage() {
    const { toast, notifications, refreshNotifications, dismissNotification, clearAllNotifications, replyToNotification } = useApp();
    const [query, setQuery] = useState('');
    const [replyOpen, setReplyOpen] = useState(null);
    const [replyText, setReplyText] = useState('');

    useEffect(() => {
        refreshNotifications();
    }, [refreshNotifications]);

    const groups = useMemo(() => {
        const filtered = notifications.filter(
            (n) => (n.appName + ' ' + (n.title || '') + ' ' + (n.text || '')).toLowerCase().includes(query.toLowerCase())
        );
        const map = new Map();
        filtered.forEach((n) => {
            const key = n.appName || n.packageName || 'Other';
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(n);
        });
        return Array.from(map.entries());
    }, [notifications, query]);

    const sendReply = (n) => {
        if (!replyText.trim()) return;
        replyToNotification(n.requestReplyId, replyText.trim());
        toast({ title: 'Reply sent', description: `Replied to ${n.appName}.` });
        setReplyOpen(null);
        setReplyText('');
    };

    return (
        <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
                <SearchBar value={query} onChange={setQuery} placeholder="Search notifications" className="w-[280px]" />
                <Button className="ml-auto" variant="ghost" onClick={() => { refreshNotifications(); toast({ title: 'Notifications refreshed' }); }}>
                    Refresh
                </Button>
                <Button variant="ghost" onClick={() => { clearAllNotifications(); toast({ title: 'All notifications dismissed' }); }}>
                    <CheckCheck className="h-4 w-4" /> Dismiss all
                </Button>
            </div>

            <div className="lb-scroll flex-1 p-5">
                <div className="mx-auto max-w-[860px] space-y-5">
                    {notifications.length === 0 && !query ? (
                        <EmptyState
                            icon={Bell}
                            title="No active notifications"
                            description="Phone notifications mirrored from your device appear here. Dismissed notifications stay in the activity log."
                        />
                    ) : groups.length === 0 ? (
                        <EmptyState icon={BellOff} title="No matching notifications" description="Try a different search term." />
                    ) : (
                        groups.map(([app, items]) => (
                            <section key={app}>
                                <div className="mb-2 flex items-center gap-2 px-1">
                                    <Avatar name={app} size={28} />
                                    <h3 className="text-[13.5px] font-semibold">{app}</h3>
                                    <StatusBadge tone="accent" className="ml-auto">{items.length}</StatusBadge>
                                </div>
                                <Panel className="divide-y divide-border">
                                    {items.map((n) => (
                                        <div key={n.id} className="group px-3.5 py-3">
                                            <div className="flex items-start gap-3">
                                                <Avatar name={n.appName || app} size={32} />
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <span className="truncate text-[13px] font-medium">{n.title || n.appName}</span>
                                                        <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">{timeAgo(n.time)}</span>
                                                    </div>
                                                    {n.text && <div className="mt-0.5 text-[12.5px] text-muted-foreground">{n.text}</div>}
                                                    {replyOpen === n.id ? (
                                                        <div className="mt-2 flex gap-2">
                                                            <input
                                                                autoFocus
                                                                value={replyText}
                                                                onChange={(e) => setReplyText(e.target.value)}
                                                                onKeyDown={(e) => e.key === 'Enter' && sendReply(n)}
                                                                placeholder={`Reply to ${n.appName}…`}
                                                                className="flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] outline-none focus:border-primary"
                                                            />
                                                            <Button size="sm" variant="primary" onClick={() => sendReply(n)}>Send</Button>
                                                            <Button size="sm" variant="ghost" onClick={() => setReplyOpen(null)}>Cancel</Button>
                                                        </div>
                                                    ) : (
                                                        <div className="mt-2 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                                                            {n.requestReplyId && (
                                                                <Button size="sm" variant="subtle" onClick={() => setReplyOpen(n.id)}>
                                                                    <Reply className="h-3.5 w-3.5" /> Reply
                                                                </Button>
                                                            )}
                                                            <Button size="sm" variant="ghost" onClick={() => { dismissNotification(n.id); toast({ title: 'Notification dismissed', app: n.appName }); }}>
                                                                Dismiss
                                                            </Button>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </Panel>
                            </section>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
