// The prerequisites this machine needs. Used by the first-run setup dialog and Settings › Setup.
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { CopyButton } from '@/components/animate-ui/components/buttons/copy';
import { cn } from '@/lib/utils';
import type { Prerequisite } from '@/data/types';
import { useDispatch, useFloor } from '@/data/store';

const stateLook = {
  ready: ['Ready', 'success'],
  'installed-not-running': ['Installed · not running', 'warning'],
  missing: ['Missing', 'danger'],
  outdated: ['Outdated', 'warning'],
} as const;
const levelLook = { required: 'danger', recommended: 'info', optional: 'secondary' } as const;

function Row({ p, featured }: { p: Prerequisite; featured?: boolean }) {
  const dispatch = useDispatch();
  const [label, variant] = stateLook[p.state];
  const cmd = p.state === 'installed-not-running' ? p.start : p.install;
  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border p-3', featured && p.state !== 'ready' && 'border-amber-500/50 bg-amber-500/5')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.name}</span>
        <Badge variant={levelLook[p.level]}>{p.level}</Badge>
        <Badge variant={variant}>{label}</Badge>
        <span className="text-muted-foreground ml-auto text-xs">{p.detail}</span>
      </div>
      {(featured || p.state !== 'ready') && <p className="text-muted-foreground text-xs leading-relaxed">{p.why}</p>}
      {p.state !== 'ready' && cmd && (
        <div className="flex items-center gap-2">
          <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 font-mono text-xs">{cmd}</code>
          <CopyButton content={cmd} size="sm" variant="outline" aria-label="Copy command" />
          <Button size="sm" onClick={() => dispatch({ type: p.state === 'installed-not-running' ? 'prereq.start' : 'prereq.install', id: p.id })}>
            {p.state === 'installed-not-running' ? 'Start it' : 'Install'}
          </Button>
        </div>
      )}
    </div>
  );
}

export function PrereqList({ compact }: { compact?: boolean }) {
  const prereqs = useFloor((s) => s.prerequisites);
  const featured = prereqs.find((p) => p.id === 'skid');
  const rest = prereqs.filter((p) => p.id !== 'skid' && (!compact || p.state !== 'ready' || p.level === 'required'));
  return (
    <div className="flex flex-col gap-2">
      {featured && <Row p={featured} featured />}
      <div className={cn('grid gap-2', !compact && 'md:grid-cols-2')}>{rest.map((p) => <Row key={p.id} p={p} />)}</div>
    </div>
  );
}

export function useSetupBlockers() {
  const prereqs = useFloor((s) => s.prerequisites);
  return prereqs.filter((p) => p.level === 'required' && p.state !== 'ready');
}
