import { canSwitchAgent, currentSwitchModel, switchLauncherSeed } from './agent-switch';
import { launcherPick } from '@/lib/launcher-fit';
import { OpenWith } from '@/components/app/external-link';
import * as React from 'react';
import { Switch } from '@/components/animate-ui/components/radix/switch';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/animate-ui/components/radix/toggle-group';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { accent } from '@/components/app/status';
import { ErrorNotice, UnsupportedReason } from '@/components/app/error-notice';
import { ModelSelect } from '@/features/team/hire-sheet';
import { LauncherSelect } from '@/features/team/launcher-select';
import { useDispatch, useFloor, useTeamApi, useUnsupported } from '@/data/store';
import { toBackendError, type BackendError } from '@/data/errors';
import type { ParamountTeamModels } from '@/data/paramount-api';
import type { Agent } from '@/data/types';
import { cn } from '@/lib/utils';

// Choices offered for tone and autonomy when the provider stores them (the sample data does; the core does not yet).
const tones = ['Concise', 'Detailed', 'Friendly', 'Formal'];
const autonomies = ['Read only', 'Ask for merges', 'Ask for anything risky', 'Full within budget'];

type Form = Pick<Agent, 'name' | 'color' | 'tokensCap' | 'yolo'> & { persona: string; tone: string; autonomy: string };
const formOf = (a: Agent): Form => ({ name: a.name, color: a.color, tokensCap: a.tokensCap, persona: a.persona ?? '', tone: a.tone ?? '', autonomy: a.autonomy ?? '', yolo: !!a.yolo });

export function useAgentProfile(agentId: string | null) {
  const agent = useFloor((s) => s.agents.find((a) => a.id === agentId));
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const teamApi = useTeamApi();
  const [form, setForm] = React.useState<Form | null>(null);
  const [models, setModels] = React.useState<ParamountTeamModels | null>(null);
  const [model, setModel] = React.useState('');
  const [modelsError, setModelsError] = React.useState<BackendError | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [restartMessage, setRestartMessage] = React.useState('');
  const [switchProvider, setSwitchProvider] = React.useState('');
  const [switchModel, setSwitchModel] = React.useState('');
  const [switchLauncher, setSwitchLauncher] = React.useState<import('@/data/paramount-api').CouncilLauncherPick | null>(null);
  const [switchMessage, setSwitchMessage] = React.useState('');
  const [switchChosen, setSwitchChosen] = React.useState(false);
  const [switching, setSwitching] = React.useState(false);
  React.useEffect(() => { setForm(agent ? formOf(agent) : null); }, [agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const modelRequest = React.useRef(0);
  const loadModels = React.useCallback(() => {
    if (!teamApi || !agentId) return;
    const request = ++modelRequest.current;
    setModelsError(null);
    teamApi.models().then((m) => {
      if (request !== modelRequest.current) return;
      setModels(m); setModel(m.agents[agentId]?.model ?? '');
      const current = m.agents[agentId]?.running?.provider ?? m.agents[agentId]?.engine;
      const next = m.engines.find((entry) => entry.id === current) ?? m.engines[0];
      setSwitchProvider(next?.id ?? ''); setSwitchModel(currentSwitchModel(m.agents[agentId]) ?? '');
      setSwitchLauncher(switchLauncherSeed(m.agents[agentId])); setSwitchChosen(false);
    }, (cause) => { if (request === modelRequest.current) setModelsError(toBackendError(cause, 'team.models')); });
  }, [teamApi, agentId]);
  React.useEffect(() => { setModels(null); setModel(''); setSwitchChosen(false); setSwitching(false); setSwitchMessage(''); loadModels(); return () => { modelRequest.current++; }; }, [loadModels]);

  // The core takes one field per agent.update, so each changed field is its own command (and its own log line).
  const fieldReason = (key: keyof Form | 'model') => (agent ? unsupported({ type: 'agent.update', agentId: agent.id, patch: { [key]: key === 'model' ? model : form?.[key as keyof Form] } }) : null);
  const engineId = (agent && models?.agents[agent.id]?.engine) || agent?.engine || '';
  const accountModel = agent ? models?.agents[agent.id] : undefined;
  const runningAccount = accountModel?.running;
  const selectedAgentId = React.useRef(agentId); selectedAgentId.current = agentId;
  const accountSelection = accountModel?.accountSelection ?? 'unavailable';
  const savedLauncher = accountModel?.launcher;
  const savedModel = (agent && models?.agents[agent.id]?.model) ?? '';
  const changes = agent && form ? (Object.keys(form) as (keyof Form)[]).filter((k) => form[k] !== formOf(agent)[k] && !fieldReason(k)) : [];
  const modelChanged = !!models && model !== savedModel && !fieldReason('model');
  const save = async () => {
    if (!agent || !form) return;
    setSaving(true);
    for (const k of changes) if (!(await dispatch({ type: 'agent.update', agentId: agent.id, patch: { [k]: form[k] } }))) break;
    if (modelChanged && await dispatch({ type: 'agent.update', agentId: agent.id, patch: { model } })) loadModels();
    setSaving(false);
  };
  const restart = async (mode: 'resume' | 'fresh') => {
    if (!agent) return;
    setSaving(true); setRestartMessage('');
    if (modelChanged && !(await dispatch({ type: 'agent.update', agentId: agent.id, patch: { model } }))) {
      setSaving(false); return;
    }
    const ok = await dispatch({ type: 'agent.restart', agentId: agent.id, mode });
    setRestartMessage(ok
      ? (mode === 'resume' ? 'Session resumed with the saved model and existing task files.' : 'Started fresh with the same agent identity and task files.')
      : 'Restart failed. See the action error for the reason.');
    if (ok) loadModels();
    setSaving(false);
  };
  const switchEngine = async () => {
    if (!agent || !switchAllowed || switching) return;
    setSwitching(true); setSwitchMessage('');
    const ok = await dispatch({ type: 'agent.switch', agentId: agent.id, provider: switchProvider, model: switchModel, launcher: launcherPick(switchLauncher) });
    if (selectedAgentId.current !== agent.id) return;
    setSwitchMessage(ok
      ? `Started a fresh ${switchProvider} session for ${agent.name}. Its old session and history remain; unsaved conversation context was not transferred.`
      : 'Switch failed. The previous session was restored when possible; see the action error for details.');
    setSwitching(false);
    if (ok) loadModels();
  };
  const switchAllowed = canSwitchAgent({ role: agent?.role ?? '', currentProvider: runningAccount?.provider ?? engineId, currentModel: currentSwitchModel(accountModel), model: switchModel, currentAccount: runningAccount ?? accountModel, provider: switchProvider, launcher: switchLauncher, discovery: models?.launchers, accounts: models?.accounts, chosen: switchChosen });
  const needsLauncherRefresh = ['claude', 'codex'].includes(switchProvider) && models?.launchers?.status !== 'ok';
  const blocked = (['color', 'persona', 'tone', 'autonomy', 'yolo'] as const).map((k) => fieldReason(k)).find(Boolean);

  return {
    agent, form, setForm, models, model, setModel, teamApi, loadModels, modelsError,
    accountModel, accountSelection, engineId, runningAccount, savedLauncher, fieldReason,
    switchAllowed, needsLauncherRefresh, switching, switchProvider, setSwitchProvider,
    switchModel, setSwitchModel, switchLauncher, setSwitchLauncher, setSwitchChosen,
    switchMessage, switchEngine, blocked, saving, changes, modelChanged, save, restart,
    restartMessage, dispatch,
  };
}

export function AgentProfileForm({ profile, compact = false }: { profile: ReturnType<typeof useAgentProfile>; compact?: boolean }) {
  const {
    agent, form, setForm, models, model, setModel, teamApi, loadModels, modelsError,
    accountSelection, engineId, runningAccount, savedLauncher, fieldReason,
    switchAllowed, needsLauncherRefresh, switching, switchProvider, setSwitchProvider,
    switchModel, setSwitchModel, switchLauncher, setSwitchLauncher, setSwitchChosen,
    switchMessage, switchEngine, blocked, saving, changes, modelChanged, save, restart,
    restartMessage, dispatch,
  } = profile;
  if (!agent || !form) return null;

  return (
    <div className="flex flex-col gap-3">
      {agent.cwd && <div className="flex flex-wrap items-center gap-2 text-xs">
        <span>Working folder</span>
        <span className="text-muted-foreground break-all font-mono">{agent.cwd}</span>
        <OpenWith path={agent.cwd} />
      </div>}
      <div className="grid min-w-0 gap-1.5"><Label htmlFor="ag-name">Display name</Label><Input id="ag-name" value={form.name} disabled={!!fieldReason('name')} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
      <div className="grid min-w-0 gap-1.5">
        <Label htmlFor="ag-model">Model</Label>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground shrink-0 text-xs">{engineId || 'engine not reported'} ·</span>
          <ModelSelect id="ag-model" models={models} engineId={engineId} value={model} onChange={setModel} disabled={!!fieldReason('model')} />
        </div>
        <span className="text-muted-foreground text-xs">Used from {agent.name}’s next start. “Use the default” follows the harness default model.</span>
        {!teamApi && <UnsupportedReason reason="This build cannot list models." />}
        <UnsupportedReason reason={fieldReason('model')} />
        {modelsError && <ErrorNotice error={modelsError}><Button size="sm" variant="outline" onClick={loadModels}>Retry</Button></ErrorNotice>}
      </div>
      {agent.role !== 'ephemeral' && agent.role !== 'watcher' && <div className="rounded-lg border p-3">
        <div className="mb-2 flex flex-col gap-1">
          <span className="text-sm font-medium">Switch provider or account</span>
          <span className="text-muted-foreground text-xs">Keeps this agent id, tasks and durable files, then starts a new provider session. The prior session and history remain, but unsaved conversation context is not transferred. Choose the exact account; the provider default is shown as a separate choice.</span>
          <span className="text-xs">Saved for next start: {engineId} · {savedLauncher ? `${savedLauncher.label} (${savedLauncher.id})` : accountSelection === 'default' ? 'Provider default' : 'Account unavailable'}.</span>
          <span className="text-xs">{runningAccount ? `Running: ${runningAccount.provider} · ${runningAccount.launcher ? `${runningAccount.launcher.label} (${runningAccount.launcher.id})` : runningAccount.accountSelection === 'default' ? 'Provider default' : 'Account identity unknown — switching unavailable'}` : 'No live session reported.'} The current session stops only after target checks pass.</span>
        </div>
        <fieldset disabled={switching} className="grid min-w-0 gap-2">
          <Label htmlFor="ag-switch-provider">Provider</Label>
          <select id="ag-switch-provider" className="bg-background h-9 rounded-md border px-2 text-sm" value={switchProvider} disabled={switching} onChange={(event) => {
            const provider = event.target.value; setSwitchProvider(provider); setSwitchModel(''); setSwitchChosen(true);
            setSwitchLauncher(null);
          }}>
            {(models?.engines ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
          <ModelSelect id="ag-switch-model" models={models} engineId={switchProvider} value={switchModel} onChange={(value) => { setSwitchModel(value); setSwitchChosen(true); }} />
          <LauncherSelect discovery={models?.launchers} provider={switchProvider} value={switchLauncher} onChange={(value) => { setSwitchLauncher(value); setSwitchChosen(true); }} />
          {needsLauncherRefresh && <Button size="sm" variant="outline" onClick={async () => { await dispatch({ type: 'launchers.refresh' }); loadModels(); }}>Refresh account choices</Button>}
          <Button size="sm" variant="outline" disabled={switching || !switchAllowed} onClick={() => void switchEngine()}>{switching ? 'Switching…' : `Switch to ${models?.engines.find((entry) => entry.id === switchProvider)?.label ?? switchProvider} · start fresh`}</Button>
        </fieldset>
        {switchMessage && <span className="text-muted-foreground mt-2 block text-xs" role="status">{switchMessage}</span>}
      </div>}
      <div className="flex items-center gap-3">
        <Label className="flex-1">Daily token budget</Label>
        <Button size="sm" variant="outline" disabled={!!fieldReason('tokensCap')} onClick={() => setForm({ ...form, tokensCap: Math.max(0.5, form.tokensCap - 0.5) })}>−</Button>
        <span className="w-14 text-center font-mono text-sm">{form.tokensCap}M</span>
        <Button size="sm" variant="outline" disabled={!!fieldReason('tokensCap')} onClick={() => setForm({ ...form, tokensCap: form.tokensCap + 0.5 })}>+</Button>
      </div>
      {blocked ? <UnsupportedReason reason="the core does not store an agent's colour, persona, tone, autonomy or YOLO yet." /> : (
        <>
          <div className="grid min-w-0 gap-1.5">
            <Label>Colour</Label>
            <ToggleGroup type="single" value={form.color} onValueChange={(v) => v && setForm({ ...form, color: v })} aria-label="Colour" className="flex-wrap">
              {Object.keys(accent).map((c) => (
                <ToggleGroupItem key={c} value={c} aria-label={c} className="size-8 p-0"><span className={cn('size-4 rounded-full', accent[c].bg, 'ring-1 ring-current', accent[c].fg)} /></ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="grid min-w-0 gap-1.5"><Label htmlFor="ag-persona">Persona and standing instructions</Label><Textarea id="ag-persona" rows={3} value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} /></div>
          <div className="grid min-w-0 gap-1.5"><Label>Tone</Label>
            <ToggleGroup type="single" variant="outline" size="sm" value={form.tone} onValueChange={(v) => v && setForm({ ...form, tone: v })}>{tones.map((t) => <ToggleGroupItem key={t} value={t} className="px-2.5 text-xs">{t}</ToggleGroupItem>)}</ToggleGroup>
          </div>
          <div className="grid min-w-0 gap-1.5"><Label>Autonomy</Label>
            <ToggleGroup type="single" variant="outline" size="sm" value={form.autonomy} onValueChange={(v) => v && setForm({ ...form, autonomy: v })} className="flex-wrap">{autonomies.map((t) => <ToggleGroupItem key={t} value={t} className="px-2.5 text-xs">{t}</ToggleGroupItem>)}</ToggleGroup>
          </div>
          <div className={cn('flex items-center gap-3 rounded-lg border p-2.5', !compact && 'border-fuchsia-500/30')}>
            <span className="flex flex-1 flex-col"><span className="text-sm font-medium">YOLO for this agent</span><span className="text-muted-foreground text-xs">No cap, approvals auto-granted, fast cycles</span></span>
            <Switch checked={!!form.yolo} onCheckedChange={(v) => setForm({ ...form, yolo: v })} aria-label="YOLO for this agent" />
          </div>
        </>
      )}
      <Button disabled={saving || (changes.length === 0 && !modelChanged)} onClick={() => void save()}>{saving ? 'Saving…' : `Save · logged and sent to ${agent.name}`}</Button>
      {agent.role !== 'ephemeral' && agent.role !== 'watcher' && <div className="rounded-lg border p-3">
        <div className="mb-2 flex flex-col gap-1">
          <span className="text-sm font-medium">Restart after a limit or interruption</span>
          <span className="text-muted-foreground text-xs">The selected model applies now. Resume keeps the provider session; Start fresh keeps this agent’s identity and task files. Neither changes spending limits.</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={saving || !!fieldReason('model')} onClick={() => void restart('resume')}>Save model and resume</Button>
          <Button size="sm" variant="outline" disabled={saving || !!fieldReason('model')} onClick={() => void restart('fresh')}>Save model and start fresh</Button>
        </div>
        {restartMessage && <span className="text-muted-foreground mt-2 block text-xs" role="status">{restartMessage}</span>}
      </div>}
    </div>
  );
}
