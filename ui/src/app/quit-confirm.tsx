// Munder's quit warning: with agents running, main defers Cmd-Q / closing the window and asks
// here. Without this listener Council could not be quit while any agent ran, so the floor lock
// was never released cleanly. "Stop agents and quit" runs main's teardown (agents running now
// are restored on the next launch); Cancel keeps everything running.
import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { findBridge } from '@/data/bridge';

export function QuitConfirm() {
  const [ask, setAsk] = React.useState<{ ptyCount: number; sideAgentCount?: number } | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => findBridge()?.onCloseRequested?.((info) => setAsk(info)), []);
  if (!ask) return null;
  const cancel = () => { void findBridge()?.cancelClose?.(); setAsk(null); };
  const quit = async () => { setBusy(true); await findBridge()?.confirmClose?.(); };
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6" onClick={busy ? undefined : cancel}>
      <div role="alertdialog" aria-labelledby="quit-title" data-testid="quit-confirm" className="bg-card w-full max-w-md space-y-4 rounded-xl border p-5" onClick={(e) => e.stopPropagation()}>
        <h2 id="quit-title" className="text-lg font-semibold">Quit Paramount?</h2>
        {ask.ptyCount > 0 && <p className="text-sm">{ask.ptyCount} floor agent terminal{ask.ptyCount === 1 ? ' is' : 's are'} running. The floor agents resume the next time Paramount opens this floor.</p>}
        {!!ask.sideAgentCount && <p className="text-sm">{ask.sideAgentCount === 1 ? 'The temporary side agent ends' : 'The temporary side agents end'} when Paramount quits.</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={cancel}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void quit()}>{busy ? 'Quitting…' : 'Stop agents and quit'}</Button>
        </div>
      </div>
    </div>
  );
}
