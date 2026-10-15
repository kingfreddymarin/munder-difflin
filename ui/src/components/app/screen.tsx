// Page root. Every screen scrolls: below `lg` it flows and the window scrolls; from `lg` up it fills the
// window down to a floor height, under which the window scrolls instead of squashing the panels. `fill`
// screens (chat, terminal, board) always fill the window so their input and columns stay in view, and
// scroll inside their panes. Panels (Tile) scroll their own overflow.
import * as React from 'react';
import { cn } from '@/lib/utils';

export function Screen({ fill, className, children }: { fill?: boolean; className?: string; children: React.ReactNode }) {
  return <div className={cn('flex flex-col gap-3', fill ? 'h-full min-h-[28rem]' : 'min-h-full lg:h-full lg:min-h-[36rem]', className)}>{children}</div>;
}
