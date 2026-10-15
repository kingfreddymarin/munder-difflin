import { Switch } from '@/components/animate-ui/components/radix/switch';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/animate-ui/components/radix/hover-card';
import { useDispatch, useFloor } from '@/data/store';
import { cn } from '@/lib/utils';

const runTone = { ok: 'bg-emerald-400', fail: 'bg-rose-400', skip: 'bg-muted' } as const;

export function AutomationsPanel() {
  const automations = useFloor((s) => s.automations);
  const dispatch = useDispatch();
  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      {automations.length === 0 && <span className="text-muted-foreground text-sm">No automations reported.</span>}
      {automations.map((a) => (
        <div key={a.id} className="flex items-center gap-3 rounded-lg border px-2.5 py-2">
          <HoverCard>
            <HoverCardTrigger asChild>
              <span className="flex min-w-0 flex-1 cursor-default flex-col">
                <span className="truncate text-sm font-medium">{a.name}</span>
                <span className={cn('truncate text-[11px]', a.runs.at(-1) === 'fail' ? 'text-rose-400' : 'text-muted-foreground')}>{a.last}</span>
              </span>
            </HoverCardTrigger>
            <HoverCardContent className="w-80">
              <dl className="grid grid-cols-[70px_1fr] gap-1 text-xs">
                <dt className="text-muted-foreground">When</dt><dd>{a.when}</dd>
                <dt className="text-muted-foreground">Only if</dt><dd>{a.onlyIf}</dd>
                <dt className="text-muted-foreground">Then</dt><dd>{a.then}</dd>
                <dt className="text-muted-foreground">On failure</dt><dd>{a.onFailure}</dd>
                <dt className="text-muted-foreground">File</dt><dd className="font-mono">hive/automations/{a.file}</dd>
              </dl>
            </HoverCardContent>
          </HoverCard>
          <span className="flex gap-0.5" aria-label={`Last ${a.runs.length} runs`}>{a.runs.map((r, i) => <span key={i} className={cn('h-4 w-1.5 rounded-sm', runTone[r])} />)}</span>
          <Switch checked={a.enabled} onCheckedChange={(v) => dispatch({ type: 'automation.toggle', id: a.id, enabled: v })} aria-label={`${a.enabled ? 'Pause' : 'Resume'} ${a.name}`} />
        </div>
      ))}
    </div>
  );
}
