// Owner request 2026-11-12: Settings shows where this floor lives and can change it. Change… opens
// the native folder dialog, then asks how: move this floor's agents and data there, or start a new
// floor there. Main's config:changeHome refuses the app's own data folder and a floor another app
// holds (.floor-lock), stops this floor's agents and relaunches. Reveal in Finder shows the folder.
// Open another floor… is New Floor… (Cmd+Shift+N): that floor runs in its own window. Switch floor…
// stops this floor's agents (they come back when it is opened again) and restarts at the picker.
import * as React from 'react';
import { Tile } from '@/components/app/tile';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { useDispatch, useFloor } from '@/data/store';
import { findBridge } from '@/data/bridge';
import { FloorViewSettings } from '@/app/floor-view-mode';
import { chooseFolder } from '@/app/folder-pick';

export function FloorLocationTile() {
  const dispatch = useDispatch();
  const floor = useFloor((s) => s.floorSetup?.floorLock?.state === 'open' ? s.floorSetup.floorLock.floor : null);
  const [target, setTarget] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [switching, setSwitching] = React.useState(false);

  const change = async () => {
    setMessage(null);
    const r = await chooseFolder(findBridge());
    if (r.kind === 'chosen') setTarget(r.path === floor ? null : r.path);
    else if (r.kind === 'failed') setMessage(r.message);
    else if (r.kind === 'unavailable') setMessage('The folder dialog is not available here.');
  };
  const apply = async (mode: 'move' | 'fresh') => {
    const bridge = findBridge();
    if (!target || !bridge?.changeHome) { setMessage('Changing the floor folder is not available here.'); return; }
    setBusy(true); setMessage(null);
    // Success relaunches the app and never returns; a return is a refusal or an error.
    const r = await bridge.changeHome(target, mode).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    setBusy(false);
    if (!r.ok) setMessage(r.error ?? 'The floor folder was not changed.');
  };
  const reveal = async () => {
    if (!floor) return;
    const r = await findBridge()?.revealPath?.(floor);
    if (r && !r.ok) setMessage(r.error ?? 'Could not show the folder.');
  };

  return <Tile title="Floor location" hint="where this floor's agents, tasks and memory live">
    <span className="text-muted-foreground break-all font-mono text-xs" data-testid="floor-location-path">{floor ?? 'No floor open'}</span>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={!floor || busy} onClick={() => void change()}>Change…</Button>
      <Button variant="ghost" size="sm" disabled={!floor} onClick={() => void reveal()}>Reveal in Finder</Button>
      <Button variant="ghost" size="sm" disabled={!floor} onClick={() => void dispatch({ type: 'floor.picker', open: true })}>Open another floor…</Button>
      <Button variant="ghost" size="sm" disabled={!floor || busy} onClick={() => setSwitching(true)}>Switch floor…</Button>
    </div>
    <FloorViewSettings />
    {switching && <div className="grid gap-2 rounded-md border p-3" data-testid="switch-floor-confirm">
      <span className="text-sm">Every agent on this floor stops. They start again when you open this floor again. Paramount then asks which floor to open. Floors in other windows keep running.</span>
      <div className="flex gap-2">
        <Button variant="destructive" disabled={busy} onClick={() => { setBusy(true); void dispatch({ type: 'floor.switch' }).finally(() => { setBusy(false); setSwitching(false); }); }}>Stop agents and switch</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setSwitching(false)}>Cancel</Button>
      </div>
    </div>}
    {target && <div className="grid gap-2 rounded-md border p-3" data-testid="floor-location-confirm">
      <span className="text-sm">New folder: <span className="break-all font-mono text-xs">{target}</span></span>
      <span className="text-muted-foreground text-xs">Every agent on this floor stops and Paramount restarts on the new folder. Moving copies the hive, memory and roster there; the old folder is kept until you remove it.</span>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void apply('move')}>{busy ? 'Working…' : 'Move this floor there'}</Button>
        <Button variant="outline" disabled={busy} onClick={() => void apply('fresh')}>Start a new floor there</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setTarget(null)}>Cancel</Button>
      </div>
    </div>}
    {message && <p className="text-destructive text-sm" role="alert">{message}</p>}
  </Tile>;
}
