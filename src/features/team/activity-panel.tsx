import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/animate-ui/components/animate/tooltip';
import { AgentAvatar } from '@/components/app/agent-avatar';
import { statusMeta } from '@/components/app/status';
import { useFloor } from '@/data/store';
import { cn } from '@/lib/utils';

export function ActivityPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const agents = useFloor((s) => s.agents);
  const timelines = useFloor((s) => s.timelines);
  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <div className="text-muted-foreground flex items-center gap-2 pl-[140px] text-[10px]">
        <span className="flex-1">12:00</span><span className="flex-1 text-center">18:00</span><span>now</span>
        <span className="w-28 text-right">msgs · tools · done</span>
      </div>
      {timelines.map((t) => {
        const a = agents.find((x) => x.id === t.agentId);
        if (!a) return null;
        return (
          <button key={t.agentId} type="button" onClick={() => onOpen(a.id)} className="hover:bg-accent flex items-center gap-2 rounded-md px-1 py-1 text-left">
            <span className="flex w-[132px] shrink-0 items-center gap-2"><AgentAvatar agent={a} size="sm" tooltip={false} /><span className="truncate text-xs">{a.name}</span></span>
            <span className="bg-muted flex h-3.5 flex-1 overflow-hidden rounded">
              {t.segments.map((s, i) => (
                <Tooltip key={i}>
                  <TooltipTrigger asChild><span className={cn('h-full', s.state === 'idle' ? 'bg-muted' : statusMeta[s.state].dot)} style={{ width: `${s.pct}%` }} /></TooltipTrigger>
                  <TooltipContent>{statusMeta[s.state].label} · {s.pct}% of the day</TooltipContent>
                </Tooltip>
              ))}
            </span>
            <span className="text-muted-foreground w-28 text-right font-mono text-[11px]">{t.counts.messages} · {t.counts.tools} · {t.counts.done}</span>
          </button>
        );
      })}
    </div>
  );
}
