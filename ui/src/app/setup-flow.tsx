// First-run setup (Munder parity). Shown instead of the app while the core reports
// no set-up floor. Nothing is written until Finish: closing the window mid-setup
// leaves the profile as it was, and the next launch starts here again.
import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Switch } from '@/components/animate-ui/components/radix/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useActionError, useDispatch, useFloor, useSnapshotRefresh } from '@/data/store';
import type { FloorSetup } from '@/data/types';

type Stage = 'workspace' | 'orchestrator';

export function SetupFlow({ setup }: { setup: FloorSetup }) {
  const dispatch = useDispatch();
  const { refresh } = useSnapshotRefresh();
  const { error, clear } = useActionError();
  const autoModeDefault = useFloor((s) => s.me.yolo.on);
  const [stage, setStage] = React.useState<Stage>('workspace');
  const [home, setHome] = React.useState(setup.suggestedHome);
  const firstReady = setup.engines.find((e) => e.orchestrator && e.installed);
  const [engineId, setEngineId] = React.useState(firstReady?.id ?? '');
  const [model, setModel] = React.useState('');
  const [autoMode, setAutoMode] = React.useState(autoModeDefault);
  const [busy, setBusy] = React.useState(false);
  const engine = setup.engines.find((e) => e.id === engineId);
  const homeOk = home.trim().startsWith('/');
  const canFinish = !!engine && engine.orchestrator && engine.installed && homeOk && !busy;

  const finish = async () => {
    if (!engine) return;
    setBusy(true);
    const ok = await dispatch({ type: 'setup.complete', home: home.trim(), engine: engine.id, ...(model ? { model } : {}), autoMode });
    setBusy(false);
    if (ok) refresh();
  };

  return (
    <div className="bg-background text-foreground flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-6" data-testid="setup-flow" data-stage={stage}>
        <div>
          <p className="text-muted-foreground text-xs">Step {stage === 'workspace' ? 1 : 2} of 2</p>
          <h1 className="text-xl font-semibold">{stage === 'workspace' ? 'Choose where this floor lives' : 'Choose the orchestrator'}</h1>
          <p className="text-muted-foreground text-sm">
            {stage === 'workspace'
              ? 'Agents, tasks, memory and logs for this floor are kept in this folder. Nothing is created until you finish.'
              : 'The orchestrator reads the floor mail and routes work to agents. It starts when you finish.'}
          </p>
        </div>

        {stage === 'workspace' && (
          <div className="space-y-2">
            <Label htmlFor="setup-home">Floor folder</Label>
            <Input id="setup-home" value={home} onChange={(e) => setHome(e.target.value)} spellCheck={false} />
            {!homeOk && <p className="text-destructive text-xs">Enter a full folder path, starting with /.</p>}
          </div>
        )}

        {stage === 'orchestrator' && (
          <div className="space-y-4">
            <div className="space-y-2" role="radiogroup" aria-label="Engine">
              {setup.engines.map((e) => {
                const reason = !e.orchestrator ? 'Can work as an agent, but cannot run the orchestrator' : !e.installed ? 'Not installed on this Mac' : null;
                return (
                  <label key={e.id} className={`flex items-center gap-3 rounded-md border p-3 text-sm ${reason ? 'opacity-60' : 'cursor-pointer'}`}>
                    <input type="radio" name="engine" value={e.id} checked={engineId === e.id} disabled={!!reason}
                      onChange={() => { setEngineId(e.id); setModel(''); }} />
                    <span className="flex-1">{e.label}</span>
                    {reason && <span className="text-muted-foreground text-xs">{reason}</span>}
                  </label>
                );
              })}
            </div>
            {!firstReady && (
              <p className="text-destructive text-sm">
                No orchestrator engine is installed. Install one (for example Claude Code), then
                <Button variant="link" size="sm" onClick={() => refresh()}>check again</Button>.
              </p>
            )}
            {engine && engine.models.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="setup-model">Model</Label>
                <select id="setup-model" className="bg-background w-full rounded-md border p-2 text-sm" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">Engine default</option>
                  {engine.models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            )}
            <div className="flex items-center gap-3">
              <span className="flex-1 text-sm">YOLO mode: agents act without asking for approval</span>
              <Switch checked={autoMode} onCheckedChange={setAutoMode} aria-label="YOLO mode" />
            </div>
          </div>
        )}

        {error && error.operation === 'setup.complete' && (
          <p className="text-destructive text-sm" role="alert">
            {error.message}{error.errorId ? ` (error ${error.errorId})` : ''}
            <Button variant="link" size="sm" onClick={clear}>Dismiss</Button>
          </p>
        )}

        <div className="flex justify-between">
          <Button variant="ghost" disabled={stage === 'workspace' || busy} onClick={() => setStage('workspace')}>Back</Button>
          {stage === 'workspace'
            ? <Button disabled={!homeOk} onClick={() => setStage('orchestrator')}>Continue</Button>
            : <Button disabled={!canFinish} onClick={() => void finish()}>{busy ? 'Setting up…' : 'Finish setup'}</Button>}
        </div>
      </div>
    </div>
  );
}
