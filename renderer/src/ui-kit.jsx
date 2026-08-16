import React, { useEffect } from 'react';
import { Search, X } from 'lucide-react';
import { cn, initials } from './lib/utils';

const buttonVariants = {
    primary: 'bg-primary text-primary-foreground hover:brightness-110 active:brightness-95',
    subtle: 'bg-secondary text-secondary-foreground hover:bg-muted border border-border',
    outline: 'border border-border-strong text-foreground hover:bg-secondary',
    ghost: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
    danger: 'bg-destructive text-destructive-foreground hover:brightness-110',
    success: 'bg-success text-success-foreground hover:brightness-110'
};

const buttonSizes = {
    sm: 'h-7 px-2.5 text-[12px] gap-1.5',
    md: 'h-8 px-3 text-[13px] gap-2',
    icon: 'h-8 w-8 justify-center',
    'icon-sm': 'h-7 w-7 justify-center'
};

export function Button({ variant = 'subtle', size = 'md', className, children, ...rest }) {
    return (
        <button
            className={cn(
                'lb-focus inline-flex items-center rounded-md font-medium transition-all duration-150 disabled:pointer-events-none disabled:opacity-50',
                buttonVariants[variant],
                buttonSizes[size],
                className
            )}
            {...rest}
        >
            {children}
        </button>
    );
}

export function Panel({ className, children }) {
    return <div className={cn('lb-panel', className)}>{children}</div>;
}

export function SectionTitle({ title, action, className }) {
    return (
        <div className={cn('mb-2.5 flex items-center justify-between', className)}>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</h2>
            {action}
        </div>
    );
}

const badgeTones = {
    success: 'bg-success/12 text-success border-success/25',
    warning: 'bg-warning/15 text-warning border-warning/30',
    danger: 'bg-destructive/12 text-destructive border-destructive/25',
    accent: 'bg-accent text-accent-foreground border-primary/20',
    neutral: 'bg-secondary text-muted-foreground border-border'
};

const badgeDots = {
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-destructive',
    accent: 'bg-primary',
    neutral: 'bg-muted-foreground'
};

export function StatusBadge({ tone = 'neutral', children, dot = true, className }) {
    return (
        <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium', badgeTones[tone], className)}>
            {dot && <span className={cn('h-1.5 w-1.5 rounded-full', badgeDots[tone])} />}
            {children}
        </span>
    );
}

export function SearchBar({ value, onChange, placeholder = 'Search', className }) {
    return (
        <div className={cn('flex h-8 items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 transition-colors focus-within:border-primary/60', className)}>
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            />
            {value && (
                <button onClick={() => onChange('')} className="text-muted-foreground hover:text-foreground" aria-label="Clear search">
                    <X className="h-3.5 w-3.5" />
                </button>
            )}
        </div>
    );
}

export function Tabs({ tabs, value, onChange, className }) {
    return (
        <div className={cn('flex items-center gap-1 rounded-lg border border-border bg-surface-2 p-0.5', className)}>
            {tabs.map((t) => (
                <button
                    key={t.key}
                    onClick={() => onChange(t.key)}
                    className={cn(
                        'lb-focus rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                        value === t.key ? 'bg-surface text-foreground shadow-panel' : 'text-muted-foreground hover:text-foreground'
                    )}
                >
                    {t.label}
                    {t.count !== undefined && <span className="ml-1.5 text-[11px] text-muted-foreground">{t.count}</span>}
                </button>
            ))}
        </div>
    );
}

export function EmptyState({ icon: Icon, title, description, action, tone = 'neutral' }) {
    return (
        <div className="flex h-full min-h-[280px] flex-col items-center justify-center px-8 text-center">
            <div
                className={cn(
                    'mb-4 flex h-12 w-12 items-center justify-center rounded-xl border',
                    tone === 'neutral' && 'border-border bg-surface-2 text-muted-foreground',
                    tone === 'warning' && 'border-warning/30 bg-warning/10 text-warning',
                    tone === 'danger' && 'border-destructive/30 bg-destructive/10 text-destructive'
                )}
            >
                <Icon className="h-5 w-5" />
            </div>
            <h3 className="text-[15px] font-semibold">{title}</h3>
            <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted-foreground">{description}</p>
            {action && <div className="mt-4 flex gap-2">{action}</div>}
        </div>
    );
}

export function Modal({ open, onClose, title, description, children, footer, width = 'max-w-md' }) {
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => e.key === 'Escape' && onClose();
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <div className="absolute inset-0 bg-[oklch(0.15_0.02_250_/_0.45)] backdrop-blur-[2px]" onClick={onClose} />
            <div className={cn('relative w-full animate-in fade-in zoom-in-95 rounded-xl border border-border-strong bg-popover shadow-float duration-150', width)}>
                <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3.5">
                    <div>
                        <h3 className="text-[14px] font-semibold">{title}</h3>
                        {description && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>}
                    </div>
                    <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
                        <X className="h-4 w-4" />
                    </Button>
                </div>
                {children && <div className="px-5 py-4 text-[13px]">{children}</div>}
                {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
            </div>
        </div>
    );
}

export function Avatar({ name, size = 36, color, className }) {
    return (
        <div
            className={cn('flex shrink-0 items-center justify-center rounded-full border border-border font-semibold', className)}
            style={{
                width: size,
                height: size,
                fontSize: size * 0.36,
                background: color || 'color-mix(in oklab, var(--color-primary) 16%, var(--color-surface-2))',
                color: color ? '#fff' : 'var(--color-foreground)'
            }}
        >
            {initials(name)}
        </div>
    );
}

export function SettingRow({ label, hint, children }) {
    return (
        <div className="flex items-center justify-between gap-6 border-b border-border px-4 py-3 last:border-b-0">
            <div className="min-w-0">
                <div className="text-[13px] font-medium">{label}</div>
                {hint && <div className="mt-0.5 text-[12px] text-muted-foreground">{hint}</div>}
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    );
}

export function Toggle({ checked, onChange, label }) {
    return (
        <button
            role="switch"
            aria-checked={checked}
            aria-label={label ?? 'Toggle'}
            onClick={() => onChange(!checked)}
            className={cn(
                'lb-focus relative h-5 w-9 rounded-full border transition-colors',
                checked ? 'border-primary bg-primary' : 'border-border-strong bg-secondary'
            )}
        >
            <span
                className={cn(
                    'absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all',
                    checked ? 'left-[18px] bg-primary-foreground' : 'left-0.5 bg-muted-foreground'
                )}
            />
        </button>
    );
}

export function Progress({ value, className }) {
    return (
        <div className={cn('h-1 w-full overflow-hidden rounded-full bg-secondary', className)}>
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${value}%` }} />
        </div>
    );
}
