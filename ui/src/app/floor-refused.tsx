// Shown instead of the app when another app already has this floor open (Munder's .floor-lock).
// Council never opens a floor another live process holds: nothing on it is read or written
// until that app quits. The human can check again, or go back to setup and choose another floor.
import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { useActionError, useDispatch } from '@/data/store';
import type { FloorLockState } from '@/data/types';

export function FloorRefused({ lock }: { lock: Extract<FloorLockState, { state: 'refused' | 'error' }> }) {
  const dispatch = useDispatch();
  const { error, clear } = useActionError();
  const [busy, setBusy] = React.useState(false);
  const run = async (type: 'floor.retry' | 'floor.choose-another') => { setBusy(true); clear(); await dispatch({ type }); setBusy(false); };
  const refused = lock.state === 'refused' ? lock.refusal : null;
  return (
    <div className="bg-background text-foreground flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-5" data-testid="floor-refused" role="alert">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">{refused ? 'This floor is open in another app' : 'This floor could not be opened'}</h1>
          {refused ? (
            <>
              <p className="text-sm"><strong>{refused.owner}</strong> (process {refused.pid}{refused.since ? `, since ${new Date(refused.since).toLocaleString()}` : ''}) has <span className="font-mono">{refused.floor}</span> open.</p>
              <p className="text-muted-foreground text-sm">One app runs a floor at a time. Paramount has not read or changed anything on this floor. Quit {refused.owner}, then check again, or choose another floor.</p>
            </>
          ) : (
            lock.state === 'error' && <p className="text-sm">The floor lock could not be written at <span className="font-mono">{lock.floor}</span>: {lock.detail}</p>
          )}
        </div>
        {error && (error.operation === 'floor.retry' || error.operation === 'floor.choose-another') && (
          <p className="text-destructive text-sm">{error.message}{error.errorId ? ` (error ${error.errorId})` : ''}</p>
        )}
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => void run('floor.retry')}>Check again</Button>
          <Button variant="outline" disabled={busy} onClick={() => void run('floor.choose-another')}>Choose another floor</Button>
        </div>
      </div>
    </div>
  );
}
