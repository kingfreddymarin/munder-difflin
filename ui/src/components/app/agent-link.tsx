// An agent's name that asks where to go: their live terminal (the default) or their profile.
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/animate-ui/components/radix/dropdown-menu';
import { useRouter } from '@/app/router';
import { AGENT_VIEW, agentViewParams } from '@/app/agent-view';
import type { Agent } from '@/data/types';
import { cn } from '@/lib/utils';
import { AgentAvatar } from './agent-avatar';

export function AgentLink({ agent, avatar = true, className }: { agent: Agent; avatar?: boolean; className?: string }) {
  const { go } = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()} className={cn('hover:text-primary inline-flex items-center gap-2 rounded-md text-left hover:underline', className)}>
          {avatar && <AgentAvatar agent={agent} size="sm" tooltip={false} />}
          <span>{agent.name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel>Go to {agent.name}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => go(AGENT_VIEW, agentViewParams(agent.id))}>Terminal</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go('team', { agent: agent.id })}>Profile</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
