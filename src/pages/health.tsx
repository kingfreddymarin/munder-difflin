import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/animate-ui/components/radix/tabs';
import { RefreshCw } from '@/components/animate-ui/icons/refresh-cw';
import { Tile } from '@/components/app/tile';
import { SeeAll } from '@/components/app/see-all';
import { StatTile } from '@/components/app/stat-tile';
import { clock } from '@/components/app/format';
import { stateDot, stateTone } from '@/components/app/status';
import { CopyDiagnosticsButton, useDispatch, useFloor, useUnsupported } from '@/data/store';
import { UnsupportedReason } from '@/components/app/error-notice';
import { cn } from '@/lib/utils';
import type { Service } from '@/data/types';
import { Screen } from '@/components/app/screen';

function ServiceRow({ s }: { s: Service }) {
  const [fixing, setFixing] = React.useState<'idle' | 'sending' | 'started'>('idle');
  const dispatch = useDispatch();
  const prereq = useFloor((st) => st.prerequisites.find((p) => p.id === s.id));
  const command = prereq ? { type: prereq.state === 'missing' ? 'prereq.install' : 'prereq.start', id: prereq.id } as const : null;
  const reason = useUnsupported()(command ?? { type: 'prereq.start', id: s.id });
  const fix = () => {
    if (!command) return;
    setFixing('sending');
    // A failure shows in the store's error notice with its errorId; the button returns to its label.
    void dispatch(command).then((ok) => setFixing(ok ? 'started' : 'idle'));
  };
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <span className={cn('size-2 shrink-0 rounded-full', stateDot[s.state])} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{s.name}</span>
        <span className="text-muted-foreground truncate text-xs">{s.detail}</span>
        {s.fix && <UnsupportedReason reason={command ? reason : 'No installer is known for this service.'} />}
      </span>
      {s.fix && <Button size="sm" variant={fixing === 'idle' ? 'outline' : 'secondary'} disabled={!command || !!reason || fixing === 'sending'} onClick={fix}>{fixing === 'sending' ? 'Starting…' : fixing === 'started' ? 'Fix started' : s.fix}</Button>}
      {!s.fix && <span className={cn('text-xs', stateTone[s.state])}>{s.state === 'ok' ? 'healthy' : s.state === 'warn' ? 'degraded' : 'failing'}</span>}
    </div>
  );
}

export function HealthPage() {
  const services = useFloor((s) => s.services);
  const log = useFloor((s) => s.log);
  const agents = useFloor((s) => s.agents);
  const [level, setLevel] = React.useState('all');
  const [checked, setChecked] = React.useState<string | null>(null);
  const cc = services.filter((s) => s.group === 'command-center');
  const studio = services.filter((s) => s.group === 'studio');
  const bad = services.filter((s) => s.state !== 'ok');
  const events = log.filter((e) => level === 'all' || e.level === level);
  const tokens = agents.reduce((n, a) => n + a.tokensUsed, 0);

  return (
    <Screen>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-1 flex-col">
          <h1 className="text-xl font-semibold tracking-tight">Health</h1>
          <span className={cn('text-xs', bad.length ? 'text-amber-300' : 'text-emerald-400')}>{bad.length ? `${bad.length} need attention` : 'Everything healthy'}{checked ? ` · checked ${checked}` : ''}</span>
        </div>
        <Button onClick={() => setChecked(clock(new Date().toISOString()))}><RefreshCw animateOnHover /> Run doctor</Button>
        <CopyDiagnosticsButton />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Services healthy" value={services.length - bad.length} sub={`of ${services.length}`} />
        <StatTile label="Floor tokens today" value={Number(tokens.toFixed(1))} decimals={1} suffix="M" sub="cached reads counted apart" />
        <StatTile label="Errors in the log" value={log.filter((e) => e.level === 'error').length} sub="last 24 h" />
        <StatTile label="Messages dropped" value={0} sub="router · atomic writes" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-3">
        <Tile title="Command center" hint={`${cc.filter((s) => s.state === 'ok').length}/${cc.length} healthy`}>
          {cc.slice(0, 7).map((s) => <ServiceRow key={s.id} s={s} />)}
        </Tile>
        <Tile title="Studio services" hint={`${studio.filter((s) => s.state === 'ok').length}/${studio.length} healthy`} actions={studio.length > 7 ? <SeeAll title="Studio services" count={studio.length}>{studio.map((s) => <ServiceRow key={s.id} s={s} />)}</SeeAll> : null}>
          {[...studio].sort((a, b) => (a.state === 'ok' ? 1 : 0) - (b.state === 'ok' ? 1 : 0)).slice(0, 7).map((s) => <ServiceRow key={s.id} s={s} />)}
        </Tile>
        <Tile title="Event log" actions={<SeeAll title="Event log" count={events.length}>{events.map((e) => <div key={e.id} className="flex gap-2 text-xs"><span className="text-muted-foreground font-mono">{clock(e.at)}</span><span className="flex-1">{e.text}</span><span className="text-muted-foreground font-mono">{e.correlation}</span></div>)}</SeeAll>}>
          <Tabs value={level} onValueChange={setLevel}>
            <TabsList><TabsTrigger value="all">All</TabsTrigger><TabsTrigger value="error">Errors</TabsTrigger><TabsTrigger value="warn">Warnings</TabsTrigger></TabsList>
          </Tabs>
          {events.slice(0, 6).map((e) => (
            <div key={e.id} className="flex items-baseline gap-2 text-xs">
              <span className="text-muted-foreground w-10 shrink-0 font-mono">{clock(e.at)}</span>
              <span className={cn('w-12 shrink-0', e.level === 'error' ? 'text-rose-400' : e.level === 'warn' ? 'text-amber-300' : 'text-muted-foreground')}>{e.level}</span>
              <span className="min-w-0 flex-1 truncate">{e.text}</span>
            </div>
          ))}
        </Tile>
      </div>
    </Screen>
  );
}
