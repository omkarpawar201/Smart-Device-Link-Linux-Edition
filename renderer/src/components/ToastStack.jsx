import React from 'react';
import { X } from 'lucide-react';
import { useApp } from '../appStore';
import { Button } from '../ui-kit';

export default function ToastStack() {
    const { toasts, dismissToast } = useApp();
    return (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-[70] flex w-[340px] -translate-x-1/2 flex-col gap-2">
            {toasts.map((t) => (
                <div
                    key={t.id}
                    className="pointer-events-auto animate-in fade-in slide-in-from-bottom-2 rounded-lg border border-border-strong bg-popover p-3 shadow-float"
                >
                    <div className="flex items-start gap-2.5">
                        {t.app && (
                            <span className="mt-0.5 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {t.app}
                            </span>
                        )}
                        <div className="min-w-0 flex-1">
                            <div className="text-[13px] font-semibold leading-tight">{t.title}</div>
                            {t.description && (
                                <div className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">{t.description}</div>
                            )}
                        </div>
                        <button onClick={() => dismissToast(t.id)} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                    {t.actions && (
                        <div className="mt-2.5 flex gap-2">
                            {t.actions.map((a) => (
                                <Button
                                    key={a.label}
                                    size="sm"
                                    variant="subtle"
                                    onClick={() => {
                                        a.onClick?.();
                                        dismissToast(t.id);
                                    }}
                                >
                                    {a.label}
                                </Button>
                            ))}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}
