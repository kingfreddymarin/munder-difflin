// STD-4: edit the floor's Main Objectives in place on Home. Save sends home.objectives; the core
// validates and persists it, so the list survives restarts. Cancel discards the draft.
import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useDispatch } from '@/data/store';
import { MAX_OBJECTIVES, newObjective, objectivesToSave, parseCardKeys, type ObjectiveHealth, type ObjectiveInput } from '@/data/objectives';
import type { Agent, Objective } from '@/data/types';

const HEALTH: { id: ObjectiveHealth; label: string }[] = [{ id: 'on-track', label: 'On track' }, { id: 'at-risk', label: 'At risk' }, { id: 'blocked', label: 'Blocked' }];
const select = 'border-input bg-background h-8 rounded-md border px-2 text-sm';

export function ObjectivesEditor({ objectives, agents, onDone }: { objectives: Objective[]; agents: Pick<Agent, 'id' | 'name'>[]; onDone: () => void }) {
  const dispatch = useDispatch();
  const [rows, setRows] = React.useState<ObjectiveInput[]>(() => objectives.map(({ id, title, why, owner, cardKeys, health }) => ({ id, title, why, owner, cardKeys, health })));
  const [saving, setSaving] = React.useState(false);
  const edit = (id: string, patch: Partial<ObjectiveInput>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const save = async () => {
    setSaving(true);
    const ok = await dispatch({ type: 'home.objectives', objectives: objectivesToSave(rows) });
    setSaving(false);
    if (ok) onDone();
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {rows.map((r, i) => (
        <fieldset key={r.id} className="flex flex-col gap-1.5 rounded-lg border p-2.5">
          <Label htmlFor={`obj-title-${r.id}`}>Objective {i + 1}</Label>
          <Input id={`obj-title-${r.id}`} placeholder="What the floor is working towards" maxLength={200} value={r.title} onChange={(e) => edit(r.id, { title: e.target.value })} />
          <Textarea id={`obj-why-${r.id}`} aria-label="Why it matters" placeholder="Why it matters" maxLength={1000} rows={2} value={r.why} onChange={(e) => edit(r.id, { why: e.target.value })} />
          <span className="flex flex-wrap items-center gap-2">
            <select id={`obj-owner-${r.id}`} aria-label="Owner" className={select} value={r.owner} onChange={(e) => edit(r.id, { owner: e.target.value })}>
              <option value="">No owner</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select id={`obj-health-${r.id}`} aria-label="Health" className={select} value={r.health} onChange={(e) => edit(r.id, { health: e.target.value as ObjectiveHealth })}>
              {HEALTH.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
            </select>
            <Input id={`obj-cards-${r.id}`} aria-label="Board cards" className="h-8 flex-1" placeholder="Board cards, e.g. NSC-1, NSC-2" defaultValue={r.cardKeys.join(', ')} onBlur={(e) => edit(r.id, { cardKeys: parseCardKeys(e.target.value) })} />
            <Button type="button" size="sm" variant="ghost" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>Remove</Button>
          </span>
        </fieldset>
      ))}
      {rows.length === 0 && <span className="text-muted-foreground text-sm">No objectives. Add one, or save to clear the list.</span>}
      <span className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={rows.length >= MAX_OBJECTIVES} onClick={() => setRows((rs) => [...rs, newObjective(rs)])}>Add objective</Button>
        <span className="ml-auto flex gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving}>Save objectives</Button>
        </span>
      </span>
    </form>
  );
}
