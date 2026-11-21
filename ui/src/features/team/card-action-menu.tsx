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
import type { Card } from '@/data/types';
import type { Command } from '@/data/protocol';
import type { ParamountCardPatch } from '@/data/paramount-api';

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
  const [sending, setSending] = React.useState(false);
  const panel = React.useRef<HTMLElement>(null);
  const origin = React.useRef<{ key: string; element: HTMLElement } | null>(null);

  const restoreFocus = React.useCallback(() => {
    const target = origin.current;
    origin.current = null;
    if (!target) return;
    requestAnimationFrame(() => {
      const card = target.element.isConnected ? target.element
        : document.querySelector<HTMLElement>(`[data-board-card="${CSS.escape(target.key)}"]`);
      (card ?? document.querySelector<HTMLElement>('[data-board-focus-fallback]'))?.focus();
    });
  }, []);

  const closeMenu = React.useCallback(() => {
    setMenu(null);
    restoreFocus();
  }, [restoreFocus]);

  const bind = React.useCallback((key: string) => {
    const open = (element: HTMLElement, x: number, y: number) => {
      origin.current = { key, element };
      setMenu({ key, x, y });
      setMode('actions');
      setStatus('');
    };
    return {
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        open(e.currentTarget as HTMLElement, e.clientX, e.clientY);
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
          e.preventDefault();
          const element = e.currentTarget as HTMLElement;
          const rect = element.getBoundingClientRect();
          open(element, rect.left, rect.bottom);
        }
      },
    };
  }, []);

  const run = async (command: Command) => {
    if (sending || unsupported(command)) return;
    setSending(true);
    setStatus('Working…');
    try {
      if (await dispatch(command)) closeMenu();
      else setStatus('Could not save. Try again.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setSending(false);
    }
  };

  const card = menu ? cards.find((c) => c.key === menu.key) ?? null : null;
  const menuItems = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
  React.useLayoutEffect(() => {
    if (menu && mode !== 'rename') (menuItems()[0] ?? panel.current)?.focus();
  }, [menu, mode]);

  React.useLayoutEffect(() => {
    if (!status || sending || !panel.current || panel.current.contains(document.activeElement)) return;
    (panel.current.querySelector('input') ?? menuItems()[0] ?? panel.current).focus();
  }, [status, sending]);

  React.useEffect(() => {
    if (!menu) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (!sending) closeMenu();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [menu, sending, closeMenu]);

  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab' && mode !== 'rename') {
      e.preventDefault();
      if (!sending) closeMenu();
      return;
    }
    if (mode === 'rename' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const items = menuItems();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : e.key === 'ArrowDown' ? (current + 1) % items.length
      : current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const renameCommand = { type: 'card.update', key: card?.key ?? '', patch: { title: rename.trim() } } as const;
  const updateReason = card ? unsupported(renameCommand) : null;
  const archiveCommand = { type: 'card.archive', key: card?.key ?? '' } as const;
  const archiveReason = card ? unsupported(archiveCommand) : null;

  return (
    <Context.Provider value={{ bind }}>
      {children}
      {menu && card && (
        <div className="fixed inset-0 z-[100]"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !sending) closeMenu(); }}>
          <section ref={panel} role={mode === 'rename' ? 'group' : 'menu'} tabIndex={-1}
            aria-label={mode === 'rename' ? `Rename ${card.key}` : `Actions for ${card.key}`} onKeyDown={onPanelKey}
            className="fixed flex min-w-52 flex-col gap-1 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl"
            style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 225)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 290)) }}>
            {mode === 'actions' && <>
              <span className="px-2 py-0.5 text-xs font-medium text-muted-foreground">{card.key}</span>
              <Button role="menuitem" tabIndex={-1} variant="ghost" className="justify-start"
                disabled={!!updateReason || sending} title={updateReason ?? undefined}
                onClick={() => { setRename(card.title); setMode('rename'); }}>Rename…</Button>
              <Button role="menuitem" tabIndex={-1} variant="ghost" className="justify-start"
                disabled={!!updateReason || sending} title={updateReason ?? undefined}
                onClick={() => { setEditing(card); setMenu(null); }}>Edit fields…</Button>
              <Button role="menuitem" tabIndex={-1} variant="ghost" className="justify-start" disabled={sending}
                onClick={() => setMode('move')}>Move to…</Button>
              <Button role="menuitem" tabIndex={-1} variant="ghost" className="justify-start"
                disabled={!!archiveReason} aria-disabled={sending} title={archiveReason ?? undefined}
                onClick={() => void run(archiveCommand)}>
                Archive
              </Button>
            </>}
            {mode === 'rename' && (
              <form className="flex flex-col gap-2 p-1" onSubmit={(e) => {
                e.preventDefault();
                if (rename.trim() && rename.trim() !== card.title.trim()) void run(renameCommand);
              }}>
                <label htmlFor="card-rename" className="text-xs">New title</label>
                <input autoFocus id="card-rename" className="rounded border bg-background px-2 py-1 text-sm" value={rename}
                  onChange={(e) => setRename(e.target.value)} maxLength={200} />
                <Button size="sm" aria-disabled={sending} disabled={!!updateReason || !rename.trim() || rename.trim() === card.title.trim()}>Save</Button>
                <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={() => { setStatus(''); setMode('actions'); }}>Cancel</Button>
              </form>
            )}
            {mode === 'move' && <>
              <span className="px-2 py-0.5 text-xs text-muted-foreground">Move {card.key} to</span>
              {order.filter((s) => s !== card.status).map((s) => {
                const col = columnMeta.find((c) => c.id === s);
                const command = { type: 'card.move', key: card.key, status: s } as const;
                const reason = unsupported(command);
                return (
                  <Button key={s} role="menuitem" tabIndex={-1} variant="ghost" className="justify-start" disabled={!!reason} aria-disabled={sending} title={reason ?? undefined}
                    onClick={() => void run(command)}>
                    {col?.label ?? s}
                  </Button>
                );
              })}
              <Button role="menuitem" tabIndex={-1} variant="ghost" className="justify-start text-xs" disabled={sending}
                onClick={() => { setStatus(''); setMode('actions'); }}>← Back</Button>
            </>}
            {status && <p role="status" className="px-2 text-xs text-muted-foreground">{status}</p>}
          </section>
        </div>
      )}
      {editing && <EditCardDialog card={editing} agents={agents}
        onClose={() => { setEditing(null); restoreFocus(); }} />}
    </Context.Provider>
  );
}

function EditCardDialog({ card, agents, onClose }: { card: Card; agents: { id: string; name: string }[]; onClose: () => void }) {
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const initialPriority = PRIORITIES.find((priority) => priority.label === card.priority)?.value;
  const [form, setForm] = React.useState({
    title: card.title,
    description: card.description,
    assignee: card.agentId,
    priority: initialPriority,
  });
  const [sending, setSending] = React.useState(false);
  const [saveFailed, setSaveFailed] = React.useState(false);

  const patch: ParamountCardPatch = {};
  if (form.title.trim() !== card.title.trim()) patch.title = form.title.trim();
  if (form.description !== card.description) patch.description = form.description;
  if (form.assignee !== card.agentId) patch.assignee = form.assignee;
  if (form.priority !== undefined && form.priority !== initialPriority) patch.priority = form.priority;
  const dirty = Object.keys(patch).length > 0;
  const command = { type: 'card.update', key: card.key, patch } as const;
  const reason = unsupported(command);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || patch.title === '' || reason || sending) return;
    setSending(true);
    setSaveFailed(false);
    const ok = await dispatch(command);
    setSending(false);
    if (ok) onClose();
    else setSaveFailed(true);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !sending && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={(event) => event.preventDefault()}>
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
            <ToggleGroup type="single" variant="outline" size="sm" value={form.priority === undefined ? '' : String(form.priority)}
              onValueChange={(v) => v && setForm({ ...form, priority: Number(v) as 1 | 2 | 3 })}>
              {PRIORITIES.map((p) => <ToggleGroupItem key={p.value} value={String(p.value)} className="px-3 text-xs">{p.label}</ToggleGroupItem>)}
            </ToggleGroup>
          </div>
          <UnsupportedReason reason={reason} />
          {saveFailed && <p role="status" className="text-sm text-destructive">Could not save. Try again.</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={sending} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!dirty || patch.title === '' || !!reason} aria-disabled={sending}>{sending ? 'Saving…' : 'Save'}</Button>
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
