import { Progress } from '@/components/animate-ui/components/radix/progress';
import { cn } from '@/lib/utils';
import { budgetTone } from './status';
import { tokens } from './format';

export function TokenMeter({ used, cap, label = 'Tokens today', yolo, detail }: { used: number; cap: number; label?: string; yolo?: boolean; detail?: string }) {
  const pct = yolo ? 0 : Math.min(100, Math.round((used / cap) * 100));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="text-muted-foreground flex-1">{label}</span>
        <span className="font-mono">{yolo ? `${tokens(used)} · no cap (YOLO)` : `${tokens(used)} / ${tokens(cap)}`}</span>
      </div>
      <Progress value={yolo ? 100 : pct} className={cn('h-1.5', yolo ? '[&_[data-slot=progress-indicator]]:bg-fuchsia-400' : budgetTone(used, cap))} />
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
          step {step} of {steps}
        </span>
      </div>
      <Progress value={steps ? Math.round((step / steps) * 100) : 0} className="h-1.5" />
    </div>
  );
}
