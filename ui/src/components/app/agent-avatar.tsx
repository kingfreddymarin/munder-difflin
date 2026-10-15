import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/animate-ui/components/animate/tooltip';
import { cn } from '@/lib/utils';
import type { Agent } from '@/data/types';
import { accent, statusMeta } from './status';

const sizes = { sm: 'size-7 text-[10px]', md: 'size-10 text-xs', lg: 'size-16 text-lg' };

export function AgentAvatar({ agent, size = 'md', showLevel = true, tooltip = true }: { agent: Agent; size?: keyof typeof sizes; showLevel?: boolean; tooltip?: boolean }) {
  const a = accent[agent.color] ?? accent.slate;
  const body = (
    <span className="relative inline-flex">
      <Avatar className={cn(sizes[size], 'ring-2 ring-offset-2 ring-offset-background', statusMeta[agent.status].ring, agent.yolo && 'ring-fuchsia-400')}>
        <AvatarFallback className={cn('font-mono', a.bg, a.fg)}>{agent.initials}</AvatarFallback>
      </Avatar>
      {showLevel && size !== 'sm' && agent.level > 0 && (
        <span className="absolute -right-2 -bottom-1 rounded-full border border-background bg-secondary px-1.5 text-[10px] leading-4 text-secondary-foreground">L{agent.level}</span>
      )}
    </span>
  );
  if (!tooltip) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent>
        {agent.name} · {statusMeta[agent.status].label}
      </TooltipContent>
    </Tooltip>
  );
}

export function StatusDot({ status, className }: { status: Agent['status']; className?: string }) {
  return <span className={cn('inline-block size-2 rounded-full', statusMeta[status].dot, className)} />;
}
