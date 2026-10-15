import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Progress } from '@/components/animate-ui/components/radix/progress';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import { Tile } from '@/components/app/tile';
import { SeeAll } from '@/components/app/see-all';
import { AskItem } from '@/components/app/ask-item';
import { AgentAvatar } from '@/components/app/agent-avatar';
import { clock, stamp } from '@/components/app/format';
import { stateDot } from '@/components/app/status';
import { useFloor } from '@/data/store';
import { useRouter } from '@/app/router';
import { cn } from '@/lib/utils';
import type { ActivityKind } from '@/data/types';
import { Screen } from '@/components/app/screen';

const healthBadge = { 'on-track': ['success', 'On track'], 'at-risk': ['warning', 'At risk'], blocked: ['danger', 'Blocked'] } as const;
const kindTone: Record<ActivityKind, string> = { message: 'text-sky-300', tool: 'text-muted-foreground', edit: 'text-violet-300', ticket: 'text-emerald-400', breaker: 'text-rose-400', question: 'text-amber-300' };

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
  const wins = useFloor((s) => s.wins);
  const notifications = useFloor((s) => s.notifications);
  const activity = useFloor((s) => s.activity);
  const services = useFloor((s) => s.services);
  const { go } = useRouter();

  const agent = (id: string) => agents.find((a) => a.id === id);
  const who = (id: string) => agent(id)?.name ?? 'System';
  const waiting = React.useMemo(() => notifications.filter((n) => !n.resolved), [notifications]);
  const closed = React.useMemo(() => cards.filter((c) => c.status === 'done').sort((a, b) => b.updated.localeCompare(a.updated)), [cards]);
  const feed = React.useMemo(() => [...activity].sort((a, b) => b.at.localeCompare(a.at)), [activity]);
  const failing = services.filter((s) => s.state === 'fail').length;
  const degraded = services.filter((s) => s.state === 'warn').length;
  const healthState = failing ? 'fail' : degraded ? 'warn' : 'ok';
  const tokens = agents.reduce((n, a) => n + a.tokensUsed, 0);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <Screen>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <h1 className="text-xl font-semibold tracking-tight">{greeting}</h1>
          <span className="text-muted-foreground text-xs">{agents.filter((a) => a.status === 'working').length} of {agents.length} agents working · {waiting.length} waiting on you</span>
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
          <Button className="h-12" onClick={() => go('chats', { c: 'c-pm' })}>Brief the Paramount</Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-3 lg:grid-rows-2">
        <Tile title="Main objectives" className="lg:row-span-2">
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
        </Tile>

        <Tile title="Ask me" hint={`${waiting.length} waiting`} actions={waiting.length > 2 ? <SeeAll title="Ask me" count={waiting.length}>{waiting.map((n) => <AskItem key={n.id} n={n} who={who(n.from)} />)}</SeeAll> : null}>
          {waiting.length === 0 && <span className="text-muted-foreground text-sm">Nothing waiting on you.</span>}
          {waiting.slice(0, 2).map((n) => <AskItem key={n.id} n={n} who={who(n.from)} compact />)}
        </Tile>

        <Tile title="Agent activity" hint="live" actions={<SeeAll title="Agent activity" count={feed.length}>{feed.map((e) => <div key={e.id} className="flex gap-2 text-sm"><span className="text-muted-foreground w-11 shrink-0 font-mono text-xs">{clock(e.at)}</span><span className="flex-1"><span className={kindTone[e.kind]}>{who(e.agentId)}</span> · {e.text}</span></div>)}</SeeAll>}>
          {feed.slice(0, 6).map((e) => {
            const a = agent(e.agentId);
            return (
              <button key={e.id} type="button" onClick={() => go('team', { agent: e.agentId })} className="hover:bg-accent flex items-center gap-2 rounded-md px-1 py-1 text-left">
                {a && <AgentAvatar agent={a} size="sm" tooltip={false} />}
                <span className="min-w-0 flex-1 truncate text-xs"><span className={kindTone[e.kind]}>{a?.name}</span> · {e.text}</span>
                <span className="text-muted-foreground font-mono text-[11px]">{clock(e.at)}</span>
              </button>
            );
          })}
        </Tile>

        <Tile title="Recently closed" actions={<SeeAll title="Closed cards" count={closed.length}>{closed.map((c) => <button key={c.key} type="button" onClick={() => go('board', { card: c.key })} className="hover:bg-accent flex gap-2 rounded-md p-2 text-left text-sm"><span className="text-muted-foreground font-mono text-xs">{c.key}</span><span className="flex-1">{c.title}</span></button>)}</SeeAll>}>
          {closed.slice(0, 4).map((c) => {
            const a = agent(c.agentId);
            return (
              <button key={c.key} type="button" onClick={() => go('board', { card: c.key })} className="hover:bg-accent flex items-center gap-2 rounded-md px-1 py-1 text-left">
                {a && <AgentAvatar agent={a} size="sm" tooltip={false} />}
                <span className="min-w-0 flex-1 truncate text-xs"><span className="text-muted-foreground font-mono">{c.key}</span> · {c.title}</span>
                <span className="text-muted-foreground text-[11px]">{stamp(c.updated)}</span>
              </button>
            );
          })}
        </Tile>

        <Tile title="What went well" actions={<SeeAll title="What went well" count={wins.length}>{wins.map((w) => <div key={w.id} className="flex flex-col gap-0.5 rounded-md border p-2.5"><span className="text-sm font-medium">{w.title}</span><span className="text-muted-foreground text-xs">{w.detail}</span></div>)}</SeeAll>}>
          {wins.slice(0, 3).map((w) => {
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
        </Tile>
      </div>
    </Screen>
  );
}
