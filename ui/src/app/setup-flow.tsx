import { ExecutionPolicySelect, type ExecutionPolicy } from '@/features/settings/execution-policy';
import { LauncherSelect } from '@/features/team/launcher-select';
import type { CouncilLauncherPick } from '@/data/paramount-api';
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
import { defaultOrchestratorEngine } from './setup-defaults';
import { chooseFolder } from './folder-pick';
import { FloorRefused } from './floor-refused';
import { findBridge } from '@/data/bridge';
import { CustomizeRulesDialog } from '@/features/settings/floor-rules';

type Stage = 'workspace' | 'launchers' | 'orchestrator';

export function SetupFlow({ setup }: { setup: FloorSetup }) {
  const dispatch = useDispatch();
  const { refresh } = useSnapshotRefresh();
  const { error, clear } = useActionError();
  const autoModeDefault = useFloor((s) => s.me.yolo.on);
  const [stage, setStage] = React.useState<Stage>('workspace');
  const [home, setHome] = React.useState(setup.suggestedHome);
  const [engineId, setEngineId] = React.useState(defaultOrchestratorEngine(setup.engines));
  const [launcher, setLauncher] = React.useState<CouncilLauncherPick | null>(null);
  const [launcherDefaults, setLauncherDefaults] = React.useState<Record<string, CouncilLauncherPick | null>>({});
  const [tempLauncher, setTempLauncher] = React.useState<CouncilLauncherPick | null>(null);
  const [model, setModel] = React.useState('');
  const [autoMode, setAutoMode] = React.useState(autoModeDefault);
  const [codexExecutionPolicy, setExecutionPolicy] = React.useState<ExecutionPolicy>('inherit');
  const [busy, setBusy] = React.useState(false);
  const [pickError, setPickError] = React.useState<string | null>(null);
  // The folder Finish was refused for (another app holds its .floor-lock): show the refusal screen.
  const [refusedAt, setRefusedAt] = React.useState<string | null>(null);
  // NSC-255: optional floor rules, written with the floor at Finish. Skipping leaves only the Studio rules.
  const [rules, setRules] = React.useState<string[]>([]);
  const [rulesOpen, setRulesOpen] = React.useState(false);
  const engine = setup.engines.find((e) => e.id === engineId);
  const homeOk = home.trim().startsWith('/');
  const canFinish = !!engine && engine.orchestrator && engine.installed && homeOk && !busy;

  const finish = async () => {
    if (!engine) return;
    setBusy(true);
    const ok = await dispatch({ type: 'setup.complete', home: home.trim(), engine: engine.id, ...(model ? { model } : {}), launcher, launcherDefaults, tempLauncher, autoMode, codexExecutionPolicy, ...(rules.length ? { rules } : {}) });
    setBusy(false);
    refresh();
    setRefusedAt(ok ? null : home.trim());
  };

  const pickFolder = async () => {
    setPickError(null);
    const r = await chooseFolder(findBridge());
    if (r.kind === 'chosen') setHome(r.path);
    else if (r.kind === 'failed') setPickError(r.message);
    else if (r.kind === 'unavailable') setPickError('The folder dialog is not available here; type the full path instead.');
  };

  const lock = setup.floorLock;
  if (refusedAt && (lock?.state === 'refused' && lock.refusal.floor === refusedAt || lock?.state === 'error' && lock.floor === refusedAt)) {
    return <FloorRefused lock={lock} onRetry={finish} onChooseAnother={() => { clear(); setRefusedAt(null); setStage('workspace'); }} />;
  }

  return (
    <div className="bg-background text-foreground flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-6" data-testid="setup-flow" data-stage={stage}>
        <div>
          <p className="text-muted-foreground text-xs">Step {stage === 'workspace' ? 1 : stage === 'launchers' ? 2 : 3} of 3</p>
          <h1 className="text-xl font-semibold">{stage === 'workspace' ? 'Choose where this floor lives' : stage === 'launchers' ? 'Discover account launchers' : 'Choose the orchestrator'}</h1>
          <p className="text-muted-foreground text-sm">
            {stage === 'workspace'
              ? 'Agents, tasks, memory and logs for this floor are kept in this folder. Nothing is created until you finish.'
              : stage === 'launchers' ? 'Only aliases and functions found on this device appear. Choose account defaults for new agents and temps. Nothing is launched by discovery.' : 'The orchestrator reads the floor mail and routes work to agents. It starts when you finish.'}
          </p>
        </div>

        {stage === 'workspace' && (
          <div className="space-y-2">
            <Label htmlFor="setup-home">Floor folder</Label>
            <div className="flex gap-2">
              <Input id="setup-home" value={home} onChange={(e) => setHome(e.target.value)} spellCheck={false} />
              <Button type="button" variant="outline" onClick={() => void pickFolder()}>Choose folder…</Button>
            </div>
            {pickError && <p className="text-destructive text-xs">{pickError}</p>}
            {!homeOk && <p className="text-destructive text-xs">Enter a full folder path, starting with /.</p>}
          </div>
        )}

        {stage === 'launchers' && <div className="space-y-4">
          {['claude', 'codex'].map((provider) => <div key={provider} className="space-y-2">
            <h2 className="font-medium">{provider === 'claude' ? 'Claude' : 'Codex'} agent default</h2>
            <LauncherSelect discovery={setup.launchers} provider={provider} value={launcherDefaults[provider] ?? null} onChange={(pick) => setLauncherDefaults((current) => ({ ...current, [provider]: pick }))} />
          </div>)}
          <h2 className="font-medium">Temp default</h2>
          <LauncherSelect discovery={setup.launchers} value={tempLauncher} onChange={setTempLauncher} />
          <Button variant="outline" onClick={() => void dispatch({ type: 'launchers.refresh' })}>Refresh device discovery</Button>
        </div>}

        {stage === 'orchestrator' && (
          <div className="space-y-4">
            <div className="space-y-2" role="radiogroup" aria-label="Engine">
              {setup.engines.map((e) => {
                const reason = !e.orchestrator ? 'Can work as an agent, but cannot run the orchestrator' : !e.installed ? 'Not installed on this Mac' : null;
                return (
                  <label key={e.id} className={`flex items-center gap-3 rounded-md border p-3 text-sm ${reason ? 'opacity-60' : 'cursor-pointer'}`}>
                    <input type="radio" name="engine" value={e.id} checked={engineId === e.id} disabled={!!reason}
                      onChange={() => { setEngineId(e.id); setModel(''); setLauncher(launcherDefaults[e.id] ?? null); }} />
                    <span className="flex-1">{e.label}</span>
                    {reason && <span className="text-muted-foreground text-xs">{reason}</span>}
                  </label>
                );
              })}
            </div>
            {!setup.engines.some((e) => e.orchestrator && e.installed) && (
              <p className="text-destructive text-sm">
                No orchestrator engine is installed. Install one (for example Claude Code), then
                <Button variant="link" size="sm" onClick={() => refresh()}>check again</Button>.
              </p>
            )}
            <LauncherSelect discovery={setup.launchers} provider={engineId} value={launcher} onChange={setLauncher} />
            <Button variant="link" size="sm" onClick={() => void dispatch({ type: 'launchers.refresh' })}>Refresh launchers</Button>
            {engine && engine.models.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="setup-model">Model</Label>
                <select id="setup-model" className="bg-background w-full rounded-md border p-2 text-sm" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">Engine default</option>
                  {engine.models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            )}
            <ExecutionPolicySelect value={codexExecutionPolicy} onChange={setExecutionPolicy} />
            <div className="flex items-center gap-3">
              <span className="flex-1 text-sm">YOLO mode: agents act without asking for approval</span>
              <Switch checked={autoMode} onCheckedChange={setAutoMode} aria-label="YOLO mode" />
            </div>
            <div className="flex items-center gap-3">
              <span className="flex-1 text-sm">{rules.length ? `Floor rules: ${rules.length} added to the Studio rules` : 'Floor rules (optional): only the Studio rules apply'}</span>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setRulesOpen(true)}>Customize rules…</Button>
            </div>
            <CustomizeRulesDialog open={rulesOpen} onOpenChange={setRulesOpen} starters={setup.ruleStarters ?? []} value={rules} onSave={setRules} />
          </div>
        )}

        {error && error.operation === 'setup.complete' && (
          <p className="text-destructive text-sm" role="alert">
            {error.message}{error.errorId ? ` (error ${error.errorId})` : ''}
            <Button variant="link" size="sm" onClick={clear}>Dismiss</Button>
          </p>
        )}

        <div className="flex justify-between">
          <Button variant="ghost" disabled={stage === 'workspace' || busy} onClick={() => setStage(stage === 'orchestrator' ? 'launchers' : 'workspace')}>Back</Button>
          {stage !== 'orchestrator'
            ? <Button disabled={!homeOk} onClick={() => { if (stage === 'workspace') setStage('launchers'); else { setLauncher(launcherDefaults[engineId] ?? null); setStage('orchestrator'); } }}>Continue</Button>
            : <Button disabled={!canFinish} onClick={() => void finish()}>{busy ? 'Setting up…' : 'Finish setup'}</Button>}
        </div>
      </div>
    </div>
  );
}
