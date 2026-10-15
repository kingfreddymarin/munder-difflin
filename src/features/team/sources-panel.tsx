import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/animate-ui/components/animate/tooltip';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/animate-ui/components/radix/hover-card';
import { stateDot } from '@/components/app/status';
import { useDispatch, useFloor } from '@/data/store';
import { cn } from '@/lib/utils';
import type { Access } from '@/data/types';

const next: Record<Access, Access> = { rw: 'r', r: 'none', none: 'rw' };
const look: Record<Access, string> = { rw: 'bg-sky-500/15 text-sky-300', r: 'bg-secondary text-secondary-foreground', none: 'text-muted-foreground/40' };
const word: Record<Access, string> = { rw: 'RW', r: 'R', none: '·' };

export function SourcesPanel() {
  const agents = useFloor((s) => s.agents);
  const sources = useFloor((s) => s.sources);
  const access = useFloor((s) => s.access);
  const engines = useFloor((s) => s.engines);
  const dispatch = useDispatch();
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="grid gap-1" style={{ gridTemplateColumns: `110px repeat(${sources.length}, minmax(0, 1fr))` }}>
        <span />
        {sources.map((s) => (
          <HoverCard key={s.id}>
            <HoverCardTrigger asChild>
              <span className="flex cursor-default flex-col items-center gap-1 text-center text-[10px]">
                <span className={cn('size-1.5 rounded-full', stateDot[s.state])} />
                <span className="truncate">{s.short}</span>
              </span>
            </HoverCardTrigger>
            <HoverCardContent className="w-72">
              <div className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">{s.name} · <span className="text-muted-foreground font-normal">{s.stateLabel}</span></span>
                <span className="text-muted-foreground text-xs">{s.description}</span>
                {s.fields.map((f) => <span key={f.key} className="text-xs"><span className="text-muted-foreground">{f.key}:</span> <span className="font-mono">{f.value}</span></span>)}
                <span className="text-muted-foreground font-mono text-[11px]">hive/connections/{s.file}</span>
              </div>
            </HoverCardContent>
          </HoverCard>
        ))}
        {agents.map((a) => (
          <div key={a.id} className="contents">
            <span className="truncate self-center text-xs">{a.name}</span>
            {sources.map((s) => {
              const v = (access[`${a.id}:${s.id}`] ?? 'none') as Access;
              return (
                <Tooltip key={s.id}>
                  <TooltipTrigger asChild>
                    <button type="button" aria-label={`${a.name} on ${s.name}: ${v}. Tap to change`} onClick={() => dispatch({ type: 'access.set', agentId: a.id, sourceId: s.id, access: next[v] })} className={cn('h-6 rounded font-mono text-[10px]', look[v])}>{word[v]}</button>
                  </TooltipTrigger>
                  <TooltipContent>Tap to change · logged</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 border-t pt-2">
        {engines.map((e) => (
          <HoverCard key={e.id}>
            <HoverCardTrigger asChild>
              <span className="flex cursor-default items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]"><span className={cn('size-1.5 rounded-full', stateDot[e.state])} />{e.name}<span className="text-muted-foreground">{e.models.length} models</span></span>
            </HoverCardTrigger>
            <HoverCardContent className="w-72">
              <div className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">{e.name} · <span className="text-muted-foreground font-normal">{e.stateLabel}</span></span>
                <span className="text-muted-foreground text-xs">{e.plan}</span>
                <span className="flex flex-wrap gap-1">{e.models.map((m) => <span key={m} className={cn('rounded px-1.5 py-0.5 font-mono text-[11px]', m === e.defaultModel ? 'bg-sky-500/15 text-sky-300' : 'bg-secondary')}>{m}</span>)}</span>
                <span className="text-muted-foreground text-xs">{e.note}</span>
              </div>
            </HoverCardContent>
          </HoverCard>
        ))}
      </div>
    </div>
  );
}
