// NSC-261: Creates one card on the hive task ledger with all card fields visible on first open.
// One card.create call carries all fields; dependsOn is a string[] in the ledger (displayed joined).
// See COMMANDS.md Board Tasks for the agent path.
import * as React from 'react';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/animate-ui/components/radix/dialog';
import { ToggleGroup, ToggleGroupItem } from '@/components/animate-ui/components/radix/toggle-group';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { UnsupportedReason } from '@/components/app/error-notice';
import { useDispatch, useFloor, useUnsupported } from '@/data/store';

const PRIORITIES = [{ value: 1, label: 'P1' }, { value: 2, label: 'P2' }, { value: 3, label: 'P3' }] as const;
const STATUSES: { value: 'todo' | 'blocked'; label: string }[] = [
  { value: 'todo', label: 'To do' },
  { value: 'blocked', label: 'Blocked' },
];

export interface NewCardFields {
  title: string;
  description: string;
  assignee: string;
  priority: 1 | 2 | 3;
  status: 'todo' | 'blocked';
  parentId: string;
  dependsOn: string;
  blockItemDraft: string;
  blockItems: string[];
}

export function newCardDefaults(assignee?: string): NewCardFields {
  return { title: '', description: '', assignee: assignee ?? '', priority: 2, status: 'todo', parentId: '', dependsOn: '', blockItemDraft: '', blockItems: [] };
}

export function NewCardDialog({ open, onClose, onCreated, assignee }: { open: boolean; onClose: () => void; onCreated?: (key: string) => void; assignee?: string }) {
  const agents = useFloor((s) => s.agents);
  const cards = useFloor((s) => s.cards);
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const generationRef = React.useRef(0);
  const [form, setForm] = React.useState<NewCardFields>(() => newCardDefaults(assignee));
  const [sending, setSending] = React.useState(false);
  const [status, setStatus] = React.useState('');
  React.useEffect(() => { if (open) { setForm(newCardDefaults(assignee)); setStatus(''); } }, [open, assignee]);

  const activeCards = React.useMemo(
    () => cards.filter((c) => !c.boardArchivedAt && c.status !== 'done'),
    [cards],
  );

  const command = {
    type: 'card.create' as const,
    title: form.title.trim(),
    priority: form.priority,
    status: form.status,
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    ...(form.assignee ? { assignee: form.assignee } : {}),
    ...(form.parentId ? { parentId: form.parentId } : {}),
    ...(form.dependsOn.trim() ? { dependsOn: [form.dependsOn.trim()] } : {}),
    ...(form.blockItems.length > 0 ? { blockItems: form.blockItems } : {}),
  };
  const reason = unsupported(command);

  const handleClose = () => { generationRef.current++; onClose(); };

  const addBlockItem = (e: React.FormEvent) => {
    e.preventDefault();
    const text = form.blockItemDraft.trim();
    if (!text) return;
    setForm({ ...form, blockItemDraft: '', blockItems: [...form.blockItems, text] });
  };

  const removeBlockItem = (i: number) => {
    setForm({ ...form, blockItems: form.blockItems.filter((_, idx) => idx !== i) });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!command.title || reason) return;
    setSending(true);
    setStatus('Creating…');
    const myGeneration = ++generationRef.current;
    const result = await dispatch(command);
    if (!result || generationRef.current !== myGeneration) { setSending(false); setStatus('Could not create card. Try again.'); return; }
    const key = typeof result === 'string' ? result : null;

    setSending(false);
    if (generationRef.current === myGeneration) {
      if (key) onCreated?.(key);
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New card</DialogTitle>
          <DialogDescription>All fields are available upfront. Title is the only required field; agents pick up the card on their next turn.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form id="new-card-form" onSubmit={submit} className="flex flex-col gap-3">

            {/* Title */}
            <div className="grid gap-1.5">
              <Label htmlFor="nc-title">Title</Label>
              <Input id="nc-title" autoFocus maxLength={200} value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value.replace(/[\r\n]/g, ' ') })} />
            </div>

            {/* Description */}
            <div className="grid gap-1.5">
              <Label htmlFor="nc-desc">Description</Label>
              <Textarea id="nc-desc" rows={4} maxLength={10_000} value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>

            {/* Assignee + Priority side by side */}
            <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
              <div className="grid gap-1.5">
                <Label htmlFor="nc-agent">Assignee</Label>
                <select id="nc-agent" className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                  value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}>
                  <option value="">Unassigned (Paramount routes it)</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label>Priority</Label>
                <ToggleGroup type="single" variant="outline" size="sm" value={String(form.priority)}
                  onValueChange={(v) => v && setForm({ ...form, priority: Number(v) as 1 | 2 | 3 })}>
                  {PRIORITIES.map((p) => <ToggleGroupItem key={p.value} value={String(p.value)} className="px-3 text-xs">{p.label}</ToggleGroupItem>)}
                </ToggleGroup>
              </div>
            </div>

            {/* Status */}
            <div className="grid gap-1.5">
              <Label>Initial status</Label>
              <ToggleGroup type="single" variant="outline" size="sm" value={form.status}
                onValueChange={(v) => v && setForm({ ...form, status: v as 'todo' | 'blocked' })}>
                {STATUSES.map((s) => <ToggleGroupItem key={s.value} value={s.value} className="px-3 text-xs">{s.label}</ToggleGroupItem>)}
              </ToggleGroup>
            </div>

            {/* Parent card */}
            <div className="grid gap-1.5">
              <Label htmlFor="nc-parent">Parent card</Label>
              <select id="nc-parent" className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
                <option value="">No parent</option>
                {activeCards.map((c) => <option key={c.key} value={c.key}>{c.key} · {c.title}</option>)}
              </select>
            </div>

            {/* Depends on */}
            <div className="grid gap-1.5">
              <Label htmlFor="nc-depends">Depends on <span className="text-muted-foreground font-normal text-xs">(card key — stored as dependsOn in tasks.json)</span></Label>
              <Input id="nc-depends" placeholder="e.g. NSC-42" maxLength={40} value={form.dependsOn}
                onChange={(e) => setForm({ ...form, dependsOn: e.target.value.trim() })} />
            </div>

            {/* Unblock items (NSC-257) */}
            <div className="grid gap-1.5">
              <Label>Unblock items <span className="text-muted-foreground font-normal text-xs">(shown when card is blocked)</span></Label>
              {form.blockItems.length > 0 && (
                <ul className="flex flex-col gap-0.5">
                  {form.blockItems.map((item, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm">
                      <span className="size-1.5 shrink-0 rounded-full bg-amber-400 mt-0.5" />
                      <span className="flex-1">{item}</span>
                      <button type="button" onClick={() => removeBlockItem(i)} className="text-muted-foreground hover:text-foreground text-xs">×</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <Input placeholder="Add unblock item…" maxLength={200} value={form.blockItemDraft}
                  onChange={(e) => setForm({ ...form, blockItemDraft: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBlockItem(e); } }} />
                <Button type="button" size="sm" variant="outline" onClick={addBlockItem} disabled={!form.blockItemDraft.trim()}>Add</Button>
              </div>
            </div>

            <UnsupportedReason reason={reason} />
            {status && <p role="status" className="text-muted-foreground text-xs">{status}</p>}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={handleClose} disabled={sending}>Cancel</Button>
          <Button type="submit" form="new-card-form" disabled={!command.title || !!reason || sending}>{sending ? 'Creating…' : 'Create card'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
