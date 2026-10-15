// An agent's name that asks where to go: their chat or their profile.
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/animate-ui/components/radix/dropdown-menu';
import { useRouter } from '@/app/router';
import { useFloor } from '@/data/store';
import type { Agent } from '@/data/types';
import { cn } from '@/lib/utils';
import { AgentAvatar } from './agent-avatar';

export function AgentLink({ agent, avatar = true, className }: { agent: Agent; avatar?: boolean; className?: string }) {
  const { go } = useRouter();
  const chat = useFloor((s) => s.chats.find((c) => c.kind === 'agent' && c.agentIds[0] === agent.id));
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
        <DropdownMenuItem disabled={!chat} title={chat ? undefined : 'This agent has no chat yet.'} onSelect={() => chat && go('chats', { c: chat.id })}>Chat</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go('team', { agent: agent.id })}>Profile</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
