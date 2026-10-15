import { Progress } from '@/components/animate-ui/components/radix/progress';
import { cn } from '@/lib/utils';
import { budgetTone } from './status';
import { tokens } from './format';

export function TokenMeter({ used, cap, label = 'Tokens today', yolo, detail }: { used: number; cap: number; label?: string; yolo?: boolean; detail?: string }) {
  // A cap of 0 means the core reported none: show the usage alone, never a made-up "0M" limit or NaN%.
  const capped = cap > 0;
  const pct = yolo || !capped ? 0 : Math.min(100, Math.round((used / cap) * 100));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="text-muted-foreground flex-1">{label}</span>
        <span className="font-mono">{yolo ? `${tokens(used)} · no cap (YOLO)` : capped ? `${tokens(used)} / ${tokens(cap)}` : `${tokens(used)} · no cap reported`}</span>
      </div>
      {(yolo || capped) && <Progress value={yolo ? 100 : pct} className={cn('h-1.5', yolo ? '[&_[data-slot=progress-indicator]]:bg-fuchsia-400' : budgetTone(used, cap))} />}
      {detail && <span className="text-muted-foreground text-xs">{detail}</span>}
    </div>
  );
}

export function StepMeter({ step, steps, ticket }: { step: number; steps: number; ticket?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-mono text-muted-foreground flex-1">{ticket ?? '—'}</span>
        <span className="text-muted-foreground">
          {steps > 0 ? `step ${step} of ${steps}` : 'no steps reported'}
        </span>
      </div>
      {steps > 0 && <Progress value={Math.round((step / steps) * 100)} className="h-1.5" />}
    </div>
  );
}
