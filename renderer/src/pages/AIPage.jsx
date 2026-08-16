import React, { useRef, useState } from 'react';
import { Bot, Download, ExternalLink, FileText, Send, Share2, Sparkles, User } from 'lucide-react';
import { Button, Panel, SectionTitle, StatusBadge } from '../ui-kit';
import { useApp } from '../appStore';
import { timeAgo } from '../lib/utils';

function answerFor(prompt, ctx) {
    const p = prompt.toLowerCase();
    const { notifications, callHistory, contacts } = ctx;

    if (p.includes('summarize') || p.includes('notifications')) {
        const apps = {};
        notifications.slice(0, 12).forEach((n) => {
            const key = n.appName || 'Other';
            apps[key] = (apps[key] || 0) + 1;
        });
        const lines = Object.entries(apps)
            .slice(0, 5)
            .map(([app, count]) => `- **${app}**: ${count} notification${count > 1 ? 's' : ''}`)
            .join('\n');
        return {
            text: notifications.length === 0
                ? 'There are **no active notifications** right now.'
                : `I can see **${notifications.length} active notifications** on your phone:\n\n${lines}`
        };
    }

    if (p.includes('reply')) {
        const replyable = notifications.filter((n) => n.requestReplyId);
        if (replyable.length === 0) return { text: 'No messages need a reply right now — nothing actionable in the notification stream.' };
        return {
            text: `You have **${replyable.length}** notification${replyable.length > 1 ? 's' : ''} that support quick replies:\n\n${replyable
                .slice(0, 5)
                .map((n) => `- **${n.appName}** — “${n.text}” (${timeAgo(n.time)})`)
                .join('\n')}\n\nOpen the **Notifications** page and press **Reply** to respond.`
        };
    }

    if (p.includes('invoice') || p.includes('pdf') || p.includes('file')) {
        const files = ['Invoice_August.pdf', 'Payment_Receipt.pdf', 'Rent_agreement.pdf'];
        return {
            text: `Found **${files.length} matching files** in phone storage:`,
            results: [
                { name: 'Invoice_August.pdf', meta: 'Documents', size: '2.4 MB', path: '/storage/Documents/Invoice_August.pdf' },
                { name: 'Payment_Receipt.pdf', meta: 'Documents', size: '1.2 MB', path: '/storage/Documents/Payment_Receipt.pdf' },
                { name: 'Rent_agreement.pdf', meta: 'Documents', size: '5.6 MB', path: '/storage/Documents/Rent_agreement.pdf' }
            ]
        };
    }

    if (p.includes('photo') || p.includes('image')) {
        return {
            text: 'I indexed the photos synced from your phone. Open the **Photos** page to browse them, or search by date. OCR-based photo search is available through the mirroring backend.'
        };
    }

    if (p.includes('today') || p.includes('happened')) {
        const recent = callHistory.slice(0, 3);
        const parts = [];
        parts.push(`**${notifications.length}** notifications are currently active.`);
        parts.push(
            recent.length
                ? `Recent calls: ${recent.map((c) => `${c.name || c.number} (${c.type})`).join(', ')}.`
                : 'No calls recorded today.'
        );
        parts.push(`You have **${contacts.length}** contacts synced.`);
        return { text: `Here's what happened on your phone today:\n\n${parts.join('\n')}` };
    }

    if (p.includes('contact') || p.includes('call')) {
        return {
            text: callHistory.length
                ? `Most recent call: **${callHistory[0].name || callHistory[0].number}** (${callHistory[0].type}, ${timeAgo(callHistory[0].time)}).`
                : 'No call history yet. Make a call from the **Calls** page and I can help summarize it.'
        };
    }

    return {
        text: `I'm connected to your phone and can read notifications, messages, files, photos and device state. Try one of the suggestions below.`
    };
}

export default function AIPage() {
    const { toast, notifications, callHistory } = useApp();
    const [messages, setMessages] = useState([
        {
            id: 'seed',
            role: 'assistant',
            text: 'I can read notifications, messages, files, photos and device state from your phone. Ask me anything, or pick a suggestion below.'
        }
    ]);
    const [input, setInput] = useState('');
    const [thinking, setThinking] = useState(false);
    const endRef = useRef(null);

    const suggestions = [
        'Summarize my notifications',
        'What messages need a reply?',
        'Find the invoice Rahul sent me',
        'Show photos containing documents',
        'What happened on my phone today?'
    ];

    const ask = async (prompt) => {
        if (!prompt.trim()) return;
        setMessages((m) => [...m, { id: `u-${Date.now()}`, role: 'user', text: prompt }]);
        setInput('');
        setThinking(true);
        await new Promise((r) => setTimeout(r, 650));
        const reply = { id: `a-${Date.now()}`, role: 'assistant', ...answerFor(prompt, { notifications, callHistory }) };
        setMessages((m) => [...m, reply]);
        setThinking(false);
        setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 40);
    };

    return (
        <div className="flex h-full">
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-3 border-b border-border bg-surface px-5 py-2.5">
                    <div>
                        <h2 className="text-[15px] font-semibold tracking-tight">AI Assistant</h2>
                        <p className="text-[12px] text-muted-foreground">Understand and control your connected phone.</p>
                    </div>
                    <StatusBadge tone="accent" className="ml-auto">On-device context · {notifications.length} notifications indexed</StatusBadge>
                </div>

                <div className="lb-scroll flex-1 px-6 py-5">
                    <div className="mx-auto max-w-[760px] space-y-4">
                        {messages.map((m) => (
                            <div key={m.id} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : ''}`}>
                                {m.role === 'assistant' && (
                                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-accent text-primary">
                                        <Bot className="h-3.5 w-3.5" />
                                    </div>
                                )}
                                <div className={`max-w-[76%] ${m.role === 'user' ? 'order-1' : ''}`}>
                                    <div
                                        className={`whitespace-pre-line rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed shadow-panel ${
                                            m.role === 'user' ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-tl-sm border border-border bg-surface'
                                        }`}
                                    >
                                        {m.text.split('**').map((chunk, i) => (i % 2 ? <strong key={i}>{chunk}</strong> : chunk))}
                                    </div>
                                    {m.results && (
                                        <div className="mt-2 space-y-1.5">
                                            {m.results.map((r) => (
                                                <Panel key={r.name} className="group flex items-center gap-3 p-2.5">
                                                    <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface-2 text-primary">
                                                        <FileText className="h-4 w-4" />
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="truncate text-[12.5px] font-medium">{r.name}</div>
                                                        <div className="text-[11.5px] text-muted-foreground">{r.meta} · {r.size}</div>
                                                    </div>
                                                    <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                                                        <Button size="sm" variant="subtle" onClick={() => toast({ title: 'Opening', description: r.name })}>
                                                            <ExternalLink className="h-3.5 w-3.5" /> Open
                                                        </Button>
                                                        <Button size="sm" variant="ghost" onClick={() => toast({ title: 'Download started', description: r.name })}>
                                                            <Download className="h-3.5 w-3.5" />
                                                        </Button>
                                                        <Button size="sm" variant="ghost" onClick={() => toast({ title: 'Share sheet opened' })}>
                                                            <Share2 className="h-3.5 w-3.5" />
                                                        </Button>
                                                    </div>
                                                </Panel>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                {m.role === 'user' && (
                                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-muted-foreground">
                                        <User className="h-3.5 w-3.5" />
                                    </div>
                                )}
                            </div>
                        ))}
                        {thinking && (
                            <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                                <Sparkles className="h-3.5 w-3.5 animate-pulse text-primary" /> Reading device context…
                            </div>
                        )}
                        <div ref={endRef} />
                    </div>
                </div>

                <div className="shrink-0 border-t border-border bg-surface px-5 py-3">
                    <div className="mx-auto max-w-[760px]">
                        <div className="mb-2 flex flex-wrap gap-1.5">
                            {suggestions.map((s) => (
                                <button
                                    key={s}
                                    onClick={() => ask(s)}
                                    className="lb-focus rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 focus-within:border-primary/60">
                            <Sparkles className="h-4 w-4 text-primary" />
                            <input
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && ask(input)}
                                placeholder="Ask about your messages, files, photos, notifications or device…"
                                className="min-w-0 flex-1 bg-transparent py-1 text-[13px] outline-none placeholder:text-muted-foreground"
                            />
                            <Button variant="primary" size="icon" onClick={() => ask(input)} aria-label="Send"><Send className="h-4 w-4" /></Button>
                        </div>
                    </div>
                </div>
            </div>

            <aside className="hidden w-[252px] shrink-0 border-l border-border bg-surface p-4 xl:block">
                <SectionTitle title="Model status" />
                <Panel className="divide-y divide-border">
                    <div className="flex items-center justify-between px-3 py-2.5">
                        <span className="text-[12.5px] font-medium">Gemini</span>
                        <StatusBadge tone="success">Connected</StatusBadge>
                    </div>
                    <div className="flex items-center justify-between px-3 py-2.5">
                        <span className="text-[12.5px] font-medium">Hugging Face</span>
                        <StatusBadge tone="accent">Available</StatusBadge>
                    </div>
                    <div className="flex items-center justify-between px-3 py-2.5">
                        <span className="text-[12.5px] font-medium">On-device OCR</span>
                        <StatusBadge tone="success">Ready</StatusBadge>
                    </div>
                </Panel>

                <SectionTitle className="mt-5" title="Capabilities" />
                <div className="space-y-1.5">
                    {['Notification summaries', 'Smart replies', 'OCR on photos', 'Natural language file search', 'Photo content search', 'Device questions'].map((c) => (
                        <div key={c} className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12px]">
                            <Sparkles className="h-3.5 w-3.5 text-primary" /> {c}
                        </div>
                    ))}
                </div>

                <p className="mt-4 text-[11.5px] leading-relaxed text-muted-foreground">
                    Device context is assembled locally. Only the text you send is passed to the selected model, and history can be cleared from Settings.
                </p>
            </aside>
        </div>
    );
}
