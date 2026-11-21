import { AgentProfileForm, useAgentProfile } from './agent-profile';
import { LauncherSettings } from './launcher-select';
import * as React from 'react';
// An agent's big card: overview, queue, activity and profile in one modal, opened from any agent on the Team screen.
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/animate-ui/components/radix/dialog';
import { Tabs, TabsContent, TabsContents, TabsList, TabsTrigger } from '@/components/animate-ui/components/radix/tabs';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Badge } from '@/components/ui/badge';
import { AgentSummary } from '@/components/app/agent-summary';
import { EngineSignInActions } from '@/components/app/engine-sign-in-actions';
import { clock } from '@/components/app/format';
import { saveExistingAgentPreset } from './agent-preset';
import { NewCardDialog } from '@/features/team/new-card-dialog';
import { useDispatch, useFloor } from '@/data/store';
import { AGENT_VIEW, agentViewParams } from '@/app/agent-view';
import { useRouter } from '@/app/router';
import { useAgentActions } from './agent-actions';

/** `tab` opens a given tab first (Chats' avatar click opens `profile`, the agent's settings). */
export function AgentSheet({ agentId, onClose, tab }: { agentId: string | null; onClose: () => void; tab?: string | null }) {
  const profile = useAgentProfile(agentId);
  const { agent, models, teamApi, accountModel, accountSelection, engineId, savedLauncher, loadModels } = profile;
  const cards = useFloor((s) => s.cards);
  const activity = useFloor((s) => s.activity);
  const prerequisites = useFloor((s) => s.prerequisites);
  const { go } = useRouter();
  const [presetSaving, setPresetSaving] = React.useState(false);
  const [presetMessage, setPresetMessage] = React.useState<{ kind: 'status' | 'error'; text: string } | null>(null);
  const [creating, setCreating] = React.useState(false);
  React.useEffect(() => { setPresetMessage(null); setPresetSaving(false); }, [agentId]);

  const mine = React.useMemo(() => cards.filter((c) => c.agentId === agentId && c.status !== 'done'), [cards, agentId]);
  const events = React.useMemo(() => activity.filter((e) => e.agentId === agentId).slice(0, 8), [activity, agentId]);

  type SheetMode = 'default' | 'rename' | 'note' | 'restart';
  const [sheetMode, setSheetMode] = React.useState<SheetMode>('default');
  const [sheetInput, setSheetInput] = React.useState('');
  const [sheetStatus, setSheetStatus] = React.useState('');
  const [sheetSending, setSheetSending] = React.useState(false);
  const dispatch = useDispatch();

  React.useEffect(() => { setSheetMode('default'); setSheetStatus(''); }, [agentId]);

  const { actions: agentActions, run: runAction, renameAgent } = useAgentActions(agentId ?? '', {
    onClose,
    onRenameStart: () => { setSheetInput(agent?.name ?? ''); setSheetMode('rename'); setSheetStatus(''); },
    onNoteStart: () => { setSheetInput(''); setSheetMode('note'); setSheetStatus(''); },
    onRestartStart: () => { setSheetMode('restart'); setSheetStatus(''); },
  });

  const profileActions = React.useMemo(
    () => agentActions.filter((a) => a.id !== 'open-profile'),
    [agentActions],
  );

  const submitRename = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = sheetInput.trim();
    if (!name) return;
    setSheetSending(true);
    setSheetStatus('');
    try {
      const result = await renameAgent(name);
      if (result.ok) { setSheetStatus(`Renamed to ${result.name ?? name}.`); setSheetMode('default'); }
      else setSheetStatus(result.error ?? 'Could not rename.');
    } finally { setSheetSending(false); }
  };

  const submitNote = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = sheetInput.trim();
    if (!text || !teamApi?.sendNote) return;
    setSheetSending(true);
    setSheetStatus('');
    try {
      await teamApi.sendNote(agentId ?? '', text);
      setSheetMode('default');
    } catch (err) {
      setSheetStatus(err instanceof Error ? err.message : 'Could not send note.');
    } finally { setSheetSending(false); }
  };

  const restartAgent = async (restartMode: 'resume' | 'fresh') => {
    setSheetSending(true);
    setSheetStatus('');
    try {
      await dispatch({ type: 'agent.restart', agentId: agentId ?? '', mode: restartMode });
      setSheetStatus(restartMode === 'resume' ? 'Resume requested.' : 'Fresh session requested.');
      setSheetMode('default');
    } catch (err) {
      setSheetStatus(err instanceof Error ? err.message : 'Restart failed.');
    } finally { setSheetSending(false); }
  };

  const agentSignIn = accountSelection === 'stale' || accountSelection === 'unavailable' ? undefined : prerequisites.find((entry) => entry.signInProvider === engineId
    && (accountSelection === 'selected'
      ? entry.signInAccountId === savedLauncher?.id && entry.signInAccountFingerprint === savedLauncher?.fingerprint
      : entry.id === engineId));
  const savePreset = async () => {
    if (!agent || !teamApi?.saveAgentPreset || presetSaving) return;
    setPresetSaving(true);
    setPresetMessage(null);
    try {
      const result = await saveExistingAgentPreset({ name: agent.name, provider: accountModel?.engine ?? agent.engine,
        model: accountModel?.model ?? agent.model, accent: agent.color, tokenCapMillions: agent.tokensCap }, teamApi.saveAgentPreset);
      if (result.canceled) setPresetMessage({ kind: 'status', text: 'Preset save canceled.' });
      else if (result.error) setPresetMessage({ kind: 'error', text: result.error });
      else setPresetMessage({ kind: 'status', text: `Preset saved to ${result.path ?? 'the selected file'}.` });
    } catch (cause) {
      setPresetMessage({ kind: 'error', text: cause instanceof Error ? cause.message : 'Could not prepare this agent preset.' });
    } finally { setPresetSaving(false); }
  };

  return (
    <Dialog open={!!agent} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        {agent && (
          <>
            <DialogHeader>
              <DialogTitle>{agent.name}</DialogTitle>
              <DialogDescription>{agent.doing || 'Not reported.'}</DialogDescription>
            </DialogHeader>
            <DialogBody>
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
                  <div className="flex flex-col items-start gap-2">
                    <Button size="sm" variant="outline" disabled={!teamApi?.saveAgentPreset || presetSaving} onClick={() => void savePreset()}>{presetSaving ? 'Saving preset…' : 'Save agent preset'}</Button>
                    {presetMessage && <span role={presetMessage.kind === 'error' ? 'alert' : 'status'} className="text-muted-foreground text-xs">{presetMessage.text}</span>}
                  </div>
                  {(accountSelection === 'stale' || accountSelection === 'unavailable') && <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">{accountSelection === 'stale' ? `The saved account ${savedLauncher?.id ?? ''} changed or is no longer available.` : 'The saved account selection could not be read.'} Refresh launcher discovery and explicitly reselect the account below. Sign-in checks and login are disabled until the selection is resolved.</div>}
                  {agentSignIn && agentSignIn.state !== 'ready' && agentSignIn.signInProvider && <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                    <p className="mb-2 text-sm font-medium">{agentSignIn.state === 'unknown' ? `Sign-in status for ${agentSignIn.signInAccountLabel ?? engineId} is unknown` : `${agent.name} needs to sign in to ${agentSignIn.signInAccountLabel ?? engineId}`}</p>
                    <p className="text-muted-foreground mb-2 text-xs">This action uses {accountSelection === 'selected' ? 'the exact account selected for this agent' : 'the explicitly selected provider default'}. Sign-in stays in the provider CLI; refresh confirms recovery without restarting Paramount.</p>
                    <EngineSignInActions provider={agentSignIn.signInProvider} state={agentSignIn.state} accountSelection={accountSelection} cliAvailable={accountModel?.installed ?? true} accountId={agentSignIn.signInAccountId} accountFingerprint={agentSignIn.signInAccountFingerprint} accountLabel={agentSignIn.signInAccountLabel} />
                  </div>}
                  <LauncherSettings agentId={agent.id} provider={engineId} scope={agent.id === models?.orchestratorId || agent.id === 'god' ? 'orchestrator' : 'agent'} onSelectionChange={loadModels} />
                  <div className="mt-3 flex flex-col gap-2">
                    {sheetMode === 'default' && (
                      <div className="flex flex-wrap gap-2">
                        {profileActions.map((action) => (
                          <Button key={action.id} size="sm" variant="outline" disabled={action.disabled || sheetSending}
                            onClick={() => void runAction(action.id)}>
                            {action.label}
                          </Button>
                        ))}
                      </div>
                    )}
                    {sheetMode === 'rename' && (
                      <form className="flex flex-col gap-2" onSubmit={(e) => void submitRename(e)}>
                        <label htmlFor="sheet-agent-rename" className="text-xs">New name for {agent.name}</label>
                        <input autoFocus id="sheet-agent-rename" className="rounded border bg-background px-2 py-1 text-sm"
                          value={sheetInput} onChange={(e) => setSheetInput(e.target.value)} maxLength={80} />
                        <div className="flex gap-2">
                          <Button size="sm" disabled={!sheetInput.trim() || sheetSending}>{sheetSending ? 'Saving…' : 'Save name'}</Button>
                          <Button type="button" size="sm" variant="ghost" disabled={sheetSending} onClick={() => setSheetMode('default')}>Cancel</Button>
                        </div>
                      </form>
                    )}
                    {sheetMode === 'note' && (
                      <form className="flex flex-col gap-2" onSubmit={(e) => void submitNote(e)}>
                        <label htmlFor="sheet-agent-note" className="text-xs">Note for {agent.name}</label>
                        <textarea autoFocus id="sheet-agent-note" className="min-h-20 rounded border bg-background p-2 text-sm"
                          value={sheetInput} onChange={(e) => setSheetInput(e.target.value)} maxLength={5000} />
                        <div className="flex gap-2">
                          <Button size="sm" disabled={!sheetInput.trim() || sheetSending}>{sheetSending ? 'Sending…' : 'Send note'}</Button>
                          <Button type="button" size="sm" variant="ghost" disabled={sheetSending} onClick={() => setSheetMode('default')}>Cancel</Button>
                        </div>
                      </form>
                    )}
                    {sheetMode === 'restart' && (
                      <div className="flex flex-col gap-2">
                        <span className="text-xs text-muted-foreground">Restart {agent.name}</span>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" disabled={sheetSending} onClick={() => void restartAgent('resume')}>Resume session</Button>
                          <Button size="sm" variant="outline" disabled={sheetSending} onClick={() => void restartAgent('fresh')}>Start fresh</Button>
                          <Button size="sm" variant="ghost" disabled={sheetSending} onClick={() => setSheetMode('default')}>Cancel</Button>
                        </div>
                      </div>
                    )}
                    {sheetStatus && <span role="status" className="text-xs text-muted-foreground">{sheetStatus}</span>}
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
                  <AgentProfileForm profile={profile} />
                </TabsContent>
              </TabsContents>
            </Tabs>
            </DialogBody>
          </>
        )}
      </DialogContent>
      <NewCardDialog open={creating} onClose={() => setCreating(false)} assignee={agent?.id} />
    </Dialog>
  );
}
