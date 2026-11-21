import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { useTeamApi, useFloor } from '@/data/store';
import type { ParamountOrganization } from '@/data/paramount-api';

const EMPTY: ParamountOrganization = { version: 1, teams: [], reportsTo: {} };

export function TeamsEditor() {
  const api = useTeamApi();
  const agents = useFloor((state) => state.agents);
  const cards = useFloor((state) => state.cards);
  const archivedAgents = useFloor((state) => state.archivedAgents ?? []);
  const [organizationText, setOrganizationText] = React.useState(JSON.stringify(EMPTY, null, 2));
  const [teamId, setTeamId] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [tasksText, setTasksText] = React.useState('[\n  { "title": "First step", "ownerId": "", "dependsOn": [] }\n]');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const parsedOrg = React.useMemo(() => {
    try { return JSON.parse(organizationText) as ParamountOrganization; }
    catch { return EMPTY; }
  }, [organizationText]);

  React.useEffect(() => {
    if (!api?.organization) return;
    let alive = true;
    api.organization().then((org) => { if (alive) { setOrganizationText(JSON.stringify(org, null, 2)); setTeamId(org.teams[0]?.id ?? ''); } }).catch((error) => { if (alive) setMessage(error instanceof Error ? error.message : 'Could not load teams'); });
    return () => { alive = false; };
  }, [api]);

  const save = async () => {
    if (!api?.saveOrganization) return;
    setBusy(true); setMessage('');
    try { const result = await api.saveOrganization(JSON.parse(organizationText) as ParamountOrganization); setOrganizationText(JSON.stringify(result, null, 2)); setTeamId(result.teams[0]?.id ?? ''); setMessage('Teams saved.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save teams'); }
    finally { setBusy(false); }
  };
  const delegate = async () => {
    if (!api?.delegate) return;
    setBusy(true); setMessage('');
    try {
      const result = await api.delegate({ type: 'team.delegate', teamId, title, description, subtasks: JSON.parse(tasksText) });
      setMessage(`Created ${result.parentKey} with subtasks ${result.childKeys.join(', ')}.`); setTitle('');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not delegate work'); }
    finally { setBusy(false); }
  };
  if (!api?.organization || !api.saveOrganization || !api.delegate) return <p className="text-sm text-muted-foreground">Team editing requires the Paramount desktop core.</p>;
  return <section className="grid gap-5 rounded-xl border border-border bg-card p-4 lg:grid-cols-2" aria-labelledby="teams-editor-title">
    <div className="flex flex-col gap-3">
      <div><h2 id="teams-editor-title" className="text-base font-semibold">Teams and reporting lines</h2><p className="text-xs text-muted-foreground">Choose existing agent IDs. Reporting cycles are rejected when saved.</p></div>
      <div className="flex flex-wrap gap-2">{agents.map((agent) => <span key={agent.id} className="rounded bg-muted px-2 py-1 text-xs">{agent.name}: {cards.filter((card) => card.agentId === agent.id && card.status !== 'done').length} open / {cards.filter((card) => card.agentId === agent.id && card.status === 'blocked').length} blocked</span>)}</div>
      <label className="text-xs font-medium" htmlFor="org-json">Organization JSON</label>
      <textarea id="org-json" className="min-h-56 w-full rounded-md border border-input bg-background p-3 font-mono text-xs" value={organizationText} onChange={(event) => setOrganizationText(event.target.value)} spellCheck={false} />
      <Button onClick={save} disabled={busy}>Save teams</Button>
      {archivedAgents.length > 0 && <div className="flex flex-col gap-1 border-t pt-3"><h3 className="text-sm font-medium">Archived agents</h3>{archivedAgents.map((agent) => <div key={agent.id} className="flex items-center gap-2 text-sm"><span className="flex-1">{agent.name}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => api.archiveAgent?.(agent.id, false).then(() => setMessage(`${agent.name} restored.`)).catch((error) => setMessage(error instanceof Error ? error.message : 'Could not restore agent'))}>Restore</Button></div>)}</div>}
    </div>
    <div className="flex flex-col gap-3">
      <div><h2 className="text-base font-semibold">Delegate board work</h2><p className="text-xs text-muted-foreground">Creates one lead-owned parent and up to eight member-owned subtasks. Dependencies may point to earlier subtasks.</p></div>
      <label className="text-xs font-medium" htmlFor="delegate-team">Team</label>
      <select id="delegate-team" className="rounded-md border border-input bg-background px-3 py-2 text-sm" value={teamId} onChange={(event) => setTeamId(event.target.value)}>{parsedOrg.teams.map((team) => <option key={team.id} value={team.id}>{team.name} — lead {team.leadId}</option>)}</select>
      <label className="text-xs font-medium" htmlFor="parent-title">Parent task</label>
      <input id="parent-title" className="rounded-md border border-input bg-background px-3 py-2 text-sm" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Outcome for the team" />
      <label className="text-xs font-medium" htmlFor="parent-description">Context</label>
      <textarea id="parent-description" className="min-h-16 rounded-md border border-input bg-background p-3 text-sm" value={description} onChange={(event) => setDescription(event.target.value)} />
      <label className="text-xs font-medium" htmlFor="subtasks-json">Subtasks JSON (ownerId must be a team member)</label>
      <textarea id="subtasks-json" className="min-h-36 rounded-md border border-input bg-background p-3 font-mono text-xs" value={tasksText} onChange={(event) => setTasksText(event.target.value)} spellCheck={false} />
      <Button onClick={delegate} disabled={busy || !title.trim() || !teamId}>Create and message owners</Button>
      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    </div>
  </section>;
}
