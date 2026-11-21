// STD-4: edit the floor's Main Objectives in place on Home. Save sends home.objectives; the core
// validates and persists it, so the list survives restarts. Cancel discards the draft.
// NSC-232: each objective's linked cards are chosen from a dropdown of open Board cards (non-done);
// "New card" opens the creation dialog and auto-links the card on success.
import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useDispatch } from '@/data/store';
import { MAX_OBJECTIVES, newObjective, objectivesToSave, type ObjectiveHealth, type ObjectiveInput } from '@/data/objectives';
import { NewCardDialog } from '@/features/team/new-card-dialog';
import type { Agent, Card, Objective } from '@/data/types';

const HEALTH: { id: ObjectiveHealth; label: string }[] = [{ id: 'on-track', label: 'On track' }, { id: 'at-risk', label: 'At risk' }, { id: 'blocked', label: 'Blocked' }];
const select = 'border-input bg-background h-8 rounded-md border px-2 text-sm';

/** Chips + dropdown selector for the Board cards linked to one objective. */
function CardPicker({ objectiveId, cardKeys, openCards, onEdit }: {
  objectiveId: string;
  cardKeys: string[];
  openCards: Pick<Card, 'key' | 'title'>[];
  onEdit: (patch: { cardKeys: string[] }) => void;
}) {
  const newBtnRef = React.useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = React.useState(false);

  const addKey = (key: string) => {
    if (key && !cardKeys.includes(key)) onEdit({ cardKeys: [...cardKeys, key] });
  };
  const removeKey = (key: string) => onEdit({ cardKeys: cardKeys.filter((k) => k !== key) });

  const handleDialogClose = () => {
    setCreating(false);
    newBtnRef.current?.focus();
  };

  const available = openCards.filter((c) => !cardKeys.includes(c.key));
  // Show chips for all linked keys; resolve title where the card is in the open list.
  const linked = cardKeys.map((key) => ({ key, title: openCards.find((c) => c.key === key)?.title }));

  return (
    <div className="flex flex-col gap-1">
      {linked.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid={`obj-card-chips-${objectiveId}`}>
          {linked.map(({ key, title }) => (
            <span key={key} className="border-input bg-muted flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs">
              <span>{key}{title ? ` · ${title.length > 28 ? title.slice(0, 28) + '…' : title}` : ''}</span>
              <button type="button" aria-label={`Remove ${key}`} className="text-muted-foreground hover:text-foreground" onClick={() => removeKey(key)}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {available.length > 0 && (
          <select
            id={`obj-card-select-${objectiveId}`}
            aria-label="Add existing card"
            className={select}
            value=""
            data-testid={`obj-card-select-${objectiveId}`}
            onChange={(e) => { addKey(e.target.value); e.target.value = ''; }}
          >
            <option value="">Add card…</option>
            {available.map((c) => (
              <option key={c.key} value={c.key}>{c.key} · {c.title.length > 50 ? c.title.slice(0, 50) + '…' : c.title}</option>
            ))}
          </select>
        )}
        <Button
          ref={newBtnRef}
          type="button"
          size="sm"
          variant="ghost"
          data-testid={`obj-card-new-${objectiveId}`}
          onClick={() => setCreating(true)}
        >
          + New card
        </Button>
      </div>
      <NewCardDialog open={creating} onClose={handleDialogClose} onCreated={(key) => addKey(key)} />
    </div>
  );
}

/** Exported for unit tests only. */
export { CardPicker };

export function ObjectivesEditor({ objectives, agents, openCards, onDone }: {
  objectives: Objective[];
  agents: Pick<Agent, 'id' | 'name'>[];
  /** Open (non-done) Board cards to offer for selection. */
  openCards: Pick<Card, 'key' | 'title' | 'status'>[];
  onDone: () => void;
}) {
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
            <Button type="button" size="sm" variant="ghost" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>Remove</Button>
          </span>
          <Label htmlFor={`obj-card-select-${r.id}`}>Board cards</Label>
          <CardPicker objectiveId={r.id} cardKeys={r.cardKeys} openCards={openCards} onEdit={(patch) => edit(r.id, patch)} />
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
