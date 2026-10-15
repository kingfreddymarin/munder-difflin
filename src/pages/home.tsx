import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Progress } from '@/components/animate-ui/components/radix/progress';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import { Tile } from '@/components/app/tile';
import { SeeAll } from '@/components/app/see-all';
import { AgentAvatar } from '@/components/app/agent-avatar';
import { clock, stamp } from '@/components/app/format';
import { stateDot } from '@/components/app/status';
import { useDispatch, useFloor, useLiveRefresh } from '@/data/store';
import { AskPreview, isOpenAsk } from '@/features/home/ask-preview';
import { CustomizeHome, resolveTiles, type HomeTileId } from '@/features/home/customize-home';
import { useRouter } from '@/app/router';
import { cn } from '@/lib/utils';
import type { ActivityKind, HomeDensity, HomeLayout, TileSize } from '@/data/types';

const healthBadge = { 'on-track': ['success', 'On track'], 'at-risk': ['warning', 'At risk'], blocked: ['danger', 'Blocked'] } as const;
const kindTone: Record<ActivityKind, string> = { message: 'text-sky-300', tool: 'text-muted-foreground', edit: 'text-violet-300', ticket: 'text-emerald-400', breaker: 'text-rose-400', question: 'text-amber-300', lifecycle: 'text-teal-300' };
// Live activity: re-read the core's snapshot (log tail included) this often while Home is visible.
const LIVE_MS = 4000;
const span: Record<TileSize, string> = { sm: 'lg:row-span-1', md: 'lg:row-span-2', lg: 'lg:col-span-2 lg:row-span-2' };
const density: Record<HomeDensity, { gap: string; row: string }> = {
  compact: { gap: 'gap-2', row: 'lg:auto-rows-[minmax(150px,1fr)]' },
  comfortable: { gap: 'gap-3', row: 'lg:auto-rows-[minmax(190px,1fr)]' },
  spacious: { gap: 'gap-5', row: 'lg:auto-rows-[minmax(240px,1fr)]' },
};
const ago = (ms: number, now: number) => { const s = Math.max(0, Math.round((now - ms) / 1000)); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };

function Stat({ label, value, decimals = 0, suffix }: { label: string; value: number; decimals?: number; suffix?: string }) {
  return (
    <div className="flex flex-col rounded-lg border px-3 py-1.5">
      <span className="text-muted-foreground text-[11px]">{label}</span>
      <span className="flex items-baseline gap-0.5 text-lg font-semibold"><SlidingNumber number={value} decimalPlaces={decimals} />{suffix}</span>
    </div>
  );
}

export function HomePage() {
  const objectives = useFloor((s) => s.objectives);
  const cards = useFloor((s) => s.cards);
  const agents = useFloor((s) => s.agents);
  const chats = useFloor((s) => s.chats);
  const wins = useFloor((s) => s.wins);
  const messages = useFloor((s) => s.messages);
  const activity = useFloor((s) => s.activity);
  const services = useFloor((s) => s.services);
  const layout = useFloor((s) => s.homeLayout);
  const dispatch = useDispatch();
  const { go } = useRouter();
  const refreshedAt = useLiveRefresh(LIVE_MS);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);

  const agent = (id: string) => agents.find((a) => a.id === id);
  const who = (id: string) => agent(id)?.name ?? id;
  const openAgent = (id: string) => go('team', { agent: id, tab: 'profile' });
  const asks = React.useMemo(() => messages.filter(isOpenAsk).sort((a, b) => b.at.localeCompare(a.at)), [messages]);
  const askers = [...new Set(asks.map((m) => who(m.from)))];
  const closed = React.useMemo(() => cards.filter((c) => c.status === 'done').sort((a, b) => b.updated.localeCompare(a.updated)), [cards]);
  const feed = React.useMemo(() => [...activity].sort((a, b) => b.at.localeCompare(a.at)), [activity]);
  const failing = services.filter((s) => s.state === 'fail').length;
  const degraded = services.filter((s) => s.state === 'warn').length;
  const healthState = failing ? 'fail' : degraded ? 'warn' : 'ok';
  const tokens = agents.reduce((n, a) => n + a.tokensUsed, 0);
  const hour = new Date(now).getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  // The Paramount's chat: the chat led by the agent with the paramount role, else the first pinned one.
  const paramountChat = chats.find((c) => agent(c.agentIds[0])?.role === 'paramount') ?? chats.find((c) => c.pinned);
  const tiles = resolveTiles(layout).filter((t) => !t.hidden);
  const space = density[layout?.density ?? 'comfortable'];
  const saveLayout = (next: HomeLayout) => void dispatch({ type: 'home.layout', layout: next });

  const tile = (id: HomeTileId, size: TileSize) => {
    const cls = span[size];
    switch (id) {
      case 'objectives':
        return (
          <Tile key={id} title="Main objectives" hint={objectives.length ? undefined : 'none set'} className={cls}>
            <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
              {objectives.length === 0 && <span className="text-muted-foreground text-sm">The core has no objectives for this floor yet.</span>}
              {objectives.map((o) => {
                const own = cards.filter((c) => o.cardKeys.includes(c.key));
                const steps = own.reduce((n, c) => n + c.plan.length, 0);
                const done = own.reduce((n, c) => n + c.plan.filter((p) => p.state === 'done').length, 0);
                const pct = steps ? Math.round((done / steps) * 100) : 0;
                const owner = agent(o.owner);
                const [variant, label] = healthBadge[o.health];
                return (
                  <button key={o.id} type="button" onClick={() => go('board', { card: own[0]?.key ?? '' })} className="hover:bg-accent flex flex-col gap-2 rounded-lg border p-3 text-left">
                    <span className="flex items-start gap-2">
                      {owner && <AgentAvatar agent={owner} size="sm" />}
                      <span className="flex-1 text-sm font-medium leading-snug">{o.title}</span>
                      <Badge variant={variant}>{label}</Badge>
                    </span>
                    <span className="text-muted-foreground line-clamp-2 text-xs">{o.why}</span>
                    <span className="flex items-center gap-2">
                      <Progress value={pct} className="h-1.5 flex-1" />
                      <span className="text-muted-foreground text-[11px]">{pct}% · {own.length} cards</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Tile>
        );
      case 'asks':
        return (
          <Tile key={id} title="Ask me" className={cls}
            hint={asks.length ? <span title={askers.join(', ')}>{askers.slice(0, 3).join(', ')}{askers.length > 3 ? ` +${askers.length - 3}` : ''} · {asks.length} waiting</span> : 'nothing waiting'}
            actions={asks.length > 3 ? (
              <SeeAll title="Ask me" description="Everything an agent is waiting on you for" count={asks.length}>
                <AskPreview asks={asks} agents={agents} onOpenChat={(c) => go('chats', { c })} onOpenAgent={openAgent} />
              </SeeAll>
            ) : null}>
            <AskPreview asks={asks} agents={agents} limit={3} onOpenChat={(c) => go('chats', { c })} onOpenAgent={openAgent} />
          </Tile>
        );
      case 'activity':
        return (
          <Tile key={id} title="Agent activity" className={cls}
            hint={<span className="flex items-center gap-1.5"><span className={cn('size-1.5 rounded-full', refreshedAt ? 'animate-pulse bg-emerald-400' : 'bg-muted-foreground')} />{refreshedAt ? `live · ${ago(refreshedAt, now)}` : 'waiting for the core'}</span>}
            actions={<SeeAll title="Agent activity" count={feed.length}>{feed.map((e) => <div key={e.id} className="flex gap-2 text-sm"><span className="text-muted-foreground w-11 shrink-0 font-mono text-xs">{clock(e.at)}</span><span className="flex-1"><span className={kindTone[e.kind]}>{who(e.agentId)}</span> · {e.text}</span></div>)}</SeeAll>}>
            <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
              {feed.length === 0 && <span className="text-muted-foreground text-sm">No agent activity in the core's log yet.</span>}
              {feed.slice(0, 30).map((e) => {
                const a = agent(e.agentId);
                return (
                  <button key={e.id} type="button" onClick={() => go('team', { agent: e.agentId })} className="hover:bg-accent flex items-center gap-2 rounded-md px-1 py-1 text-left">
                    {a && <AgentAvatar agent={a} size="sm" tooltip={false} />}
                    <span className="min-w-0 flex-1 truncate text-xs"><span className={kindTone[e.kind]}>{a?.name ?? e.agentId}</span> · {e.text}</span>
                    <span className="text-muted-foreground font-mono text-[11px]">{clock(e.at)}</span>
                  </button>
                );
              })}
            </div>
          </Tile>
        );
      case 'closed':
        return (
          <Tile key={id} title="Recently closed" className={cls} actions={<SeeAll title="Closed cards" count={closed.length}>{closed.map((c) => <button key={c.key} type="button" onClick={() => go('board', { card: c.key })} className="hover:bg-accent flex gap-2 rounded-md p-2 text-left text-sm"><span className="text-muted-foreground font-mono text-xs">{c.key}</span><span className="flex-1">{c.title}</span></button>)}</SeeAll>}>
            <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
              {closed.length === 0 && <span className="text-muted-foreground text-sm">No card is done yet.</span>}
              {closed.slice(0, 12).map((c) => {
                const a = agent(c.agentId);
                return (
                  <button key={c.key} type="button" onClick={() => go('board', { card: c.key })} className="hover:bg-accent flex items-center gap-2 rounded-md px-1 py-1 text-left">
                    {a && <AgentAvatar agent={a} size="sm" tooltip={false} />}
                    <span className="min-w-0 flex-1 truncate text-xs"><span className="text-muted-foreground font-mono">{c.key}</span> · {c.title}</span>
                    <span className="text-muted-foreground text-[11px]">{stamp(c.updated)}</span>
                  </button>
                );
              })}
            </div>
          </Tile>
        );
      case 'wins':
        return (
          <Tile key={id} title="What went well" className={cls} actions={<SeeAll title="What went well" count={wins.length}>{wins.map((w) => <div key={w.id} className="flex flex-col gap-0.5 rounded-md border p-2.5"><span className="text-sm font-medium">{w.title}</span><span className="text-muted-foreground text-xs">{w.detail}</span></div>)}</SeeAll>}>
            <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
              {wins.length === 0 && <span className="text-muted-foreground text-sm">Nothing recorded yet.</span>}
              {wins.slice(0, 8).map((w) => {
                const a = agent(w.agentId);
                return (
                  <div key={w.id} className="flex gap-2">
                    {a && <AgentAvatar agent={a} size="sm" tooltip={false} />}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-xs font-medium">{w.title}</span>
                      <span className="text-muted-foreground line-clamp-1 text-[11px]">{w.detail}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </Tile>
        );
    }
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-y-auto', space.gap)}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <h1 className="text-xl font-semibold tracking-tight">{greeting}</h1>
          <span className="text-muted-foreground text-xs">{agents.filter((a) => a.status === 'working').length} of {agents.length} agents working · {asks.length} waiting on you</span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Stat label="Tokens today" value={Number(tokens.toFixed(1))} decimals={1} suffix="M" />
          <Stat label="Done" value={closed.length} />
          <Stat label="Blocked" value={cards.filter((c) => c.status === 'blocked').length} />
          <Button variant="outline" onClick={() => go('health')} className="h-12 gap-2">
            <span className={cn('size-2.5 rounded-full', stateDot[healthState])} />
            <span className="flex flex-col items-start leading-tight">
              <span className="text-xs">Health</span>
              <span className="text-muted-foreground text-[11px]">{failing ? `${failing} failing` : degraded ? `${degraded} degraded` : 'all good'}</span>
            </span>
          </Button>
          <Button variant="outline" className="h-12" onClick={() => go('team', { import: '1' })} title="Import agents from Claude, Codex or Munder Difflin">Import agents</Button>
          <CustomizeHome layout={layout} onChange={saveLayout} />
          {paramountChat && <Button className="h-12" onClick={() => go('chats', { c: paramountChat.id })}>Brief {paramountChat.title}</Button>}
        </div>
      </div>

      {tiles.length === 0 && <span className="text-muted-foreground text-sm">Every tile is hidden. Use Customize to show some.</span>}
      <div className={cn('grid flex-1 grid-cols-1 lg:grid-cols-3 lg:grid-flow-dense', space.gap, space.row)}>
        {tiles.map((t) => tile(t.id, t.size))}
      </div>
    </div>
  );
}
