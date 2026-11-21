// Talking to an agent: its live PTY terminal, as in Munder. Keystrokes go straight into xterm;
// switching agents re-parents each pooled terminal, so scrollback survives. The orchestrator is first.
import * as React from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Code, CodeBlock, CodeHeader } from '@/components/animate-ui/components/animate/code';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { IconButton } from '@/components/animate-ui/components/buttons/icon';
import { Terminal } from '@/components/animate-ui/icons/terminal';
import { Send } from '@/components/animate-ui/icons/send';
import { Input } from '@/components/ui/input';
import { AgentAvatar } from '@/components/app/agent-avatar';
import { statusMeta } from '@/components/app/status';
import { useDispatch, useFloor } from '@/data/store';
import { cn } from '@/lib/utils';
import { useRouter } from '@/app/router';
import { selectedAgentId } from '@/app/agent-view';
import { OpenWith } from '@/components/app/external-link';
import { Screen } from '@/components/app/screen';
import { PtyTerminalView } from '@/components/app/terminal/pty-terminal-view';
import { SessionSide } from '@/components/app/terminal/session-side';

const SIDEBAR_KEY = 'paramount.terminal.sidebar.open';

function loadSidebarOpen() {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function TerminalPage() {
  const terminals = useFloor((s) => s.terminals);
  const agents = useFloor((s) => s.agents);
  const dispatch = useDispatch();
  const { route } = useRouter();
  const [draft, setDraft] = React.useState('');
  const [sidebarOpen, setSidebarOpen] = React.useState(loadSidebarOpen);
  const sidebarId = React.useId();
  const sidebar = React.useRef<HTMLDivElement>(null);
  const toggleButton = React.useRef<HTMLButtonElement>(null);
  const current = selectedAgentId(route.params.get('a'), agents, terminals);
  const session = terminals.find((t) => t.agentId === current);
  const agent = agents.find((a) => a.id === current);
  const text = session ? session.lines.slice(-40).map((l) => (l.stream === 'err' ? `# ${l.text}` : l.text)).join('\n') : '';

  const toggleSidebar = React.useCallback(() => {
    if (sidebar.current?.contains(document.activeElement)) toggleButton.current?.focus();
    setSidebarOpen((open) => !open);
  }, []);

  React.useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_KEY, String(sidebarOpen)); } catch { /* storage is optional */ }
  }, [sidebarOpen]);

  React.useEffect(() => {
    if (route.params.get('tab') === 'updates') setSidebarOpen(true);
  }, [route.params]);

  const hasAgent = !!agent;
  React.useEffect(() => {
    if (!hasAgent) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'Period' || !(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleSidebar();
    };
    // Capture before xterm translates keystrokes into PTY input.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [hasAgent, toggleSidebar]);

  const send = (value?: string) => {
    const v = (value ?? draft).trim();
    if (!v || !session) return;
    void dispatch({ type: 'terminal.input', agentId: session.agentId, text: v }).then((ok) => { if (ok) setDraft(''); });
  };

  return (
    <Screen fill className="min-h-0 overflow-y-auto lg:overflow-hidden">
      {agent && (
        <div className="flex shrink-0 items-center gap-2">
          <AgentAvatar agent={agent} size="sm" tooltip={false} />
          <span className="truncate font-medium">{agent.name}</span>
          <span className={cn('truncate text-xs', statusMeta[agent.status].text)}>{statusMeta[agent.status].label}</span>
          <span className="ml-auto" />
          {session?.cwd && <OpenWith path={session.cwd} />}
          <Button
            ref={toggleButton}
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0 text-black hover:bg-[#FFC24B] hover:text-black focus-visible:border-[#FFC24B] focus-visible:ring-[#FFC24B] dark:text-white dark:hover:bg-[#FFC24B] dark:hover:text-black"
            aria-label={sidebarOpen ? 'Collapse terminal sidebar' : 'Expand terminal sidebar'}
            aria-expanded={sidebarOpen}
            aria-controls={sidebarId}
            aria-keyshortcuts="Meta+Shift+. Control+Shift+."
            title={`${sidebarOpen ? 'Collapse' : 'Expand'} terminal sidebar (⌘/Ctrl+Shift+.)`}
            onClick={toggleSidebar}
          >
            {sidebarOpen ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
          </Button>
        </div>
      )}
      <div className={cn('grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-3 lg:grid-rows-[minmax(0,1fr)]', agent && sidebarOpen && 'lg:grid-cols-[minmax(0,1fr)_22rem]')}>
        {(!session || !agent) && <section className="flex flex-col items-center justify-center gap-3 rounded-xl border p-6 text-sm text-muted-foreground" role="status">
          {agent ? <span>{agent.name} has no live terminal. Start it from its profile or from Team.</span>
            : <span>No live terminal is available. Start an agent to see its session here.</span>}
        </section>}
        {session && agent && (
          <section className="flex min-h-[420px] min-w-0 flex-col gap-3 lg:min-h-0">
            {session.ptyId ? <div className="min-h-[320px] flex-1 overflow-hidden rounded-xl border"><PtyTerminalView ptyId={session.ptyId} cwd={session.cwd} label={`${agent.name} live terminal`} /></div> : <Code code={text} className="min-h-0 flex-1 overflow-hidden rounded-xl border">
              <CodeHeader icon={Terminal} copyButton>
                {agent.name} · {session.cwd}
              </CodeHeader>
              <CodeBlock lang="bash" writing={false} className="min-h-0 flex-1" />
            </Code>}
            {session.pending && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
                <span className="flex-1 text-sm">{session.pending.prompt}</span>
                {session.pending.options.map((o, i) => (
                  <Button key={o} size="sm" variant={i === 0 ? 'default' : 'outline'} onClick={() => send(o)}>{o}</Button>
                ))}
              </div>
            )}
            {!session.ptyId && <div className="flex items-center gap-2">
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder={`Type into ${agent.name}'s session · priority, logged`} className="h-11 font-mono" aria-label="Terminal input" />
              <IconButton aria-label="Send to terminal" onClick={() => send()} className="size-11"><Send animateOnHover /></IconButton>
            </div>}
          </section>
        )}
        {agent && <div id={sidebarId} ref={sidebar} hidden={!sidebarOpen} className="min-h-0 min-w-0">
          <SessionSide key={agent.id} agent={agent} defaultProfile={!session} className="h-[min(65vh,36rem)] min-h-64 lg:h-full lg:min-h-0" />
        </div>}
      </div>
    </Screen>
  );
}
