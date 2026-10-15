import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/animate-ui/components/radix/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Card as CardT, CardStatus } from '@/data/types';
import { useDispatch, useFloor, useUnsupported } from '@/data/store';
import { AgentAvatar } from './agent-avatar';
import { ExternalLink } from './external-link';
import { stamp } from './format';

export const columns: { id: CardStatus; label: string; dot: string }[] = [
  { id: 'backlog', label: 'Backlog', dot: 'bg-zinc-500' },
  { id: 'todo', label: 'To do', dot: 'bg-zinc-300' },
  { id: 'doing', label: 'Doing', dot: 'bg-sky-400' },
  { id: 'blocked', label: 'Blocked', dot: 'bg-amber-400' },
  { id: 'review', label: 'Review', dot: 'bg-violet-400' },
  { id: 'done', label: 'Done', dot: 'bg-emerald-400' },
];

const stepStyle = {
  done: ['✓', 'bg-emerald-400 text-emerald-950 border-emerald-400'],
  doing: ['●', 'border-sky-400 text-sky-300'],
  blocked: ['!', 'bg-amber-400 text-amber-950 border-amber-400'],
  ask: ['?', 'bg-amber-400 text-amber-950 border-amber-400'],
  todo: ['', 'border-muted-foreground/40'],
} as const;

export function MoveCardMenu({ card }: { card: CardT }) {
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">Move</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {columns.filter((c) => c.id !== card.status).map((c) => {
          const reason = unsupported({ type: 'card.move', key: card.key, status: c.id });
          return (
            <DropdownMenuItem key={c.id} disabled={!!reason} title={reason ?? undefined} onSelect={() => dispatch({ type: 'card.move', key: card.key, status: c.id })}>
              <span className={cn('size-2 rounded-full', c.dot)} /> {c.label}{reason && <span className="text-muted-foreground ml-auto text-[11px]">not in core</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CardDetail({ card }: { card: CardT }) {
  const agent = useFloor((s) => s.agents.find((a) => a.id === card.agentId));
  const col = columns.find((c) => c.id === card.status);
  const step = card.plan.filter((p) => p.state === 'done').length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground font-mono">{card.key}</span>
        <Badge variant="outline"><span className={cn('size-2 rounded-full', col?.dot)} />{col?.label}</Badge>
        <Badge variant={card.priority === 'P1' ? 'danger' : card.priority === 'P2' ? 'violet' : 'secondary'}>{card.priority}</Badge>
        <span className="text-muted-foreground">from {card.origin}</span>
      </div>
      <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Created</dt><dd>{stamp(card.created)}{card.createdBy ? ` · by ${card.createdBy}` : ''}</dd>
        <dt className="text-muted-foreground">Updated</dt><dd>{stamp(card.updated)}</dd>
        <dt className="text-muted-foreground">Task</dt><dd className="font-mono text-xs break-all">{card.task ?? 'hive only (no Studio task)'}</dd>
        <dt className="text-muted-foreground">Owner</dt>
        <dd className="flex items-center gap-2">{agent && <AgentAvatar agent={agent} size="sm" />}{agent?.name}</dd>
        {card.people.length > 0 && (<><dt className="text-muted-foreground">People</dt><dd>{card.people.join(' · ')}</dd></>)}
      </dl>
      {card.dependsOn && <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">Depends on {card.dependsOn}</div>}
      <section className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">Description</span>
        <p className="text-sm leading-relaxed">{card.description || 'No description yet. The owner writes it when it starts the card.'}</p>
      </section>
      {card.plan.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Plan the agent follows · step {step} of {card.plan.length}</span>
          <ol className="flex flex-col gap-1">
            {card.plan.map((p, i) => (
              <li key={i} className={cn('flex items-start gap-2.5 rounded-md px-2 py-1.5', p.state === 'doing' && 'bg-sky-500/10')}>
                <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-[9px] font-bold', stepStyle[p.state][1])}>{stepStyle[p.state][0]}</span>
                <span className="flex flex-col">
                  <span className={cn('text-sm', p.state === 'done' && 'text-muted-foreground')}>{p.text}</span>
                  {p.note && <span className="text-muted-foreground text-xs">{p.note}</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {card.doneMeans.length > 0 && (
        <section className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">Done means</span>
          <ul className="list-disc pl-5 text-sm">{card.doneMeans.map((d) => <li key={d}>{d}</li>)}</ul>
        </section>
      )}
      <Separator />
      <section className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">Evidence · {card.evidence.length} files</span>
        {card.evidence.length === 0 && <span className="text-xs text-amber-300">No evidence yet · required before this card can move to Done</span>}
        {card.evidence.map((e) => (
          <div key={e.name} className="flex items-center gap-3 rounded-lg border px-3 py-2">
            <Badge variant="secondary" className="font-mono uppercase">{e.ext}</Badge>
            <span className="flex-1 truncate text-sm">{e.name}</span>
            <span className="text-muted-foreground text-xs">{e.size}</span>
            <span className={cn('text-xs', e.attachedTo ? 'text-emerald-400' : 'text-amber-300')}>{e.attachedTo ? `on ${e.attachedTo}` : 'card only'}</span>
          </div>
        ))}
      </section>
      {card.links.length > 0 && (
        <div className="flex flex-wrap gap-3 text-sm">{card.links.map((l) => <ExternalLink key={l.label} href={l.href}>{l.label}</ExternalLink>)}</div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground flex-1 text-xs">{card.tokens}M tokens spent on this card</span>
        <MoveCardMenu card={card} />
      </div>
    </div>
  );
}
