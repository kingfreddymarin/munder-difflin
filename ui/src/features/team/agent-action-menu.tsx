import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { useDispatch, useTeamApi } from '@/data/store';

type MenuState = { id: string; x: number; y: number } | null;
type ActionsContext = { bind(id: string): { onContextMenu: (event: React.MouseEvent) => void; onKeyDown: (event: React.KeyboardEvent) => void } };
const Context = React.createContext<ActionsContext | null>(null);

export function AgentActionMenuProvider({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();
  const api = useTeamApi();
  const [menu, setMenu] = React.useState<MenuState>(null);
  const [note, setNote] = React.useState('');
  const [rename, setRename] = React.useState('');
  const [mode, setMode] = React.useState<'actions' | 'note' | 'rename' | 'restart'>('actions');
  const [status, setStatus] = React.useState('');
  const bind = React.useCallback((id: string) => ({
    onContextMenu: (event: React.MouseEvent) => { event.preventDefault(); setMenu({ id, x: event.clientX, y: event.clientY }); setMode('actions'); setStatus(''); },
    onKeyDown: (event: React.KeyboardEvent) => {
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ id, x: rect.left, y: rect.bottom }); setMode('actions'); setStatus(''); }
    },
  }), []);
  const run = async (action: () => Promise<unknown>, done: string) => {
    setStatus('Working…');
    try { await action(); setStatus(done); setMode('actions'); }
    catch (error) { setStatus(error instanceof Error ? error.message : 'Action failed'); }
  };
  return <Context.Provider value={{ bind }}>
    {children}
    {menu && <div className="fixed inset-0 z-[100]" onMouseDown={(event) => { if (event.target === event.currentTarget) setMenu(null); }} onKeyDown={(event) => { if (event.key === 'Escape') setMenu(null); }}>
      <section role="menu" aria-label={`Actions for ${menu.id}`} className="fixed flex min-w-52 flex-col gap-1 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl" style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 225)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 250)) }}>
        {mode === 'actions' && <>
          <Button role="menuitem" variant="ghost" className="justify-start" onClick={() => { setRename(''); setMode('rename'); }}>Rename</Button>
          <Button role="menuitem" variant="ghost" className="justify-start" onClick={() => setMode('restart')}>Restart…</Button>
          <Button role="menuitem" variant="ghost" className="justify-start" onClick={() => void run(async () => { if (!api?.archiveAgent) throw new Error('Archive is unavailable'); await api.archiveAgent(menu.id, true); setMenu(null); }, 'Archived with history preserved.')}>Archive</Button>
          <Button role="menuitem" variant="ghost" className="justify-start" onClick={() => { setNote(''); setMode('note'); }}>Send note…</Button>
        </>}
        {mode === 'restart' && <><span className="px-2 py-1 text-xs text-muted-foreground">Restart {menu.id}</span><Button role="menuitem" variant="ghost" className="justify-start" onClick={() => void run(() => dispatch({ type: 'agent.restart', agentId: menu.id, mode: 'resume' }), 'Resume requested.')}>Resume session</Button><Button role="menuitem" variant="ghost" className="justify-start" onClick={() => void run(() => dispatch({ type: 'agent.restart', agentId: menu.id, mode: 'fresh' }), 'Fresh session requested.')}>Start fresh</Button></>}
        {mode === 'rename' && <form className="flex flex-col gap-2 p-1" onSubmit={(event) => { event.preventDefault(); void run(() => dispatch({ type: 'agent.update', agentId: menu.id, patch: { name: rename.trim() } }), 'Name updated.'); }}><label htmlFor="agent-rename" className="text-xs">New name</label><input autoFocus id="agent-rename" className="rounded border bg-background px-2 py-1 text-sm" value={rename} onChange={(event) => setRename(event.target.value)} maxLength={80} /><Button size="sm" disabled={!rename.trim()}>Save name</Button><Button type="button" size="sm" variant="ghost" onClick={() => setMode('actions')}>Cancel</Button></form>}
        {mode === 'note' && <form className="flex flex-col gap-2 p-1" onSubmit={(event) => { event.preventDefault(); void run(async () => { if (!api?.sendNote) throw new Error('Notes are unavailable'); await api.sendNote(menu.id, note); setMenu(null); }, 'Note sent.'); }}><label htmlFor="agent-note" className="text-xs">Note for {menu.id}</label><textarea autoFocus id="agent-note" className="min-h-20 rounded border bg-background p-2 text-sm" value={note} onChange={(event) => setNote(event.target.value)} maxLength={5000} /><Button size="sm" disabled={!note.trim()}>Send note</Button><Button type="button" size="sm" variant="ghost" onClick={() => setMode('actions')}>Cancel</Button></form>}
        {status && <p role="status" className="px-2 text-xs text-muted-foreground">{status}</p>}
      </section>
    </div>}
  </Context.Provider>;
}

export function useAgentActionTargets(ids: string[]): Record<string, ReturnType<ActionsContext['bind']>> {
  const context = React.useContext(Context);
  return React.useMemo(() => Object.fromEntries(ids.map((id) => [id, context?.bind(id) ?? {}])) as Record<string, ReturnType<ActionsContext['bind']>>, [ids.join('\0'), context]);
}
