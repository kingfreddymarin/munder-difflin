// NSC-231: right-click / Shift+F10 context menu on Board cards — rename, edit fields, move, archive.
// Follows the AgentActionMenuProvider pattern: one provider wraps the Board page, each
// BoardCard binds via useCardActionTarget(key).
import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/animate-ui/components/radix/dialog';
import { ToggleGroup, ToggleGroupItem } from '@/components/animate-ui/components/radix/toggle-group';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { UnsupportedReason } from '@/components/app/error-notice';
import { columns as columnMeta } from '@/components/app/card-detail';
import { useDispatch, useFloor, useUnsupported } from '@/data/store';
import type { Card, CardStatus } from '@/data/types';

type MenuState = { key: string; x: number; y: number } | null;
type ActionsContext = { bind(key: string): { onContextMenu(e: React.MouseEvent): void; onKeyDown(e: React.KeyboardEvent): void } };
const Context = React.createContext<ActionsContext | null>(null);
const PRIORITIES = [{ value: 1, label: 'P1' }, { value: 2, label: 'P2' }, { value: 3, label: 'P3' }] as const;

export function CardActionMenuProvider({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const cards = useFloor((s) => s.cards);
  const agents = useFloor((s) => s.agents);
  const order = useFloor((s) => s.board.columns);
  const [menu, setMenu] = React.useState<MenuState>(null);
  const [mode, setMode] = React.useState<'actions' | 'rename' | 'move'>('actions');
  const [status, setStatus] = React.useState('');
  const [rename, setRename] = React.useState('');
  const [editing, setEditing] = React.useState<Card | null>(null);

  const bind = React.useCallback((key: string) => ({
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setMenu({ key, x: e.clientX, y: e.clientY }); setMode('actions'); setStatus(''); },
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
        e.preventDefault();
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setMenu({ key, x: rect.left, y: rect.bottom });
        setMode('actions');
        setStatus('');
      }
    },
  }), []);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setStatus('Working…');
    try { await action(); setStatus(done); setMode('actions'); }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Action failed'); }
  };

  const card = menu ? cards.find((c) => c.key === menu.key) ?? null : null;

  return (
    <Context.Provider value={{ bind }}>
      {children}
      {menu && card && (
        <div className="fixed inset-0 z-[100]"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setMenu(null); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setMenu(null); }}>
          <section role="menu" aria-label={`Actions for ${card.key}`}
            className="fixed flex min-w-52 flex-col gap-1 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl"
            style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 225)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 290)) }}>
            {mode === 'actions' && <>
              <span className="px-2 py-0.5 text-xs font-medium text-muted-foreground">{card.key}</span>
              <Button role="menuitem" variant="ghost" className="justify-start"
                onClick={() => { setRename(card.title); setMode('rename'); }}>Rename…</Button>
              <Button role="menuitem" variant="ghost" className="justify-start"
                onClick={() => { setEditing(card); setMenu(null); }}>Edit fields…</Button>
              <Button role="menuitem" variant="ghost" className="justify-start"
                onClick={() => setMode('move')}>Move to…</Button>
              <Button role="menuitem" variant="ghost" className="justify-start"
                disabled={!!unsupported({ type: 'card.move', key: card.key, status: 'done' as CardStatus })}
                onClick={() => void run(() => dispatch({ type: 'card.move', key: card.key, status: 'done' as CardStatus }), 'Archived.').then(() => setMenu(null))}>
                Archive
              </Button>
            </>}
            {mode === 'rename' && (
              <form className="flex flex-col gap-2 p-1" onSubmit={(e) => {
                e.preventDefault();
                void run(() => dispatch({ type: 'card.update', key: card.key, patch: { title: rename.trim() } }), 'Renamed.').then(() => setMenu(null));
              }}>
                <label htmlFor="card-rename" className="text-xs">New title</label>
                <input autoFocus id="card-rename" className="rounded border bg-background px-2 py-1 text-sm" value={rename}
                  onChange={(e) => setRename(e.target.value)} maxLength={200} />
                <Button size="sm" disabled={!rename.trim() || rename.trim() === card.title}>Save</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setMode('actions')}>Cancel</Button>
              </form>
            )}
            {mode === 'move' && <>
              <span className="px-2 py-0.5 text-xs text-muted-foreground">Move {card.key} to</span>
              {(order as CardStatus[]).filter((s) => s !== card.status).map((s) => {
                const col = columnMeta.find((c) => c.id === s);
                const reason = unsupported({ type: 'card.move', key: card.key, status: s });
                return (
                  <Button key={s} role="menuitem" variant="ghost" className="justify-start" disabled={!!reason} title={reason ?? undefined}
                    onClick={() => void run(() => dispatch({ type: 'card.move', key: card.key, status: s }), 'Moved.').then(() => setMenu(null))}>
                    {col?.label ?? s}
                  </Button>
                );
              })}
              <Button role="menuitem" variant="ghost" className="justify-start text-xs" onClick={() => setMode('actions')}>← Back</Button>
            </>}
            {status && <p role="status" className="px-2 text-xs text-muted-foreground">{status}</p>}
          </section>
        </div>
      )}
      {editing && <EditCardDialog card={editing} agents={agents} onClose={() => setEditing(null)} />}
    </Context.Provider>
  );
}

function EditCardDialog({ card, agents, onClose }: { card: Card; agents: { id: string; name: string }[]; onClose: () => void }) {
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const [form, setForm] = React.useState({
    title: card.title,
    description: card.description,
    assignee: card.agentId,
    priority: (card.priority === 'P1' ? 1 : card.priority === 'P3' ? 3 : 2) as 1 | 2 | 3,
  });
  const [sending, setSending] = React.useState(false);

  const command = {
    type: 'card.update' as const,
    key: card.key,
    patch: { title: form.title.trim(), description: form.description, assignee: form.assignee, priority: form.priority },
  };
  const reason = unsupported(command);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || reason) return;
    setSending(true);
    const ok = await dispatch(command);
    setSending(false);
    if (ok) onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {card.key}</DialogTitle>
          <DialogDescription>Update the card's fields. Changes take effect on the next agent turn.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ec-title">Title</Label>
            <Input id="ec-title" autoFocus maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value.replace(/[\r\n]/g, ' ') })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ec-desc">Description</Label>
            <Textarea id="ec-desc" rows={4} maxLength={10_000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ec-agent">Assignee</Label>
            <select id="ec-agent" className="border-input bg-background h-9 rounded-md border px-2 text-sm" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}>
              <option value="">Unassigned</option>
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
          <UnsupportedReason reason={reason} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!form.title.trim() || !!reason || sending}>{sending ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function useCardActionTarget(key: string): ReturnType<ActionsContext['bind']> {
  const context = React.useContext(Context);
  return React.useMemo(() => context?.bind(key) ?? ({} as ReturnType<ActionsContext['bind']>), [key, context]);
}
