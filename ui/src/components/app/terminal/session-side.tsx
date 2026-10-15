// Side panel next to an agent's live terminal: what it is asking you (ASK ME), what agents say to each other,
// and what it touched (artifact map) with Open in Warp. Every failure renders through ErrorNotice.
import * as React from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/animate-ui/components/radix/tabs';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { CopyButton } from '@/components/animate-ui/components/buttons/copy';
import { RefreshCw } from '@/components/animate-ui/icons/refresh-cw';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { AgentAvatar } from '@/components/app/agent-avatar';
import { ErrorNotice } from '@/components/app/error-notice';
import { clock, stamp } from '@/components/app/format';
import type { ParamountArtifact, ParamountArtifactMap } from '@/data/paramount-api';
import { toBackendError } from '@/data/errors';
import { useDispatch, useFloor, useTerminalTools } from '@/data/store';
import type { Agent, Message } from '@/data/types';
import { cn } from '@/lib/utils';
import { agentTalk, groupArtifacts, openAsks } from './session-data';

type Tab = 'asks' | 'talk' | 'artifacts';

export function SessionSide({ agent, className }: { agent: Agent; className?: string }) {
  const messages = useFloor((s) => s.messages);
  const agents = useFloor((s) => s.agents);
  const asks = React.useMemo(() => openAsks(messages, agent.id), [messages, agent.id]);
  const [tab, setTab] = React.useState<Tab>(asks.length ? 'asks' : 'talk');
  return (
    <aside aria-label={`${agent.name} context`} className={cn('bg-card flex min-h-0 flex-col gap-2 overflow-hidden rounded-xl border p-2', className)}>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="w-full">
          <TabsTrigger value="asks">Asks{asks.length ? ` · ${asks.length}` : ''}</TabsTrigger>
          <TabsTrigger value="talk">Agents talk</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {tab === 'asks' && <AsksList asks={asks} agent={agent} />}
        {tab === 'talk' && <TalkList messages={messages} agents={agents} agent={agent} />}
        {tab === 'artifacts' && <ArtifactList agent={agent} />}
      </div>
    </aside>
  );
}

function AsksList({ asks, agent }: { asks: Message[]; agent: Agent }) {
  if (!asks.length) return <p role="status" className="text-muted-foreground p-2 text-sm">{agent.name} is not waiting on you.</p>;
  return <ul className="flex flex-col gap-2">{asks.map((m) => <li key={m.id}><AskCard message={m} /></li>)}</ul>;
}

/** One open ask, newest first, answered in place (Munder's ASK ME): an option, or your own words. */
function AskCard({ message }: { message: Message }) {
  const dispatch = useDispatch();
  const [draft, setDraft] = React.useState('');
  const answer = (option: string) => {
    const v = option.trim();
    if (!v) return;
    void dispatch({ type: 'question.answer', messageId: message.id, option: v }).then((ok) => { if (ok) setDraft(''); });
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5">
      <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
        <Badge variant="warning" className="px-1.5 py-0 text-[10px]">{message.kind}</Badge>
        {message.ticket && <span className="font-mono">{message.ticket}</span>}
        <span className="ml-auto">{stamp(message.at)}</span>
      </div>
      <p className="text-sm leading-snug whitespace-pre-wrap break-words">{message.text}</p>
      {!!message.options?.length && <div className="flex flex-wrap gap-1.5">
        {message.options.map((o, i) => <Button key={o} size="sm" className="h-7 px-2.5 text-xs" variant={i === 0 ? 'default' : 'outline'} onClick={() => answer(o)}>{o}</Button>)}
      </div>}
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); answer(draft); }}>
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Answer, or say it is done" className="h-8 text-xs" aria-label="Your answer" />
        <Button type="submit" size="sm" className="h-8" disabled={!draft.trim()}>Send</Button>
      </form>
    </div>
  );
}

function TalkList({ messages, agents, agent }: { messages: Message[]; agents: Agent[]; agent: Agent }) {
  const [scope, setScope] = React.useState<'agent' | 'floor'>('agent');
  const ids = React.useMemo(() => new Set(agents.map((a) => a.id)), [agents]);
  const talk = React.useMemo(() => agentTalk(messages, ids, scope === 'agent' ? agent.id : undefined), [messages, ids, scope, agent.id]);
  const byId = new Map(agents.map((a) => [a.id, a]));
  return (
    <div className="flex flex-col gap-2">
      <Tabs value={scope} onValueChange={(v) => setScope(v as 'agent' | 'floor')}>
        <TabsList><TabsTrigger value="agent">{agent.name}</TabsTrigger><TabsTrigger value="floor">Whole floor</TabsTrigger></TabsList>
      </Tabs>
      {!talk.length && <p role="status" className="text-muted-foreground p-2 text-sm">No agent-to-agent messages{scope === 'agent' ? ` involving ${agent.name}` : ''} yet.</p>}
      <ul className="flex flex-col gap-1.5">
        {talk.map((m) => {
          const from = byId.get(m.from);
          const to = m.to ? byId.get(m.to) : undefined;
          return (
            <li key={m.id} className="bg-muted/40 flex flex-col gap-1 rounded-lg border p-2">
              <div className="flex items-center gap-1.5 text-[11px]">
                {from && <AgentAvatar agent={from} size="sm" tooltip={false} showLevel={false} />}
                <span className="truncate font-medium">{from?.name ?? m.from}</span>
                <span className="text-muted-foreground" aria-label="to">→</span>
                <span className="truncate font-medium">{to?.name ?? m.to}</span>
                {m.act && <Badge variant="info" className="px-1.5 py-0 text-[10px]">{m.act}</Badge>}
                <span className="text-muted-foreground ml-auto shrink-0">{clock(m.at)}</span>
              </div>
              <details className="text-xs">
                <summary className="line-clamp-2 cursor-pointer break-words">{m.text}</summary>
                <p className="mt-1 whitespace-pre-wrap break-words">{m.text}</p>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type Load = { status: 'idle' | 'loading' } | { status: 'ready'; map: ParamountArtifactMap } | { status: 'error'; error: unknown };

function ArtifactList({ agent }: { agent: Agent }) {
  const tools = useTerminalTools();
  const [load, setLoad] = React.useState<Load>({ status: 'idle' });
  const [openError, setOpenError] = React.useState<unknown>(null);
  const fetchMap = React.useCallback(() => {
    if (!tools.artifacts) return;
    setLoad({ status: 'loading' });
    tools.artifacts(agent.id).then((map) => setLoad({ status: 'ready', map }), (error) => setLoad({ status: 'error', error: toBackendError(error, 'terminal.artifacts') }));
  }, [tools, agent.id]);
  React.useEffect(() => { fetchMap(); }, [fetchMap]);
  const open = (dir: string) => {
    if (!tools.openIn) return;
    setOpenError(null);
    tools.openIn('warp', dir).catch((error) => setOpenError(toBackendError(error, 'shell.openIn')));
  };
  const warpReason = !tools.openIn ? 'This build cannot open Warp.' : null;

  if (!tools.artifacts) return <p role="note" className="p-2 text-xs text-amber-300">Unavailable: this build has no artifact mapping.</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]">
          {load.status === 'ready' ? (load.map.repo ? `${load.map.repo.branch || 'detached'} @ ${load.map.repo.head}` : load.map.cwd || 'no working directory') : load.status === 'loading' ? 'Mapping…' : ''}
        </span>
        {load.status === 'ready' && load.map.cwd && <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={!!warpReason} title={warpReason ?? undefined} onClick={() => open(load.map.repo?.root || load.map.cwd)}>Open in Warp</Button>}
        <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Refresh artifacts" onClick={fetchMap} disabled={load.status === 'loading'}><RefreshCw /></Button>
      </div>
      {warpReason && <span role="note" className="text-xs text-amber-300">Unavailable: {warpReason}</span>}
      {!!openError && <ErrorNotice error={openError} />}
      {load.status === 'error' && <ErrorNotice error={load.error} />}
      {load.status === 'ready' && <>
        {load.map.warnings.map((w) => <ErrorNotice key={w.errorId} error={{ errorId: w.errorId, code: 'UNCERTAIN_STATE', message: `${w.source}: ${w.message}`, ok: false }} />)}
        {!load.map.artifacts.length && <p role="status" className="text-muted-foreground p-2 text-sm">Nothing touched yet.</p>}
        {groupArtifacts(load.map.artifacts).map((g) => (
          <section key={g.id} className="flex flex-col gap-1">
            <h3 className="text-muted-foreground px-1 text-[11px] font-medium uppercase tracking-wide">{g.label} · {g.items.length}</h3>
            <ul className="flex flex-col gap-1">{g.items.map((a, i) => <ArtifactRow key={`${a.kind}-${a.path ?? a.url ?? a.label}-${i}`} artifact={a} onOpen={open} warpReason={warpReason} />)}</ul>
          </section>
        ))}
      </>}
    </div>
  );
}

function ArtifactRow({ artifact: a, onOpen, warpReason }: { artifact: ParamountArtifact; onOpen: (dir: string) => void; warpReason: string | null }) {
  const reason = warpReason ?? (a.dir ? null : 'Not on disk any more.');
  return (
    <li className="bg-muted/40 flex items-center gap-2 rounded-md border px-2 py-1">
      {a.status && <Badge variant="warning" className="px-1 py-0 font-mono text-[10px]">{a.status}</Badge>}
      {a.kind === 'commit' && a.commit && <Badge variant="violet" className="px-1 py-0 font-mono text-[10px]">{a.commit}</Badge>}
      {a.url
        ? <a href={a.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-xs text-sky-300 underline-offset-2 hover:underline" title={a.url}>{a.label}</a>
        : <span className={cn('min-w-0 flex-1 truncate text-xs', a.kind !== 'commit' && 'font-mono')} title={a.path ?? a.label}>{a.label}</span>}
      {a.at && <span className="text-muted-foreground shrink-0 text-[10px]">{clock(a.at)}</span>}
      {(a.path || a.url) && <CopyButton content={a.path ?? a.url ?? ''} variant="ghost" size="sm" aria-label={`Copy ${a.label}`} />}
      {a.kind !== 'link' && <Button size="sm" variant="ghost" className="h-6 shrink-0 px-1.5 text-[11px]" disabled={!!reason} title={reason ?? (a.dir ? `Open ${a.dir} in Warp` : undefined)} onClick={() => a.dir && onOpen(a.dir)}>Warp</Button>}
    </li>
  );
}
