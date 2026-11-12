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
import { clock } from '@/components/app/format';
import { accent } from '@/components/app/status';
import { UnsupportedReason } from '@/components/app/error-notice';
import { ErrorNotice } from '@/components/app/error-notice';
import { ModelSelect } from '@/features/team/hire-sheet';
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
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const teamApi = useTeamApi();
  const { go } = useRouter();
  const [form, setForm] = React.useState<Form | null>(null);
  const [models, setModels] = React.useState<ParamountTeamModels | null>(null);
  const [model, setModel] = React.useState('');
  const [modelsError, setModelsError] = React.useState<BackendError | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  React.useEffect(() => { setForm(agent ? formOf(agent) : null); }, [agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadModels = React.useCallback(() => {
    if (!teamApi || !agentId) return;
    setModelsError(null);
    teamApi.models().then((m) => { setModels(m); setModel(m.agents[agentId]?.model ?? ''); }, (cause) => setModelsError(toBackendError(cause, 'team.models')));
  }, [teamApi, agentId]);
  React.useEffect(() => { setModels(null); setModel(''); loadModels(); }, [loadModels]);

  const mine = React.useMemo(() => cards.filter((c) => c.agentId === agentId && c.status !== 'done'), [cards, agentId]);
  const events = React.useMemo(() => activity.filter((e) => e.agentId === agentId).slice(0, 8), [activity, agentId]);

  // The core takes one field per agent.update, so each changed field is its own command (and its own log line).
  const fieldReason = (key: keyof Form | 'model') => (agent ? unsupported({ type: 'agent.update', agentId: agent.id, patch: { [key]: key === 'model' ? model : form?.[key as keyof Form] } }) : null);
  const engineId = (agent && models?.agents[agent.id]?.engine) || agent?.engine || '';
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
                  <LauncherSettings agentId={agent.id} provider={engineId} scope={agent.id === models?.orchestratorId || agent.id === 'god' ? 'orchestrator' : 'agent'} />
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
                      <span className="text-muted-foreground shrink-0 text-xs" title="Moving an agent to another engine means hiring it again on that engine.">{engineId || 'engine not reported'} ·</span>
                      <ModelSelect id="ag-model" models={models} engineId={engineId} value={model} onChange={setModel} disabled={!!fieldReason('model')} />
                    </div>
                    <span className="text-muted-foreground text-xs">Used from {agent.name}’s next start. “Use the default” follows the harness default model.</span>
                    {!teamApi && <UnsupportedReason reason="This build cannot list models." />}
                    <UnsupportedReason reason={fieldReason('model')} />
                    {modelsError && <ErrorNotice error={modelsError}><Button size="sm" variant="outline" onClick={loadModels}>Retry</Button></ErrorNotice>}
                  </div>
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
