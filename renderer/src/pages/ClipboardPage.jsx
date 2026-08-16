import React, { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, ClipboardCopy, Copy, RefreshCw, Send, Trash2 } from 'lucide-react';
import { Button, EmptyState, Panel, Toggle } from '../ui-kit';
import { useApp } from '../appStore';
import { timeAgo } from '../lib/utils';

export default function ClipboardPage() {
    const { toast } = useApp();
    const [history, setHistory] = useState([]);
    const [composer, setComposer] = useState('');
    const [autoSync, setAutoSync] = useState(true);
    const [copiedId, setCopiedId] = useState(null);
    const [expandedId, setExpandedId] = useState(null);
    const [isLoading, setIsLoading] = useState(false);

    const fetchHistory = () => {
        setIsLoading(true);
        if (window.api && typeof window.api.invoke === 'function') {
            window.api
                .invoke('get-clipboard-history')
                .then((list) => {
                    if (Array.isArray(list)) setHistory(list);
                })
                .catch(() => {})
                .finally(() => setTimeout(() => setIsLoading(false), 500));
        } else {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchHistory();
        if (window.api && window.api.invoke) {
            window.api
                .invoke('get-clipboard-auto-sync')
                .then((v) => setAutoSync(!!v))
                .catch(() => {});
        }
        if (window.api && window.api.onClipboardReceived) {
            window.api.onClipboardReceived((item) => {
                if (!item || !item.content) return;
                setHistory((prev) => [item, ...prev.filter((h) => h.id !== item.id)].slice(0, 50));
            });
        }
    }, []);

    const send = () => {
        const text = composer.trim();
        if (!text) return;
        if (window.api && window.api.send) window.api.send('send-clipboard', { content: text });
        toast({ title: 'Sent to phone', description: 'Clipboard content was sent to the device.' });
        setComposer('');
    };

    const toggleAutoSync = (val) => {
        setAutoSync(val);
        if (window.api && window.api.send) window.api.send('set-clipboard-auto-sync', { enabled: val });
    };

    const clear = () => {
        setHistory([]);
        if (window.api && window.api.send) window.api.send('clear-clipboard-history');
        toast({ title: 'Clipboard history cleared' });
    };

    const copy = (item) => {
        if (window.api && window.api.send) window.api.send('set-pc-clipboard', { content: item.content });
        setCopiedId(item.id);
        setTimeout(() => setCopiedId(null), 1200);
    };

    const sendToPhone = (item) => {
        if (window.api && window.api.send) window.api.send('send-clipboard', { content: item.content });
        toast({ title: 'Sent to phone' });
    };

    const remove = (id) => {
        setHistory((prev) => prev.filter((h) => h.id !== id));
        if (window.api && window.api.send) window.api.send('remove-clipboard-item', { id });
    };

    return (
        <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-5 py-2.5">
                <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                    <span>Auto-sync</span>
                    <Toggle checked={autoSync} onChange={toggleAutoSync} />
                </div>
                <Button className="ml-auto" variant="ghost" onClick={fetchHistory} disabled={isLoading}>
                    <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                    Refresh
                </Button>
                <Button variant="ghost" onClick={clear}>
                    <Trash2 className="h-4 w-4" /> Clear
                </Button>
            </div>

            <div className="lb-scroll flex-1 p-5">
                <div className="mx-auto max-w-[760px] space-y-4">
                    <Panel className="p-3.5">
                        <div className="flex items-center gap-2">
                            <input
                                value={composer}
                                onChange={(e) => setComposer(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && send()}
                                placeholder="Type or paste text, then send it to the phone's clipboard…"
                                className="flex-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px] outline-none focus:border-primary"
                            />
                            <Button variant="primary" onClick={send} disabled={!composer.trim()}>
                                <Send className="h-4 w-4" /> Send
                            </Button>
                        </div>
                    </Panel>

                    {history.length === 0 ? (
                        <EmptyState
                            icon={ClipboardCopy}
                            title="No clipboard items"
                            description="Copy something on your phone with the phone link app, or send text above to start a history."
                        />
                    ) : (
                        <div className="space-y-2">
                            {history.map((item) => {
                                const isExpanded = expandedId === item.id;
                                return (
                                    <Panel key={item.id} className="p-3.5">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[11.5px] tabular-nums text-muted-foreground">{timeAgo(item.time)}</span>
                                            <span className="ml-auto flex items-center gap-2">
                                                <Button size="sm" variant="ghost" onClick={() => sendToPhone(item)} aria-label="Send to phone">
                                                    <ArrowUpRight className="h-4 w-4" />
                                                </Button>
                                                <Button size="sm" variant="ghost" onClick={() => copy(item)} aria-label="Copy to PC">
                                                    {copiedId === item.id ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                                                </Button>
                                                <Button size="sm" variant="ghost" onClick={() => remove(item.id)} aria-label="Remove">
                                                    <Trash2 className="h-4 w-4 text-destructive" />
                                                </Button>
                                            </span>
                                        </div>
                                        <button
                                            onClick={() => setExpandedId(isExpanded ? null : item.id)}
                                            className="mt-1 w-full text-left"
                                        >
                                            <p className={`whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground ${isExpanded ? '' : 'line-clamp-2'}`}>
                                                {item.content}
                                            </p>
                                        </button>
                                    </Panel>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
