import { ExecutionPolicySelect, type ExecutionPolicy } from '@/features/settings/execution-policy';
// The floor picker (owner requests 2026-11-12, Munder 0.5.7 parity). At launch nothing is open:
// recent floors are listed with their state (free, held by another app, missing), the last one is
// preselected and Enter opens it in this window. With a floor open, New Floor… (Cmd+Shift+N) shows
// the same list and the chosen floor starts as its own app process, so several floors run at once.
// 'Choose folder…' uses the native folder dialog (main's dialog:chooseFolder). A floor another app
// holds shows the refusal screen at launch; nothing on it is touched.
import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { useActionError, useDispatch, useSnapshotRefresh, useFloor } from '@/data/store';
import type { FloorChoice, FloorLockState } from '@/data/types';
import { chooseFolder } from './folder-pick';
import { FloorRefused } from './floor-refused';
import { createEnterGuard, type EnterGuard } from './enter-guard';
import { findBridge } from '@/data/bridge';

type Recent = FloorChoice['recents'][number];
const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/** Rows that can be opened: free floors, and (at launch) held ones, which show the refusal screen. */
export function canOpen(r: Recent, launch: boolean): boolean {
  return r.state === 'free' || (launch && r.state === 'held');
}
/** The row selected when the picker opens: the last floor if it can be opened, else the first that can. */
export function initialFloor(choice: FloorChoice): string | null {
  const usable = choice.recents.filter((r) => canOpen(r, choice.pending));
  return usable.find((r) => r.path === choice.last)?.path ?? usable.find((r) => r.state === 'free')?.path ?? null;
}
export function stateLabel(r: Recent): string {
  switch (r.state) {
    case 'free': return '';
    case 'current': return 'open in this window';
    case 'held': return `open in ${r.heldBy ?? 'another app'}`;
    case 'missing': return 'folder not found';
    case 'data-folder': return "the app's own data folder; not a floor";
  }
}

export function FloorChooser({ choice, lock }: { choice: FloorChoice; lock?: FloorLockState }) {
  const dispatch = useDispatch();
  const { refresh } = useSnapshotRefresh();
  const { error, clear } = useActionError();
  const savedPolicy = useFloor(s => String(s.settings?.codexExecutionPolicy ?? 'inherit'));
  const [policy, setPolicy] = React.useState<ExecutionPolicy | null>(null);
  const launch = choice.pending;
  const [selected, setSelected] = React.useState<string | null>(initialFloor(choice));
  const [busy, setBusy] = React.useState(false);
  const [enterGuard] = React.useState<EnterGuard>(createEnterGuard());
  const [pickError, setPickError] = React.useState<string | null>(null);
  // The folder a launch open was refused for (another app holds its .floor-lock): the refusal screen.
  const [refusedAt, setRefusedAt] = React.useState<string | null>(null);
  const usable = choice.recents.filter((r) => canOpen(r, launch));

  const open = async (home: string) => {
    setBusy(true); clear(); setPickError(null);
    if (policy !== null && !await dispatch({ type: 'settings.update', patch: { codexExecutionPolicy: policy } })) { setBusy(false); return; }
    const ok = await dispatch({ type: 'floor.open', home });
    setBusy(false);
    refresh();
    setRefusedAt(ok || !launch ? null : home);
  };

  const browse = async () => {
    setPickError(null);
    const r = await chooseFolder(findBridge());
    if (r.kind === 'chosen') { setSelected(r.path); await open(r.path); }
    else if (r.kind === 'failed') setPickError(r.message);
    else if (r.kind === 'unavailable') setPickError('The folder dialog is not available here.');
  };

  const onKeyDown = (e: { key: string; repeat?: boolean; preventDefault(): void }) => {
    if (busy) return;
    const i = usable.findIndex((r) => r.path === selected);
    if (e.key === 'Enter' && selected) { e.preventDefault(); if (enterGuard.allows(e)) void open(selected); }
    else if (e.key === 'Escape' && !launch) { e.preventDefault(); void dispatch({ type: 'floor.picker', open: false }); }
    else if (e.key === 'ArrowDown' && usable.length) { e.preventDefault(); setSelected(usable[Math.min(i + 1, usable.length - 1)].path); }
    else if (e.key === 'ArrowUp' && usable.length) { e.preventDefault(); setSelected(usable[Math.max(i - 1, 0)].path); }
  };

  if (launch && refusedAt && (lock?.state === 'refused' && lock.refusal.floor === refusedAt || lock?.state === 'error' && lock.floor === refusedAt)) {
    return <FloorRefused lock={lock} onRetry={() => open(refusedAt)} onChooseAnother={() => { clear(); setRefusedAt(null); }} />;
  }

  return (
    <div className={`bg-background text-foreground flex min-h-screen items-center justify-center p-6 ${launch ? '' : 'fixed inset-0 z-40'}`}>
      <div className="w-full max-w-xl space-y-5" data-testid="floor-chooser" data-mode={launch ? 'launch' : 'new-floor'}>
        <div>
          <h1 className="text-xl font-semibold">{launch ? 'Open a floor' : 'New floor'}</h1>
          <p className="text-muted-foreground text-sm">
            {launch
              ? 'Each floor keeps its own agents, tasks, memory and logs. Nothing starts until you open one.'
              : 'The floor you choose opens in its own window and runs alongside this one.'}
          </p>
        </div>
        {choice.recents.length > 0 && (
          <div role="listbox" aria-label="Recent floors" tabIndex={0} autoFocus onFocus={() => enterGuard.focused()} onKeyDown={onKeyDown} className="divide-y rounded-lg border outline-none focus-visible:ring-2" data-testid="floor-recents">
            {choice.recents.map((r) => {
              const ok = canOpen(r, launch);
              const label = stateLabel(r);
              return (
                <div key={r.path} role="option" aria-selected={r.path === selected} aria-disabled={!ok} data-testid="floor-recent" data-path={r.path} data-state={r.state}
                  onClick={() => ok && !busy && setSelected(r.path)} onDoubleClick={() => ok && !busy && void open(r.path)}
                  className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm ${r.path === selected ? 'bg-accent' : ''} ${ok ? '' : 'cursor-not-allowed opacity-50'}`}>
                  <div className="min-w-0">
                    <p className="font-medium">{folderName(r.path)}{launch && r.path === choice.last ? <span className="text-muted-foreground ml-2 text-xs">last used</span> : null}</p>
                    <p className="text-muted-foreground truncate font-mono text-xs">{r.path}</p>
                  </div>
                  {label && <span className="text-muted-foreground shrink-0 text-xs" data-testid="floor-state">{label}</span>}
                </div>
              );
            })}
          </div>
        )}
        <ExecutionPolicySelect value={policy ?? savedPolicy} onChange={setPolicy} />
        {error && error.operation === 'settings.update' && <p role="alert" className="text-destructive text-sm">{error.message}</p>}
        {pickError && <p className="text-destructive text-sm">{pickError}</p>}
        {error && error.operation === 'floor.open' && <p className="text-destructive text-sm">{error.message}{error.errorId ? ` (error ${error.errorId})` : ''}</p>}
        <div className="flex gap-2">
          <Button disabled={busy || !selected} onClick={() => selected && void open(selected)}>{busy ? 'Opening…' : launch ? 'Open' : 'Open in a new window'}</Button>
          <Button variant="outline" disabled={busy} onClick={() => void browse()}>Choose folder…</Button>
          {!launch && <Button variant="ghost" disabled={busy} onClick={() => void dispatch({ type: 'floor.picker', open: false })}>Cancel</Button>}
        </div>
      </div>
    </div>
  );
}
