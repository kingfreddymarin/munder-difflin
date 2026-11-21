import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';

export function GraphHud({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: (restoreFocus: boolean) => void }) {
  const heading = React.useId();
  const close = React.useRef<HTMLButtonElement>(null);
  React.useLayoutEffect(() => { close.current?.focus({ preventScroll: true }); }, [title]);
  React.useEffect(() => {
    function dismiss(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose(true);
    }
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [onClose]);

  return (
    <section role="dialog" aria-labelledby={heading} className="bg-popover text-popover-foreground absolute inset-x-2 top-2 z-10 ml-auto flex max-h-[calc(100%-1rem)] w-auto flex-col overflow-auto overscroll-contain rounded-lg border p-4 shadow-lg sm:left-auto sm:w-80">
      <header className="mb-2 flex items-start justify-between gap-3">
        <h3 id={heading} className="min-w-0 break-words text-sm font-semibold">{title}</h3>
        <Button ref={close} size="icon-sm" variant="ghost" onClick={() => onClose(true)} aria-label="Close graph details">×</Button>
      </header>
      <div className="flex flex-col gap-2 break-words text-xs">{children}</div>
    </section>
  );
}
