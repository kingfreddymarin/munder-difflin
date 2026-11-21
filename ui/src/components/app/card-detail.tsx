import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/animate-ui/components/radix/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Card as CardT, CardRef, CardStatus } from '@/data/types';
import { useDispatch, useFloor, useUnsupported } from '@/data/store';
import { childrenOf, parentCandidates } from '@/data/card-tree';
import { useRouter } from '@/app/router';
import { OpenWith } from './external-link';
import { AgentLink } from './agent-link';
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

const refKind: Record<CardRef['kind'], string> = { pr: 'PR', build: 'Build', run: 'Run', workitem: 'Work item' };
const refSystem: Record<CardRef['system'], string> = { ado: 'Azure DevOps', github: 'GitHub' };
/** "PR 23572", "Build 61204", "ADO 19871": how people say the item. */
export const refLabel = (ref: CardRef) => `${ref.kind === 'workitem' && ref.system === 'ado' ? 'ADO' : refKind[ref.kind]} ${ref.id}`;

/** Opens a link the card carries. The core opens only URLs stored on the card, in the default browser. */
export function CardRefButton({ card, cardRef, className }: { card: CardT; cardRef: CardRef; className?: string }) {
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const command = { type: 'card.link', key: card.key, url: cardRef.url } as const;
  const reason = unsupported(command);
  return (
    <button type="button" disabled={!!reason} title={reason ?? `${refSystem[cardRef.system]} · ${cardRef.url}`}
      onClick={(e) => { e.stopPropagation(); void dispatch(command); }}
      className={cn('text-primary inline-flex items-center gap-1 text-sm hover:underline disabled:cursor-not-allowed disabled:opacity-50', className)}>
      {refLabel(cardRef)} ↗
    </button>
  );
}

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

/** Sets or clears the card's parent with card.update; the core refuses a missing parent and cycles. */
function ParentPicker({ card }: { card: CardT }) {
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const cards = useFloor((s) => s.cards);
  const options = parentCandidates(cards, card);
  const current = card.parentId ?? '';
  const reason = unsupported({ type: 'card.update', key: card.key, patch: { parentId: current } });
  return (
    <select aria-label={`Parent of ${card.key}`} className="border-input bg-background h-8 max-w-full rounded-md border px-2 text-sm"
      value={current} disabled={!!reason} title={reason ?? undefined}
      onChange={(e) => { if (e.target.value !== current) void dispatch({ type: 'card.update', key: card.key, patch: { parentId: e.target.value } }); }}>
      <option value="">No parent</option>
      {current && !options.some((c) => c.key === current) && <option value={current}>{current} (not on the Board)</option>}
      {options.map((c) => <option key={c.key} value={c.key}>{c.key} · {c.title}</option>)}
    </select>
  );
}

export function CardDetail({ card }: { card: CardT }) {
  const agent = useFloor((s) => s.agents.find((a) => a.id === card.agentId));
  const col = columns.find((c) => c.id === card.status);
  const step = card.plan.filter((p) => p.state === 'done').length;
  const evidence = card.refs.filter((r) => r.kind === 'workitem' && r.system === 'ado');
  const links = card.refs.filter((r) => !evidence.includes(r));
  const cards = useFloor((s) => s.cards);
  const children = childrenOf(cards, card.key);
  const { go } = useRouter();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {links.map((r) => <CardRefButton key={r.url} card={card} cardRef={r} className="px-1" />)}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground font-mono">{card.key}</span>
        <Badge variant="outline"><span className={cn('size-2 rounded-full', col?.dot)} />{col?.label}</Badge>
        {card.priority && <Badge variant={card.priority === 'P1' ? 'danger' : card.priority === 'P2' ? 'violet' : 'secondary'}>{card.priority}</Badge>}
        <span className="text-muted-foreground">from {card.origin}</span>
      </div>
      <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Created</dt><dd>{stamp(card.created)}{card.createdBy ? ` · by ${card.createdBy}` : ''}</dd>
        <dt className="text-muted-foreground">Updated</dt><dd>{stamp(card.updated)}</dd>
        <dt className="text-muted-foreground">Task</dt><dd className="font-mono text-xs break-all">{card.task ?? 'hive only (no Studio task)'}</dd>
        <dt className="text-muted-foreground">Owner</dt>
        <dd>{agent ? <AgentLink agent={agent} /> : <span className="text-muted-foreground">{card.agentId || 'unassigned'}</span>}</dd>
        <dt className="text-muted-foreground">Parent</dt><dd><ParentPicker card={card} /></dd>
        {(card.workspace || card.tags.length > 0) && (<><dt className="text-muted-foreground">Tags</dt>
          <dd className="flex flex-wrap gap-1">{card.workspace && <Badge variant="outline">{card.workspace}</Badge>}{card.tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}</dd></>)}
        {card.dir && (<><dt className="text-muted-foreground">Folder</dt><dd className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs break-all">{card.dir}</span><OpenWith path={card.dir} cardKey={card.key} /></dd></>)}
        {card.people.length > 0 && (<><dt className="text-muted-foreground">People</dt><dd>{card.people.join(' · ')}</dd></>)}
      </dl>
      {card.dependsOn && <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">Depends on {card.dependsOn}</div>}
      <section className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">Description</span>
        <p className="text-sm leading-relaxed">{card.description || 'No description yet. The owner writes it when it starts the card.'}</p>
      </section>
      {children.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">Child cards · {children.filter((c) => c.status === 'done').length}/{children.length} done</span>
          <ul className="flex flex-col gap-1">
            {children.map((c) => {
              const childCol = columns.find((x) => x.id === c.status);
              return (
                <li key={c.key}>
                  <button type="button" onClick={() => go('board', { card: c.key })}
                    className="hover:bg-muted/50 flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm">
                    <span className="text-muted-foreground font-mono text-xs">{c.key}</span>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <Badge variant="outline"><span className={cn('size-2 rounded-full', childCol?.dot)} />{childCol?.label ?? c.status}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
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
        <span className="text-muted-foreground text-xs">Evidence · on Azure DevOps</span>
        {evidence.length === 0
          ? <span className="text-xs text-amber-300">No ADO work item linked yet · evidence is attached there before this card can move to Done</span>
          : <div className="flex flex-wrap gap-3">{evidence.map((r) => <CardRefButton key={r.url} card={card} cardRef={r} />)}</div>}
      </section>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground flex-1 text-xs">{card.tokens}M tokens spent on this card</span>
        <MoveCardMenu card={card} />
      </div>
    </div>
  );
}
