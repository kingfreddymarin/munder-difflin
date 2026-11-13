import { Progress } from '@/components/animate-ui/components/radix/progress';
import { AgentAvatar } from '@/components/app/agent-avatar';
import { statusMeta, budgetTone } from '@/components/app/status';
import { useFloor } from '@/data/store';
import { cn } from '@/lib/utils';
import { useAgentActionTargets } from './agent-action-menu';

export function AgentsPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const agents = useFloor((s) => s.agents);
  const yolo = useFloor((s) => s.me.yolo.on);
  const actionTargets = useAgentActionTargets(agents.map((agent) => agent.id));
  return (
    <div className="flex min-h-0 flex-col gap-1">
      {agents.map((a) => (
        <button key={a.id} type="button" title={`${a.doing} · right-click or Shift+F10 for agent actions`} {...actionTargets[a.id]} onClick={() => onOpen(a.id)} className="hover:bg-accent flex items-center gap-2.5 rounded-lg px-1.5 py-1 text-left">
          <AgentAvatar agent={a} size="sm" tooltip={false} />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-center gap-2 text-sm">
              <span className="truncate font-medium">{a.name}</span>
              <span className={cn('ml-auto text-[11px]', statusMeta[a.status].text)}>{statusMeta[a.status].label}</span>
            </span>
            {a.tokensReported === false ? <span className="text-muted-foreground text-[10px]">Tokens — · {a.costUsd == null ? 'cost —' : `$${a.costUsd.toFixed(4)}`} · breaker {a.breaker ?? '—'}</span> : <>
              <Progress value={yolo || a.yolo ? 100 : (a.tokensCap > 0 ? Math.round((a.tokensUsed / a.tokensCap) * 100) : 0)} className={cn('h-1', yolo || a.yolo ? '[&_[data-slot=progress-indicator]]:bg-fuchsia-400' : budgetTone(a.tokensUsed, a.tokensCap))} />
              <span className="text-muted-foreground text-[10px]">{a.tokensUsed.toFixed(2)}M tokens · {a.costUsd == null ? 'cost —' : `$${a.costUsd.toFixed(4)}`} · breaker {a.breaker ?? '—'}</span>
            </>}
          </span>
        </button>
      ))}
    </div>
  );
}
