import React, { useEffect, useMemo, useState } from 'react';
import { Phone, RefreshCw, Search, Users } from 'lucide-react';
import { Avatar, Button, EmptyState, Panel, SearchBar } from '../ui-kit';
import { useApp } from '../appStore';

export default function ContactsPage() {
    const { toast, setRoute, startCall } = useApp();
    const [contacts, setContacts] = useState([]);
    const [query, setQuery] = useState('');
    const [syncing, setSyncing] = useState(false);

    const fetchContacts = () => {
        setSyncing(true);
        if (window.api && typeof window.api.invoke === 'function') {
            const res = window.api.invoke('get-contacts');
            if (res && typeof res.then === 'function') {
                res.then((list) => {
                    if (Array.isArray(list)) setContacts(list);
                })
                    .catch(() => {})
                    .finally(() => setTimeout(() => setSyncing(false), 750));
            }
        }
        if (window.api && window.api.send) window.api.send('fetch-contacts');
    };

    useEffect(() => {
        fetchContacts();
        if (window.api && window.api.onContactsUpdated) {
            window.api.onContactsUpdated((list) => {
                if (Array.isArray(list)) setContacts(list);
            });
        }
    }, []);

    const filtered = useMemo(
        () =>
            contacts.filter(
                (c) =>
                    (c.name && c.name.toLowerCase().includes(query.toLowerCase())) ||
                    (c.number && c.number.includes(query))
            ),
        [contacts, query]
    );

    const grouped = useMemo(() => {
        const map = new Map();
        filtered.forEach((c) => {
            const letter = (c.name || '#').trim().charAt(0).toUpperCase();
            if (!/^[A-Z]$/.test(letter)) {
                const key = '#';
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(c);
            } else {
                if (!map.has(letter)) map.set(letter, []);
                map.get(letter).push(c);
            }
        });
        return Array.from(map.entries()).sort((a, b) => (a[0] === '#' ? 1 : b[0] === '#' ? -1 : a[0].localeCompare(b[0])));
    }, [filtered]);

    return (
        <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2.5">
                <SearchBar value={query} onChange={setQuery} placeholder="Search contacts…" className="w-[280px]" />
                <Button className="ml-auto" variant="ghost" onClick={fetchContacts} disabled={syncing}>
                    <RefreshCw className={syncing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                    {syncing ? 'Syncing…' : 'Sync'}
                </Button>
            </div>

            <div className="lb-scroll flex-1 p-5">
                <div className="mx-auto max-w-[760px]">
                    {filtered.length === 0 ? (
                        <EmptyState
                            icon={Users}
                            title={contacts.length === 0 ? 'No contacts synced yet' : 'No matching contacts'}
                            description={
                                contacts.length === 0
                                    ? 'Enable contacts permission on your phone, then press Sync to pull the directory.'
                                    : 'Try a different search term.'
                            }
                        />
                    ) : (
                        grouped.map(([letter, group]) => (
                            <section key={letter} className="mb-4">
                                <h3 className="mb-1 px-1 text-[12px] font-semibold uppercase tracking-widest text-muted-foreground">{letter}</h3>
                                <Panel className="divide-y divide-border">
                                    {group.map((c) => (
                                        <div key={c.id ?? c.number} className="flex items-center gap-3 px-3.5 py-2.5">
                                            <Avatar name={c.name || c.number} size={36} />
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate text-[13.5px] font-medium">{c.name || c.number}</div>
                                                <div className="truncate text-[12px] tabular-nums text-muted-foreground">{c.number}</div>
                                            </div>
                                            <Button
                                                size="sm"
                                                variant="subtle"
                                                onClick={() => { startCall(c.number); toast({ title: 'Dialing', description: c.number }); }}
                                            >
                                                <Phone className="h-3.5 w-3.5" /> Call
                                            </Button>
                                            <Button size="sm" variant="ghost" onClick={() => setRoute('messages')}>
                                                Message
                                            </Button>
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
