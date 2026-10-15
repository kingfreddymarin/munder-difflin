// A fixed-height panel for no-scroll screens: header, body that clips, optional footer action.
import * as React from 'react';
import { cn } from '@/lib/utils';

export function Tile({ title, hint, actions, children, className }: { title: React.ReactNode; hint?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('bg-card flex min-h-0 flex-col gap-2 overflow-hidden rounded-xl border p-3.5', className)}>
      <header className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint && <span className="text-muted-foreground truncate text-xs">{hint}</span>}
        <span className="ml-auto flex items-center gap-1">{actions}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">{children}</div>
    </section>
  );
}
