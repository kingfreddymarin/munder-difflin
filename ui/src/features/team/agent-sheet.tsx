import { LauncherSettings } from './launcher-select';
import * as React from 'react';
// An agent's big card: overview, queue, activity and profile in one modal, opened from any agent on the Team screen.
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/animate-ui/components/radix/dialog';
import { Tabs, TabsContent, TabsContents, TabsList, TabsTrigger } from '@/components/animate-ui/components/radix/tabs';
import { Switch } from '@/components/animate-ui/components/radix/switch';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/animate-ui/components/radix/toggle-group';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { AgentSummary } from '@/components/app/agent-summary';
import { EngineSignInActions } from '@/components/app/engine-sign-in-actions';
import { clock } from '@/components/app/format';
import { accent } from '@/components/app/status';
import { UnsupportedReason } from '@/components/app/error-notice';
import { ErrorNotice } from '@/components/app/error-notice';
import { ModelSelect } from '@/features/team/hire-sheet';
import { LauncherSelect } from '@/features/team/launcher-select';
import { NewCardDialog } from '@/features/team/new-card-dialog';
import { useDispatch, useFloor, useTeamApi, useUnsupported } from '@/data/store';
import { toBackendError, type BackendError } from '@/data/errors';
import type { ParamountTeamModels } from '@/data/paramount-api';
import type { Agent } from '@/data/types';
import { AGENT_VIEW, agentViewParams } from '@/app/agent-view';
import { useRouter } from '@/app/router';
import { cn } from '@/lib/utils';

// Choices offered for tone and autonomy when the provider stores them (the sample data does; the core does not yet).
const tones = ['Concise', 'Detailed', 'Friendly', 'Formal'];
const autonomies = ['Read only', 'Ask for merges', 'Ask for anything risky', 'Full within budget'];

type Form = Pick<Agent, 'name' | 'color' | 'tokensCap' | 'yolo'> & { persona: string; tone: string; autonomy: string };
const formOf = (a: Agent): Form => ({ name: a.name, color: a.color, tokensCap: a.tokensCap, persona: a.persona ?? '', tone: a.tone ?? '', autonomy: a.autonomy ?? '', yolo: !!a.yolo });

/** `tab` opens a given tab first (Chats' avatar click opens `profile`, the agent's settings). */
export function AgentSheet({ agentId, onClose, tab }: { agentId: string | null; onClose: () => void; tab?: string | null }) {
  const agent = useFloor((s) => s.agents.find((a) => a.id === agentId));
  const cards = useFloor((s) => s.cards);
  const activity = useFloor((s) => s.activity);
  const prerequisites = useFloor((s) => s.prerequisites);
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const teamApi = useTeamApi();
  const { go } = useRouter();
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
  const [switching, setSwitching] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  React.useEffect(() => { setForm(agent ? formOf(agent) : null); }, [agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadModels = React.useCallback(() => {
    if (!teamApi || !agentId) return;
    setModelsError(null);
    teamApi.models().then((m) => {
      setModels(m); setModel(m.agents[agentId]?.model ?? '');
      const current = m.agents[agentId]?.engine;
      const next = m.engines.find((entry) => entry.id !== current) ?? m.engines[0];
      setSwitchProvider(next?.id ?? ''); setSwitchModel('');
      setSwitchLauncher(null);
    }, (cause) => setModelsError(toBackendError(cause, 'team.models')));
  }, [teamApi, agentId]);
  React.useEffect(() => { setModels(null); setModel(''); loadModels(); }, [loadModels]);

  const mine = React.useMemo(() => cards.filter((c) => c.agentId === agentId && c.status !== 'done'), [cards, agentId]);
  const events = React.useMemo(() => activity.filter((e) => e.agentId === agentId).slice(0, 8), [activity, agentId]);

  // The core takes one field per agent.update, so each changed field is its own command (and its own log line).
  const fieldReason = (key: keyof Form | 'model') => (agent ? unsupported({ type: 'agent.update', agentId: agent.id, patch: { [key]: key === 'model' ? model : form?.[key as keyof Form] } }) : null);
  const engineId = (agent && models?.agents[agent.id]?.engine) || agent?.engine || '';
  const accountModel = agent ? models?.agents[agent.id] : undefined;
  const accountSelection = accountModel?.accountSelection ?? 'unavailable';
  const savedLauncher = accountModel?.launcher;
  const agentSignIn = accountSelection === 'stale' || accountSelection === 'unavailable' ? undefined : prerequisites.find((entry) => entry.signInProvider === engineId
    && (accountSelection === 'selected'
      ? entry.signInAccountId === savedLauncher?.id && entry.signInAccountFingerprint === savedLauncher?.fingerprint
      : entry.id === engineId));
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
    if (!agent || !switchProvider || switchProvider === engineId) return;
    setSwitching(true); setSwitchMessage('');
    const ok = await dispatch({ type: 'agent.switch', agentId: agent.id, provider: switchProvider, model: switchModel, launcher: switchLauncher });
    setSwitchMessage(ok
      ? `Started a fresh ${switchProvider} session for ${agent.name}. Its old session and history remain; unsaved conversation context was not transferred.`
      : 'Switch failed. The previous session was restored when possible; see the action error for details.');
    setSwitching(false);
    if (ok) loadModels();
  };
  const targetLaunchers = models?.launchers?.choices.filter((choice) => choice.provider === switchProvider) ?? [];
  const needsLauncherRefresh = ['claude', 'codex'].includes(switchProvider) && models?.launchers?.status !== 'ok';
  const blocked = (['color', 'persona', 'tone', 'autonomy', 'yolo'] as const).map((k) => fieldReason(k)).find(Boolean);

  return (
    <Dialog open={!!agent} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88vh] flex-col overflow-y-auto sm:max-w-3xl">
        {agent && form && (
          <>
            <DialogHeader>
              <DialogTitle>{agent.name}</DialogTitle>
              <DialogDescription>{agent.doing || 'Not reported.'}</DialogDescription>
            </DialogHeader>
            <Tabs key={`${agentId}:${tab ?? ''}`} defaultValue={tab ?? 'overview'} className="flex min-h-0 flex-1 flex-col gap-3">
              <TabsList className="w-full">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="tasks">Tasks</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
                <TabsTrigger value="profile">Profile</TabsTrigger>
              </TabsList>
              <TabsContents className="min-h-0 flex-1">
                <TabsContent value="overview">
                  <AgentSummary agent={agent} />
                  {(accountSelection === 'stale' || accountSelection === 'unavailable') && <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">{accountSelection === 'stale' ? `The saved account ${savedLauncher?.id ?? ''} changed or is no longer available.` : 'The saved account selection could not be read.'} Refresh launcher discovery and explicitly reselect the account below. Sign-in checks and login are disabled until the selection is resolved.</div>}
                  {agentSignIn && agentSignIn.state !== 'ready' && agentSignIn.signInProvider && <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                    <p className="mb-2 text-sm font-medium">{agentSignIn.state === 'unknown' ? `Sign-in status for ${agentSignIn.signInAccountLabel ?? engineId} is unknown` : `${agent.name} needs to sign in to ${agentSignIn.signInAccountLabel ?? engineId}`}</p>
                    <p className="text-muted-foreground mb-2 text-xs">This action uses {accountSelection === 'selected' ? 'the exact account selected for this agent' : 'the explicitly selected provider default'}. Sign-in stays in the provider CLI; refresh confirms recovery without restarting Paramount.</p>
                    <EngineSignInActions provider={agentSignIn.signInProvider} state={agentSignIn.state} accountSelection={accountSelection} cliAvailable={accountModel?.installed ?? true} accountId={agentSignIn.signInAccountId} accountFingerprint={agentSignIn.signInAccountFingerprint} accountLabel={agentSignIn.signInAccountLabel} />
                  </div>}
                  <LauncherSettings agentId={agent.id} provider={engineId} scope={agent.id === models?.orchestratorId || agent.id === 'god' ? 'orchestrator' : 'agent'} onSelectionChange={loadModels} />
                  <div className="mt-3 flex gap-2">
                    <Button className="flex-1" onClick={() => go(AGENT_VIEW, agentViewParams(agent.id))}>Open terminal</Button>
                  </div>
                </TabsContent>
                <TabsContent value="tasks" className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground flex-1 text-xs">In the order {agent.name} will work them; it reads this queue every turn.</span>
                    <Button size="sm" variant="outline" onClick={() => setCreating(true)}>New card</Button>
                  </div>
                  {mine.map((c, i) => {
                    const now = c.plan.find((p) => p.state === 'doing' || p.state === 'ask' || p.state === 'blocked');
                    return (
                      <button key={c.key} type="button" onClick={() => go('board', { card: c.key })} className="hover:bg-accent flex gap-3 rounded-lg border p-3 text-left">
                        <span className="text-muted-foreground font-mono text-xs">{i + 1}</span>
                        <span className="flex flex-1 flex-col gap-1">
                          <span className="text-sm font-medium"><span className="text-muted-foreground font-mono text-xs">{c.key}</span> {c.title}</span>
                          <span className="text-muted-foreground text-xs">Now: {now?.text ?? c.status}</span>
                        </span>
                        <Badge variant="outline">{c.status}</Badge>
                      </button>
                    );
                  })}
                  {mine.length === 0 && <span className="text-muted-foreground text-sm">No open cards.</span>}
                </TabsContent>
                <TabsContent value="activity" className="flex flex-col gap-2">
                  {events.map((e) => (
                    <div key={e.id} className="flex gap-3 text-sm">
                      <span className="text-muted-foreground w-11 font-mono text-xs">{clock(e.at)}</span>
                      <span className="flex-1">{e.text}</span>
                      <span className="text-muted-foreground text-xs">{e.tokens}</span>
                    </div>
                  ))}
                </TabsContent>
                <TabsContent value="profile" className="flex flex-col gap-3">
                  <div className="grid gap-1.5"><Label htmlFor="ag-name">Display name</Label><Input id="ag-name" value={form.name} disabled={!!fieldReason('name')} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ag-model">Model</Label>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground shrink-0 text-xs">{engineId || 'engine not reported'} ·</span>
                      <ModelSelect id="ag-model" models={models} engineId={engineId} value={model} onChange={setModel} disabled={!!fieldReason('model')} />
                    </div>
                    <span className="text-muted-foreground text-xs">Used from {agent.name}’s next start. “Use the default” follows the harness default model.</span>
                    {!teamApi && <UnsupportedReason reason="This build cannot list models." />}
                    <UnsupportedReason reason={fieldReason('model')} />
                    {modelsError && <ErrorNotice error={modelsError}><Button size="sm" variant="outline" onClick={loadModels}>Retry</Button></ErrorNotice>}
                  </div>
                  {agent.role !== 'ephemeral' && agent.role !== 'watcher' && agent.id !== models?.orchestratorId && <div className="rounded-lg border p-3">
                    <div className="mb-2 flex flex-col gap-1">
                      <span className="text-sm font-medium">Switch provider</span>
                      <span className="text-muted-foreground text-xs">Keeps this agent id, tasks and durable files, then starts a new provider session. The prior session and history remain, but unsaved conversation context is not transferred. Choose the exact account; the provider default is shown as a separate choice.</span>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="ag-switch-provider">Provider</Label>
                      <select id="ag-switch-provider" className="bg-background h-9 rounded-md border px-2 text-sm" value={switchProvider} onChange={(event) => {
                        const provider = event.target.value; setSwitchProvider(provider); setSwitchModel('');
                        setSwitchLauncher(null);
                      }}>
                        {(models?.engines ?? []).filter((entry) => entry.id !== engineId).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                      </select>
                      <ModelSelect id="ag-switch-model" models={models} engineId={switchProvider} value={switchModel} onChange={setSwitchModel} />
                      <LauncherSelect discovery={models?.launchers} provider={switchProvider} value={switchLauncher} onChange={setSwitchLauncher} />
                      {needsLauncherRefresh && <Button size="sm" variant="outline" onClick={async () => { await dispatch({ type: 'launchers.refresh' }); loadModels(); }}>Refresh account choices</Button>}
                      <Button size="sm" variant="outline" disabled={switching || !switchProvider || switchProvider === engineId || needsLauncherRefresh || (targetLaunchers.length > 0 && !switchLauncher)} onClick={() => void switchEngine()}>{switching ? 'Switching…' : `Switch to ${models?.engines.find((entry) => entry.id === switchProvider)?.label ?? switchProvider} · start fresh`}</Button>
                    </div>
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
                      <div className="grid gap-1.5">
                        <Label>Colour</Label>
                        <ToggleGroup type="single" value={form.color} onValueChange={(v) => v && setForm({ ...form, color: v })} aria-label="Colour">
                          {Object.keys(accent).map((c) => (
                            <ToggleGroupItem key={c} value={c} aria-label={c} className="size-8 p-0"><span className={cn('size-4 rounded-full', accent[c].bg, 'ring-1 ring-current', accent[c].fg)} /></ToggleGroupItem>
                          ))}
                        </ToggleGroup>
                      </div>
                      <div className="grid gap-1.5"><Label htmlFor="ag-persona">Persona and standing instructions</Label><Textarea id="ag-persona" rows={3} value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} /></div>
                      <div className="grid gap-1.5"><Label>Tone</Label>
                        <ToggleGroup type="single" variant="outline" size="sm" value={form.tone} onValueChange={(v) => v && setForm({ ...form, tone: v })}>{tones.map((t) => <ToggleGroupItem key={t} value={t} className="px-2.5 text-xs">{t}</ToggleGroupItem>)}</ToggleGroup>
                      </div>
                      <div className="grid gap-1.5"><Label>Autonomy</Label>
                        <ToggleGroup type="single" variant="outline" size="sm" value={form.autonomy} onValueChange={(v) => v && setForm({ ...form, autonomy: v })} className="flex-wrap">{autonomies.map((t) => <ToggleGroupItem key={t} value={t} className="px-2.5 text-xs">{t}</ToggleGroupItem>)}</ToggleGroup>
                      </div>
                      <div className="flex items-center gap-3 rounded-lg border border-fuchsia-500/30 p-2.5">
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
                </TabsContent>
              </TabsContents>
            </Tabs>
          </>
        )}
      </DialogContent>
      <NewCardDialog open={creating} onClose={() => setCreating(false)} assignee={agent?.id} />
    </Dialog>
  );
}
