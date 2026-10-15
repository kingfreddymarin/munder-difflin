// Every backend failure renders here: {errorId, code, message} plus a copy button, so a human can
// paste the exact failure into a ticket and find the matching `paramount-error` line in log.jsonl.
import { CopyButton } from '@/components/animate-ui/components/buttons/copy';
import { BackendError, toBackendError } from '@/data/errors';
import { cn } from '@/lib/utils';

export function ErrorNotice({ error, className, children }: { error: unknown; className?: string; children?: React.ReactNode }) {
  const failure = error instanceof BackendError ? error : toBackendError(error);
  const muted = failure.code === 'UNSUPPORTED';
  return (
    <div role={muted ? 'status' : 'alert'} data-error-id={failure.errorId} className={cn('flex items-start gap-3 rounded-lg border p-3 text-sm',
      muted ? 'border-amber-500/40 bg-amber-500/5' : 'border-destructive/50 bg-destructive/5', className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-mono text-xs text-muted-foreground">{failure.code} · {failure.errorId}{failure.operation ? ` · ${failure.operation}` : ''}</span>
        <span className="break-words">{failure.message}</span>
        {children}
      </div>
      <CopyButton content={JSON.stringify(failure.toJSON(), null, 2)} variant="ghost" size="sm" aria-label={`Copy error ${failure.errorId}`} />
    </div>
  );
}

/** The reason a control is disabled because the core cannot run it. */
export function UnsupportedReason({ reason, className }: { reason: string | null | undefined; className?: string }) {
  if (!reason) return null;
  return <span role="note" className={cn('text-xs text-amber-300', className)}>Unavailable: {reason}</span>;
}
