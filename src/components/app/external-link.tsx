// Every reference to something outside the app (GitHub PR or run, Azure DevOps build, PR or work item, a log)
// goes through ExternalLink. The click never navigates the app window: the provider asks the core to open the
// link in the default browser, and the core refuses anything off its allow-list with an errorId, shown here.
// OpenInButtons does the same for a folder: Warp or VS Code, via the core, never a shell string.
import * as React from 'react';
import { ExternalLinkIcon, FolderCodeIcon, TerminalSquareIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/animate-ui/components/radix/popover';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { ErrorNotice } from '@/components/app/error-notice';
import { BackendError, toBackendError } from '@/data/errors';
import type { ParamountOpenInApp } from '@/data/paramount-api';
import { useOpeners } from '@/data/store';
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

const OPEN_IN: { app: ParamountOpenInApp; label: string; Icon: typeof TerminalSquareIcon }[] = [
  { app: 'warp', label: 'Open in Warp', Icon: TerminalSquareIcon },
  { app: 'vscode', label: 'Open in VS Code', Icon: FolderCodeIcon },
];

/** "Open in Warp" / "Open in VS Code" for an absolute folder the core checks exists. */
export function OpenInButtons({ path, className }: { path: string; className?: string }) {
  const { openIn } = useOpeners();
  const [error, setError] = React.useState<BackendError | null>(null);
  const [busy, setBusy] = React.useState<ParamountOpenInApp | null>(null);
  const open = (app: ParamountOpenInApp) => {
    if (!openIn) return;
    setError(null);
    setBusy(app);
    openIn(app, path).catch((cause) => setError(toBackendError(cause, 'shell.openIn'))).finally(() => setBusy(null));
  };
  return (
    <FailurePopover error={error} onClear={() => setError(null)}>
      <span className={cn('inline-flex items-center gap-1', className)}>
        {OPEN_IN.map(({ app, label, Icon }) => (
          <Button key={app} type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs"
            disabled={!openIn || busy !== null} aria-label={`${label}: ${path}`}
            title={openIn ? `${label}: ${path}` : 'Opening folders needs the desktop core; sample data has none.'}
            onClick={(event) => { event.preventDefault(); open(app); }}>
            <Icon aria-hidden className="size-3.5" />{label}
          </Button>
        ))}
      </span>
    </FailurePopover>
  );
}
