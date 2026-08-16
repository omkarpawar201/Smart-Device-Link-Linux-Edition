import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, MessageSquare, RefreshCw, Send, User } from 'lucide-react';
import { Avatar, Button, EmptyState, Panel, SearchBar } from '../ui-kit';
import { useApp } from '../appStore';
import { clockTime } from '../lib/utils';

export default function MessagesPage() {
    const { deviceName, toast } = useApp();
    const [threads, setThreads] = useState([]);
    const [activeThreadId, setActiveThreadId] = useState(null);
    const [inputText, setInputText] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [isRefreshing, setIsRefreshing] = useState(false);
    const messagesEndRef = useRef(null);
    const activeThreadIdRef = useRef(null);

    const fetchThreads = () => {
        setIsRefreshing(true);
        if (window.api && typeof window.api.invoke === 'function') {
            const res = window.api.invoke('get-sms-threads');
            if (res && typeof res.then === 'function') {
                res.then((list) => {
                    if (Array.isArray(list)) setThreads(list);
                })
                    .catch(() => {})
                    .finally(() => setTimeout(() => setIsRefreshing(false), 750));
            }
        }
        if (window.api && window.api.send) {
            window.api.send('fetch-sms-threads');
        }
    };

    useEffect(() => {
        activeThreadIdRef.current = activeThreadId;
    }, [activeThreadId]);

    useEffect(() => {
        fetchThreads();
        if (window.api && window.api.onSmsThreadsUpdated) {
            window.api.onSmsThreadsUpdated((updatedThreads) => {
                if (Array.isArray(updatedThreads)) {
                    setThreads(updatedThreads);
                    if (!activeThreadIdRef.current && updatedThreads.length > 0) {
                        setActiveThreadId(updatedThreads[0].threadId);
                    }
                }
            });
        }
    }, []);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [activeThreadId, threads]);

    useEffect(() => {
        if (activeThreadId && window.api && window.api.send) {
            window.api.send('fetch-sms-thread-messages', { threadId: activeThreadId });
        }
    }, [activeThreadId]);

    const activeThread = threads.find((t) => t.threadId === activeThreadId) || threads[0];

    const handleSendMessage = () => {
        if (!inputText.trim() || !activeThread) return;
        const body = inputText.trim();
        const newMsg = { id: `msg_${Date.now()}`, threadId: activeThread.threadId, address: activeThread.address, body, date: Date.now(), type: 2 };
        if (window.api && window.api.send) {
            window.api.send('send-sms', { phoneNumber: activeThread.address, messageText: body });
        }
        setThreads((prev) =>
            prev.map((t) =>
                t.threadId === activeThread.threadId ? { ...t, lastMessage: body, lastDate: Date.now(), messages: [...(t.messages || []), newMsg] } : t
            )
        );
        setInputText('');
    };

    const filteredThreads = useMemo(
        () =>
            threads.filter(
                (t) =>
                    (t.contactName && t.contactName.toLowerCase().includes(searchQuery.toLowerCase())) ||
                    (t.address && t.address.includes(searchQuery)) ||
                    (t.lastMessage && t.lastMessage.toLowerCase().includes(searchQuery.toLowerCase()))
            ),
        [threads, searchQuery]
    );

    return (
        <div className="flex h-full gap-4 p-5">
            <Panel className="flex w-[320px] shrink-0 flex-col">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                    <h3 className="text-[15px] font-semibold">Messages</h3>
                    <Button size="sm" variant="ghost" onClick={fetchThreads} disabled={isRefreshing}>
                        <RefreshCw className={isRefreshing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                        {isRefreshing ? 'Syncing…' : 'Sync'}
                    </Button>
                </div>
                <div className="p-3">
                    <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search conversations…" />
                </div>
                <div className="lb-scroll flex-1 px-2 pb-2">
                    {filteredThreads.length === 0 ? (
                        <div className="px-3 py-8 text-center text-[12.5px] text-muted-foreground">
                            {threads.length === 0
                                ? 'No SMS conversations synced yet. Ensure SMS permission is enabled on your phone.'
                                : 'No matching conversations.'}
                        </div>
                    ) : (
                        filteredThreads.map((t) => {
                            const isActive = t.threadId === activeThreadId;
                            return (
                                <button
                                    key={t.threadId}
                                    onClick={() => setActiveThreadId(t.threadId)}
                                    className={`lb-focus mb-1 w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                                        isActive ? 'border-primary/40 bg-primary/10' : 'border-transparent hover:bg-surface-2'
                                    }`}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className={`truncate text-[13px] font-medium ${isActive ? 'text-primary' : ''}`}>
                                            {t.contactName || t.address}
                                        </span>
                                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{clockTime(t.lastDate)}</span>
                                    </div>
                                    <div className="truncate text-[12px] text-muted-foreground">{t.lastMessage}</div>
                                </button>
                            );
                        })
                    )}
                </div>
            </Panel>

            {activeThread ? (
                <Panel className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                        <Avatar name={activeThread.contactName || activeThread.address} size={36} />
                        <div className="min-w-0">
                            <div className="truncate text-[14px] font-semibold">{activeThread.contactName || activeThread.address}</div>
                            <div className="truncate text-[12px] text-muted-foreground">{activeThread.address}</div>
                        </div>
                    </div>

                    <div className="lb-scroll flex-1 space-y-3 p-4">
                        {(activeThread.messages || []).length === 0 && (
                            <div className="py-10 text-center text-[12.5px] text-muted-foreground">Loading conversation…</div>
                        )}
                        {(activeThread.messages || []).map((m) => {
                            const isOutgoing = m.type === 2;
                            return (
                                <div key={m.id} className={`flex ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
                                    <div className="max-w-[65%]">
                                        <div
                                            className={`rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed ${
                                                isOutgoing
                                                    ? 'rounded-br-md bg-primary text-primary-foreground'
                                                    : 'rounded-bl-md bg-surface-2 text-foreground'
                                            }`}
                                        >
                                            {m.body}
                                        </div>
                                        <div className={`mt-1 flex items-center gap-1 text-[10.5px] text-muted-foreground ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
                                            <span>{clockTime(m.date)}</span>
                                            {isOutgoing && <CheckCheck className="h-3 w-3 text-primary" />}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        <div ref={messagesEndRef} />
                    </div>

                    <div className="flex gap-2 border-t border-border p-3">
                        <input
                            value={inputText}
                            onChange={(e) => setInputText(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                            placeholder={`Send SMS to ${activeThread.contactName || activeThread.address}…`}
                            className="flex-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px] outline-none focus:border-primary"
                        />
                        <Button variant="primary" onClick={handleSendMessage}>
                            <Send className="h-4 w-4" /> Send
                        </Button>
                    </div>
                </Panel>
            ) : (
                <Panel className="flex flex-1 items-center justify-center">
                    <EmptyState
                        icon={MessageSquare}
                        title="Select a conversation"
                        description={`Pick a thread on the left to view and send messages to ${deviceName}.`}
                    />
                </Panel>
            )}
        </div>
    );
}
