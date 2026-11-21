// Every reference to something outside the app (GitHub PR or run, Azure DevOps build, PR or work item, a log)
// goes through ExternalLink. The click never navigates the app window: the provider asks the core to open the
// link in the default browser, and the core refuses anything off its allow-list with an errorId, shown here.
// OpenWith sends local paths through the desktop core.
import * as React from 'react';
import { ExternalLinkIcon, FolderOpenIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/animate-ui/components/radix/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/animate-ui/components/radix/dropdown-menu';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { ErrorNotice } from '@/components/app/error-notice';
import { BackendError, toBackendError } from '@/data/errors';
import type { ParamountOpenInApp } from '@/data/paramount-api';
import { useDispatch, useOpeners, useUnsupported } from '@/data/store';
import { cn } from '@/lib/utils';

/** Shows a failure next to the control that caused it; closing the popover clears it. */
function FailurePopover({ error, onClear, children }: { error: BackendError | null; onClear: () => void; children: React.ReactElement }) {
  return (
    <Popover open={!!error} onOpenChange={(open) => { if (!open) onClear(); }}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-2">{error && <ErrorNotice error={error} />}</PopoverContent>
    </Popover>
  );
}

export function ExternalLink({ href, children, className, title, icon = true }: {
  href: string;
  children?: React.ReactNode;
  className?: string;
  title?: string;
  /** Show the trailing "leaves the app" icon. */
  icon?: boolean;
}) {
  const { openExternal } = useOpeners();
  const [error, setError] = React.useState<BackendError | null>(null);
  const onClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // preventDefault also stops the popover trigger from toggling; it opens only on a failure.
    event.preventDefault();
    event.stopPropagation();
    if (!openExternal) {
      setError(BackendError.local('UNSUPPORTED', 'This build cannot open links.', 'shell.openExternal'));
      return;
    }
    setError(null);
    openExternal(href).catch((cause) => setError(toBackendError(cause, 'shell.openExternal')));
  };
  return (
    <FailurePopover error={error} onClear={() => setError(null)}>
      <a href={href} onClick={onClick} title={title ?? href} rel="noreferrer noopener"
        className={cn('inline-flex min-w-0 items-center gap-1 text-primary underline-offset-2 hover:underline', className)}>
        <span className="truncate">{children ?? href}</span>
        {icon && <ExternalLinkIcon aria-hidden className="size-3 shrink-0 opacity-70" />}
      </a>
    </FailurePopover>
  );
}

const OPEN_IN = [{ app: 'warp', label: 'Warp' }, { app: 'vscode', label: 'VS Code' }] as const;

export function OpenWith({ path, warpPath = path, cardKey }: { path?: string; warpPath?: string; cardKey?: string }) {
  const { openIn } = useOpeners();
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const [error, setError] = React.useState<BackendError | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function open(app: ParamountOpenInApp) {
    if (busy || !path) return;
    if (cardKey) {
      await dispatch({ type: 'card.open', key: cardKey, app });
      return;
    }
    const target = app === 'warp' ? warpPath : path;
    if (!target || !openIn) return;
    setError(null);
    setBusy(true);
    try { await openIn(app, target); }
    catch (cause) { setError(toBackendError(cause, 'shell.openIn')); }
    finally { setBusy(false); }
  }

  if (!path || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path)) return null;
  return (
    <div className="inline-flex shrink-0 flex-col items-start">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 gap-1 px-2 text-xs"
            disabled={busy || (!cardKey && !openIn)} title={path} aria-label={`Open with: ${path}`}>
            <FolderOpenIcon aria-hidden className="size-3.5" />Open with
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {OPEN_IN.map(({ app, label }) => {
            const reason = cardKey ? unsupported({ type: 'card.open', key: cardKey, app }) : undefined;
            return <DropdownMenuItem key={app} disabled={!!reason || (app === 'warp' && !warpPath)}
              title={reason ?? undefined} onSelect={() => void open(app)}>{label}</DropdownMenuItem>;
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <ErrorNotice error={error} className="mt-1 max-w-80" />}
    </div>
  );
}
