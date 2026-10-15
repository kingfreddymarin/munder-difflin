// Live view of each agent's real terminal. The core streams the PTY; here you read it, act on what it asks, or type into it.
import * as React from 'react';
import { Code, CodeBlock, CodeHeader } from '@/components/animate-ui/components/animate/code';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { IconButton } from '@/components/animate-ui/components/buttons/icon';
import { Terminal } from '@/components/animate-ui/icons/terminal';
import { Send } from '@/components/animate-ui/icons/send';
import { Input } from '@/components/ui/input';
import { AgentAvatar } from '@/components/app/agent-avatar';
import { statusMeta } from '@/components/app/status';
import { useDispatch, useFloor } from '@/data/store';
import { useRouter } from '@/app/router';
import { cn } from '@/lib/utils';
import { Screen } from '@/components/app/screen';
import { PtyTerminalView } from '@/components/app/terminal/pty-terminal-view';
import { SessionSide } from '@/components/app/terminal/session-side';

export function TerminalPage() {
  const terminals = useFloor((s) => s.terminals);
  const agents = useFloor((s) => s.agents);
  const dispatch = useDispatch();
  const { route, go } = useRouter();
  const [draft, setDraft] = React.useState('');
  const current = route.params.get('a') ?? terminals[0]?.agentId;
  const session = terminals.find((t) => t.agentId === current);
  const agent = agents.find((a) => a.id === current);
  const text = session ? session.lines.slice(-40).map((l) => (l.stream === 'err' ? `# ${l.text}` : l.text)).join('\n') : '';

  const send = (value?: string) => {
    const v = (value ?? draft).trim();
    if (!v || !session) return;
    void dispatch({ type: 'terminal.input', agentId: session.agentId, text: v }).then((ok) => { if (ok) setDraft(''); });
  };

  return (
    <Screen fill className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-[240px_1fr] lg:overflow-hidden xl:grid-cols-[240px_1fr_340px]">
      <nav aria-label="Sessions" className="bg-card flex max-h-64 min-h-0 flex-col gap-1 overflow-y-auto rounded-xl border p-2 lg:max-h-none">
        <span className="text-muted-foreground px-2 py-1 text-xs">Live sessions</span>
        {terminals.map((t) => {
          const a = agents.find((x) => x.id === t.agentId);
          if (!a) return null;
          return (
            <button key={t.agentId} type="button" onClick={() => go('terminal', { a: a.id })} className={cn('hover:bg-accent flex items-center gap-2.5 rounded-lg p-2 text-left', a.id === current && 'bg-accent')}>
              <AgentAvatar agent={a} size="sm" tooltip={false} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{a.name}</span>
                <span className={cn('truncate text-[11px]', statusMeta[a.status].text)}>{t.pending ? 'waiting for input' : statusMeta[a.status].label}</span>
              </span>
            </button>
          );
        })}
      </nav>
      {!session && <section className="flex items-center justify-center rounded-xl border p-6 text-sm text-muted-foreground" role="status">No live terminal is available. Start an agent to see its session here.</section>}
      {session && agent && (
        <section className="flex min-h-[420px] flex-col gap-3 lg:min-h-0">
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
      {session && agent && <SessionSide key={agent.id} agent={agent} className="min-h-[360px] lg:col-start-2 xl:col-start-3 xl:row-start-1 xl:min-h-0" />}
    </Screen>
  );
}
