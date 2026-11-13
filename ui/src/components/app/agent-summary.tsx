// The agent card: who it is, what it is doing, how far along, what it costs, what it can use.
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/animate-ui/components/buttons/button';
import type { Agent } from '@/data/types';
import { useFloor } from '@/data/store';
import { AgentAvatar } from './agent-avatar';
import { roleMeta, statusMeta } from './status';
import { StepMeter, TokenMeter } from './token-meter';
import { useAgentActionTargets } from '@/features/team/agent-action-menu';

export function AgentSummary({ agent, onOpenProfile }: { agent: Agent; onOpenProfile?: () => void }) {
  const yolo = useFloor((s) => s.me.yolo.on) || !!agent.yolo;
  const action = useAgentActionTargets([agent.id])[agent.id];
  return (
    <div {...action} tabIndex={0} role="group" aria-label={`${agent.name} agent card. Right-click or Shift+F10 for agent actions.`} className="flex flex-col gap-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className="flex flex-col items-center gap-2 text-center">
        <AgentAvatar agent={agent} size="lg" tooltip={false} />
        <span className="text-lg font-semibold">{agent.name}</span>
        <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs">
          <Badge variant={roleMeta[agent.role].variant}>{roleMeta[agent.role].label}</Badge>
          <span className="text-muted-foreground">
            {[agent.engine, agent.model].filter(Boolean).join(' · ') || 'engine not reported'}
          </span>
        </div>
        <span className={`text-xs ${statusMeta[agent.status].text}`}>{statusMeta[agent.status].label}</span>
      </div>
      <div className="flex flex-col gap-3 rounded-lg border p-3">
        <span className="text-muted-foreground text-xs">Doing now</span>
        <span className="text-sm">{agent.doing || '—'}</span>
        <StepMeter step={agent.step} steps={agent.steps} ticket={agent.ticket} />
      </div>
      <div className="rounded-lg border p-3">
        {agent.tokensReported === false ? <span className="text-muted-foreground text-xs">Token usage — (not reported)</span> : <TokenMeter used={agent.tokensUsed} cap={agent.tokensCap} yolo={yolo} detail={agent.tokensIn || agent.tokensOut || agent.tokensCached || agent.contextPct !== null
          ? `in ${agent.tokensIn}M · out ${agent.tokensOut}M · cached ${agent.tokensCached}M · context ${agent.contextPct === null ? '—' : `${agent.contextPct}%`}` : undefined} />}
        <span className="text-muted-foreground text-xs">Live cost: {agent.costUsd === null || agent.costUsd === undefined ? '—' : `$${agent.costUsd.toFixed(4)}`} · breaker {agent.breaker ?? '—'}</span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">Bundle · {agent.bundle || 'none reported'}</span>
        <div className="flex flex-wrap gap-1.5">
          {agent.skills.map((s) => (
            <Badge key={s} variant="secondary">{s}</Badge>
          ))}
          {agent.mcps.map((s) => (
            <Badge key={s} variant="info">{s}</Badge>
          ))}
        </div>
      </div>
      <Separator />
      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">Rules it follows</span>
        {agent.rules.length === 0 && <span className="text-muted-foreground text-sm">None reported</span>}
        {agent.rules.map((r) => (
          <span key={r} className="border-l-2 pl-2 text-sm">{r}</span>
        ))}
      </div>
      {onOpenProfile && (
        <Button variant="outline" onClick={onOpenProfile}>
          Open profile
        </Button>
      )}
    </div>
  );
}
