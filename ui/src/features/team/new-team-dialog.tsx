import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/animate-ui/components/radix/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useFloor, useTeamApi } from '@/data/store';
import type { ParamountOrganization } from '@/data/paramount-api';

export function NewTeamDialog({ onCreated }: { onCreated: (team: ParamountOrganization['teams'][number]) => void }) {
  const createTeam = useTeamApi()?.createTeam;
  const agents = useFloor((s) => s.agents);
  const formId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [objective, setObjective] = React.useState('');
  const [leadId, setLeadId] = React.useState('');
  const [members, setMembers] = React.useState<string[]>([]);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const activeLead = agents.some((agent) => agent.id === leadId);
  const unavailable = !createTeam ? 'Team creation needs the desktop core.' : !agents.length ? 'Add an agent before creating a team.' : undefined;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!createTeam || busy || !activeLead || !name.trim() || !objective.trim()) return;
    setBusy(true);
    setError('');
    try {
      const team = await createTeam({
        type: 'team.org.create', name: name.trim(), objective: objective.trim(), leadId,
        memberIds: agents.filter((agent) => agent.id !== leadId && members.includes(agent.id)).map((agent) => agent.id),
      });
      setOpen(false);
      setName('');
      setObjective('');
      setLeadId('');
      setMembers([]);
      onCreated(team);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the team.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <DialogTrigger asChild>
        <Button variant="outline" disabled={!!unavailable} title={unavailable}>New team</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New team</DialogTitle>
          <DialogDescription>Choose a lead and the floor agents who will work toward this objective.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form id={formId} onSubmit={submit} className="grid gap-4">
            <fieldset disabled={busy} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor={`${formId}-name`}>Team name</Label>
                <Input id={`${formId}-name`} value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${formId}-objective`}>Objective</Label>
                <Textarea id={`${formId}-objective`} value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={2000} required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${formId}-lead`}>Team lead</Label>
                <select id={`${formId}-lead`} required value={activeLead ? leadId : ''} onChange={(event) => setLeadId(event.target.value)} className="border-input bg-background h-9 rounded-md border px-2 text-sm">
                  <option value="">Choose an agent</option>
                  {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
              </div>
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Members</legend>
                <div className="grid max-h-36 gap-2 overflow-y-auto rounded-md border p-2">
                  {agents.map((agent) => (
                    <label key={agent.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={agent.id === leadId || members.includes(agent.id)} disabled={agent.id === leadId}
                        onChange={(event) => setMembers(event.target.checked ? [...members, agent.id] : members.filter((id) => id !== agent.id))} />
                      {agent.name}{agent.id === leadId && ' (lead)'}
                    </label>
                  ))}
                </div>
              </fieldset>
            </fieldset>
            {error && <p role="alert" className="text-sm">{error}</p>}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" form={formId} disabled={busy || !activeLead || !name.trim() || !objective.trim()}>{busy ? 'Creating…' : 'Create team'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
