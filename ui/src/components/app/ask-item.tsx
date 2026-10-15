import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/animate-ui/components/buttons/button';
import type { Notification } from '@/data/types';
import { useDispatch } from '@/data/store';
import { clock } from './format';

const kindBadge = { question: 'warning', approval: 'warning', suggestion: 'violet', alert: 'danger' } as const;

export function AskItem({ n, who, compact }: { n: Notification; who: string; compact?: boolean }) {
  const dispatch = useDispatch();
  return (
    <div className="bg-muted/40 flex flex-col gap-1.5 rounded-lg border p-2.5">
      <div className="flex items-center gap-2 text-[11px]">
        <Badge variant={kindBadge[n.kind]} className="px-1.5 py-0 text-[10px]">{n.kind}</Badge>
        <span className="text-muted-foreground flex-1 truncate">{who}</span>
        <span className="text-muted-foreground">{clock(n.at)}</span>
      </div>
      <span className="text-sm leading-snug font-medium">{n.title}</span>
      {!compact && <span className="text-muted-foreground text-xs">{n.body}</span>}
      <div className="flex flex-wrap gap-1.5">
        {n.actions.map((a, i) => (
          <Button key={a} size="sm" className="h-7 px-2.5 text-xs" variant={i === 0 ? 'default' : 'outline'} onClick={() => dispatch({ type: 'notification.act', notificationId: n.id, action: a })}>
            {a}
          </Button>
        ))}
      </div>
    </div>
  );
}
