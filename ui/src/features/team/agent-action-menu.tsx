import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { useAgentActions } from './agent-actions';
import { useDispatch, useFloor, useTeamApi } from '@/data/store';

type MenuState = { id: string; x: number; y: number } | null;
type ActionsContext = {
  bind(id: string): {
    onContextMenu: (event: React.MouseEvent) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
  };
};
const Context = React.createContext<ActionsContext | null>(null);

/** Rendered only while a menu is open; holds per-agent hook state. */
function AgentMenuInner({
  agentId,
  position,
  onClose,
}: {
  agentId: string;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  type Mode = 'actions' | 'rename' | 'note' | 'restart';
  const [mode, setMode] = React.useState<Mode>('actions');
  const [status, setStatus] = React.useState('');
  const [inputVal, setInputVal] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const panelRef = React.useRef<HTMLElement>(null);
  const agents = useFloor((s) => s.agents);
  const agentName = agents.find((a) => a.id === agentId)?.name ?? agentId;
  const dispatch = useDispatch();
  const teamApi = useTeamApi();

  const { actions, run, renameAgent } = useAgentActions(agentId, {
    onClose,
    onRenameStart: () => { setInputVal(agentName); setMode('rename'); setStatus(''); },
    onNoteStart: () => { setInputVal(''); setMode('note'); setStatus(''); },
    onRestartStart: () => { setMode('restart'); setStatus(''); },
  });

  const menuItems = () =>
    Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);

  React.useLayoutEffect(() => {
    if (mode === 'actions') menuItems()[0]?.focus();
  }, [mode]);

  const onPanelKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { onClose(); return; }
    if (mode !== 'actions') return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = menuItems();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % items.length
      : current <= 0 ? items.length - 1 : current - 1;
    items[next]?.focus();
  };

  const doRun = async (id: Parameters<typeof run>[0]) => {
    setSending(true);
    setStatus('');
    try {
      await run(id);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setSending(false);
    }
  };

  const submitRename = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = inputVal.trim();
    if (!name) return;
    setSending(true);
    setStatus('');
    try {
      const result = await renameAgent(name);
      if (result.ok) { setStatus(`Renamed to ${result.name ?? name}.`); setMode('actions'); }
      else setStatus(result.error ?? 'Could not rename.');
    } finally {
      setSending(false);
    }
  };

  const submitNote = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = inputVal.trim();
    if (!text || !teamApi?.sendNote) return;
    setSending(true);
    setStatus('');
    try {
      await teamApi.sendNote(agentId, text);
      onClose();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not send note.');
    } finally {
      setSending(false);
    }
  };

  const restartAgent = async (mode: 'resume' | 'fresh') => {
    setSending(true);
    setStatus('');
    try {
      await dispatch({ type: 'agent.restart', agentId, mode });
      setStatus(mode === 'resume' ? 'Resume requested.' : 'Fresh session requested.');
      setMode('actions');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Restart failed.');
    } finally {
      setSending(false);
    }
  };

  const left = Math.max(8, Math.min(position.x, window.innerWidth - 225));
  const top = Math.max(8, Math.min(position.y, window.innerHeight - 320));

  return (
    <div
      className="fixed inset-0 z-[100]"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !sending) onClose(); }}
    >
      <section
        ref={panelRef}
        role={mode === 'actions' ? 'menu' : 'group'}
        aria-label={mode === 'actions' ? `Actions for ${agentName}` : mode === 'rename' ? `Rename ${agentName}` : mode === 'note' ? `Send note to ${agentName}` : `Restart ${agentName}`}
        tabIndex={-1}
        className="fixed flex min-w-52 flex-col gap-1 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl"
        style={{ left, top }}
        onKeyDown={onPanelKeyDown}
      >
        {mode === 'actions' && (
          <>
            <span className="px-2 py-0.5 text-xs font-medium text-muted-foreground">{agentName}</span>
            {actions.map((action) => (
              <Button
                key={action.id}
                role="menuitem"
                tabIndex={-1}
                variant="ghost"
                className="justify-start"
                disabled={action.disabled || sending}
                onClick={() => void doRun(action.id)}
              >
                {action.label}
              </Button>
            ))}
          </>
        )}

        {mode === 'rename' && (
          <form className="flex flex-col gap-2 p-1" onSubmit={(event) => void submitRename(event)}>
            <label htmlFor="agent-rename" className="text-xs">New name for {agentName}</label>
            <input
              autoFocus
              id="agent-rename"
              className="rounded border bg-background px-2 py-1 text-sm"
              value={inputVal}
              onChange={(event) => setInputVal(event.target.value)}
              maxLength={80}
            />
            <Button size="sm" disabled={!inputVal.trim() || sending}>
              {sending ? 'Saving…' : 'Save name'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={() => setMode('actions')}>
              Cancel
            </Button>
          </form>
        )}

        {mode === 'note' && (
          <form className="flex flex-col gap-2 p-1" onSubmit={(event) => void submitNote(event)}>
            <label htmlFor="agent-note" className="text-xs">Note for {agentName}</label>
            <textarea
              autoFocus
              id="agent-note"
              className="min-h-20 rounded border bg-background p-2 text-sm"
              value={inputVal}
              onChange={(event) => setInputVal(event.target.value)}
              maxLength={5000}
            />
            <Button size="sm" disabled={!inputVal.trim() || sending}>
              {sending ? 'Sending…' : 'Send note'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={() => setMode('actions')}>
              Cancel
            </Button>
          </form>
        )}

        {mode === 'restart' && (
          <>
            <span className="px-2 py-1 text-xs text-muted-foreground">Restart {agentName}</span>
            <Button
              role="menuitem"
              tabIndex={-1}
              variant="ghost"
              className="justify-start"
              disabled={sending}
              onClick={() => void restartAgent('resume')}
            >
              Resume session
            </Button>
            <Button
              role="menuitem"
              tabIndex={-1}
              variant="ghost"
              className="justify-start"
              disabled={sending}
              onClick={() => void restartAgent('fresh')}
            >
              Start fresh
            </Button>
            <Button
              type="button"
              role="menuitem"
              tabIndex={-1}
              variant="ghost"
              className="justify-start text-xs"
              disabled={sending}
              onClick={() => setMode('actions')}
            >
              ← Back
            </Button>
          </>
        )}

        {status && (
          <p role="status" className="px-2 text-xs text-muted-foreground">
            {status}
          </p>
        )}
      </section>
    </div>
  );
}

export function AgentActionMenuProvider({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = React.useState<MenuState>(null);

  const bind = React.useCallback(
    (id: string) => ({
      onContextMenu: (event: React.MouseEvent) => {
        event.preventDefault();
        setMenu({ id, x: event.clientX, y: event.clientY });
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
          event.preventDefault();
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu({ id, x: rect.left, y: rect.bottom });
        }
      },
    }),
    [],
  );

  return (
    <Context.Provider value={{ bind }}>
      {children}
      {menu && (
        <AgentMenuInner
          agentId={menu.id}
          position={menu}
          onClose={() => setMenu(null)}
        />
      )}
    </Context.Provider>
  );
}

export function useAgentActionTargets(
  ids: string[],
): Record<string, ReturnType<ActionsContext['bind']>> {
  const context = React.useContext(Context);
  return React.useMemo(
    () =>
      Object.fromEntries(ids.map((id) => [id, context?.bind(id) ?? {}])) as Record<
        string,
        ReturnType<ActionsContext['bind']>
      >,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids.join('\0'), context],
  );
}
