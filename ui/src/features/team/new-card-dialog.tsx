// Creates one card on the hive task ledger through the core (`card.create`). The core picks the key;
// a failure keeps the dialog open and shows the core's errorId + code with Copy diagnostics.
import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/animate-ui/components/radix/dialog';
import { ToggleGroup, ToggleGroupItem } from '@/components/animate-ui/components/radix/toggle-group';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { UnsupportedReason } from '@/components/app/error-notice';
import { useDispatch, useFloor, useUnsupported } from '@/data/store';

const PRIORITIES = [{ value: 1, label: 'P1' }, { value: 2, label: 'P2' }, { value: 3, label: 'P3' }] as const;

export function NewCardDialog({ open, onClose, assignee }: { open: boolean; onClose: () => void; assignee?: string }) {
  const agents = useFloor((s) => s.agents);
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const empty = React.useCallback(() => ({ title: '', description: '', assignee: assignee ?? '', priority: 2 as 1 | 2 | 3 }), [assignee]);
  const [form, setForm] = React.useState(empty);
  const [sending, setSending] = React.useState(false);
  React.useEffect(() => { if (open) setForm(empty()); }, [open, empty]);

  const command = { type: 'card.create' as const, title: form.title.trim(), priority: form.priority,
    ...(form.description.trim() ? { description: form.description.trim() } : {}), ...(form.assignee ? { assignee: form.assignee } : {}) };
  const reason = unsupported(command);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.title || reason) return;
    setSending(true);
    const ok = await dispatch(command);
    setSending(false);
    if (ok) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New card</DialogTitle>
          <DialogDescription>Added to the board in todo. The assigned agent picks it up on its next turn.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="grid gap-1.5"><Label htmlFor="nc-title">Title</Label>
            <Input id="nc-title" autoFocus maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value.replace(/[\r\n]/g, ' ') })} /></div>
          <div className="grid gap-1.5"><Label htmlFor="nc-desc">Description</Label>
            <Textarea id="nc-desc" rows={4} maxLength={10_000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label htmlFor="nc-agent">Assignee</Label>
            <select id="nc-agent" className="border-input bg-background h-9 rounded-md border px-2 text-sm" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}>
              <option value="">Unassigned (Paramount routes it)</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></div>
          <div className="grid gap-1.5"><Label>Priority</Label>
            <ToggleGroup type="single" variant="outline" size="sm" value={String(form.priority)} onValueChange={(v) => v && setForm({ ...form, priority: Number(v) as 1 | 2 | 3 })}>
              {PRIORITIES.map((p) => <ToggleGroupItem key={p.value} value={String(p.value)} className="px-3 text-xs">{p.label}</ToggleGroupItem>)}
            </ToggleGroup></div>
          <UnsupportedReason reason={reason} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!command.title || !!reason || sending}>{sending ? 'Creating…' : 'Create card'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
