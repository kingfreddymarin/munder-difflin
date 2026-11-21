import * as React from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Progress } from '@/components/animate-ui/components/radix/progress';
import { Tabs, TabsList, TabsTrigger } from '@/components/animate-ui/components/radix/tabs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/animate-ui/components/radix/dialog';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/animate-ui/components/radix/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/animate-ui/components/radix/popover';
import { PageHeader } from '@/components/app/panel';
import { AgentAvatar } from '@/components/app/agent-avatar';
import { AgentLink } from '@/components/app/agent-link';
import { UnsupportedReason } from '@/components/app/error-notice';
import { CardDetail, columns as columnMeta, refLabel } from '@/components/app/card-detail';
import { day } from '@/components/app/format';
import { useDispatch, useFloor, useUnsupported } from '@/data/store';
import { useRouter } from '@/app/router';
import { cn } from '@/lib/utils';
import type { Card as CardT, CardStatus } from '@/data/types';
import { childRollup, childrenOf, inFamily } from '@/data/card-tree';
import { Screen } from '@/components/app/screen';

/** Filter keys: `w:` workspace, `t:` tag, `a:` agent, `p:` parent card (it and its children). OR inside a group, AND across groups. */
type FilterKey = `${'w' | 't' | 'a' | 'p'}:${string}`;

function matches(card: CardT, selected: Set<FilterKey>): boolean {
  const groups = { w: [] as string[], t: [] as string[], a: [] as string[], p: [] as string[] };
  selected.forEach((k) => groups[k[0] as 'w' | 't' | 'a' | 'p'].push(k.slice(2)));
  return (!groups.w.length || groups.w.includes(card.workspace ?? ''))
    && (!groups.t.length || card.tags.some((t) => groups.t.includes(t)))
    && (!groups.a.length || groups.a.includes(card.agentId))
    && (!groups.p.length || inFamily(card, groups.p));
}

function BoardFilter({ selected, onChange }: { selected: Set<FilterKey>; onChange: (next: Set<FilterKey>) => void }) {
  const cards = useFloor((s) => s.cards);
  const agents = useFloor((s) => s.agents);
  const workspaces = React.useMemo(() => [...new Set(cards.flatMap((c) => (c.workspace ? [c.workspace] : [])))].sort(), [cards]);
  const tags = React.useMemo(() => [...new Set(cards.flatMap((c) => c.tags))].sort(), [cards]);
  const owners = React.useMemo(() => agents.filter((a) => cards.some((c) => c.agentId === a.id)), [agents, cards]);
  const parents = React.useMemo(() => cards.filter((c) => !c.boardArchivedAt && childrenOf(cards, c.key).length > 0), [cards]);
  const toggle = (key: FilterKey, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    onChange(next);
  };
  const group = (label: string, items: { key: FilterKey; label: string }[]) => items.length > 0 && (
    <>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      {items.map((i) => (
        <DropdownMenuCheckboxItem key={i.key} checked={selected.has(i.key)} onCheckedChange={(on) => toggle(i.key, on === true)} onSelect={(e) => e.preventDefault()}>{i.label}</DropdownMenuCheckboxItem>
      ))}
    </>
  );
  const label = (key: FilterKey) => key.startsWith('a:') ? agents.find((a) => a.id === key.slice(2))?.name ?? key.slice(2)
    : key.startsWith('p:') ? `Under ${key.slice(2)}` : key.slice(2);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">Filter{selected.size ? ` · ${selected.size}` : ''}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[60vh] overflow-y-auto">
          {!workspaces.length && !tags.length && !owners.length && !parents.length && <DropdownMenuLabel className="text-muted-foreground font-normal">No tags on any card yet; agents add them.</DropdownMenuLabel>}
          {group('Workspace', workspaces.map((w) => ({ key: `w:${w}` as FilterKey, label: w })))}
          {workspaces.length > 0 && tags.length > 0 && <DropdownMenuSeparator />}
          {group('Tags', tags.map((t) => ({ key: `t:${t}` as FilterKey, label: t })))}
          {(workspaces.length > 0 || tags.length > 0) && owners.length > 0 && <DropdownMenuSeparator />}
          {group('Agent', owners.map((a) => ({ key: `a:${a.id}` as FilterKey, label: a.name })))}
          {(workspaces.length > 0 || tags.length > 0 || owners.length > 0) && parents.length > 0 && <DropdownMenuSeparator />}
          {group('Parent', parents.map((c) => ({ key: `p:${c.key}` as FilterKey, label: `${c.key} · ${c.title}` })))}
        </DropdownMenuContent>
      </DropdownMenu>
      {[...selected].map((k) => (
        <Badge key={k} variant="secondary" className="gap-1">
          {label(k)}
          <button type="button" aria-label={`Remove filter ${label(k)}`} onClick={() => toggle(k, false)} className="hover:text-foreground text-muted-foreground">×</button>
        </Badge>
      ))}
      {selected.size > 0 && <Button size="sm" variant="ghost" onClick={() => onChange(new Set())}>Clear</Button>}
    </div>
  );
}

/** The human's column order, saved in the core with board.columns. */
function ColumnOrder({ order }: { order: CardStatus[] }) {
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const reason = unsupported({ type: 'board.columns', order });
  const move = (index: number, by: -1 | 1) => {
    const next = order.slice();
    [next[index], next[index + by]] = [next[index + by], next[index]];
    void dispatch({ type: 'board.columns', order: next });
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">Columns</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-64 flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">Column order, left to right</span>
        <UnsupportedReason reason={reason} />
        {order.map((id, i) => {
          const col = columnMeta.find((c) => c.id === id);
          return (
            <div key={id} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
              <span className={cn('size-2 rounded-full', col?.dot)} />
              <span className="flex-1">{col?.label ?? id}</span>
              <Button size="icon-sm" variant="ghost" aria-label={`Move ${col?.label ?? id} left`} disabled={!!reason || i === 0} onClick={() => move(i, -1)}><ArrowLeft className="size-3.5" /></Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Move ${col?.label ?? id} right`} disabled={!!reason || i === order.length - 1} onClick={() => move(i, 1)}><ArrowRight className="size-3.5" /></Button>
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

const DRAG_TYPE = 'application/x-paramount-card';

import { NewCardDialog } from '@/features/team/new-card-dialog';
import { CardActionMenuProvider, useCardActionTarget } from '@/features/team/card-action-menu';
function BoardCard({ card, onOpen }: { card: CardT; onOpen: () => void }) {
  const agent = useFloor((s) => s.agents.find((a) => a.id === card.agentId));
  const cards = useFloor((s) => s.cards);
  const parent = card.parentId ? cards.find((c) => c.key === card.parentId) : undefined;
  const rollup = React.useMemo(() => childRollup(cards, card.key), [cards, card.key]);
  const { onContextMenu, onKeyDown: menuKeyDown } = useCardActionTarget(card.key);
  const done = card.plan.filter((p) => p.state === 'done').length;
  const evidence = card.refs.filter((r) => r.kind === 'workitem' && r.system === 'ado').length;
  return (
    <div role="button" tabIndex={0} draggable aria-haspopup="menu" data-board-card={card.key} onClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => { menuKeyDown?.(e); if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } }}
      onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, card.key); e.dataTransfer.effectAllowed = 'move'; }}
      className="bg-card hover:border-primary/50 focus-visible:ring-ring flex cursor-grab flex-col gap-2 rounded-lg border p-3 text-left transition-colors outline-none focus-visible:ring-2 active:cursor-grabbing">
      <span className="flex items-center gap-2 text-[11px]">
        <span className="text-muted-foreground flex-1 font-mono">{card.key}</span>
        {card.priority && <Badge variant={card.priority === 'P1' ? 'danger' : card.priority === 'P2' ? 'violet' : 'secondary'} className="px-1.5 py-0 text-[10px]">{card.priority}</Badge>}
      </span>
      <span className="text-sm leading-snug font-medium">{card.title}</span>
      {(card.workspace || card.tags.length > 0) && (
        <span className="flex flex-wrap gap-1">
          {card.workspace && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{card.workspace}</Badge>}
          {card.tags.map((t) => <Badge key={t} variant="secondary" className="px-1.5 py-0 text-[10px]">{t}</Badge>)}
        </span>
      )}
      {(card.parentId || rollup) && (
        <span className="text-muted-foreground flex items-center gap-2 text-[11px]">
          {card.parentId && <span className="min-w-0 flex-1 truncate" title={parent ? `${parent.key} · ${parent.title}` : card.parentId}>↳ {card.parentId}{parent ? ` · ${parent.title}` : ''}</span>}
          {rollup && <span className={cn('ml-auto shrink-0', rollup.done === rollup.total && 'text-emerald-400')}>{rollup.done}/{rollup.total} done</span>}
        </span>
      )}
      {card.teamId && <span className="text-[11px] text-muted-foreground">Team {card.teamId}</span>}
      {card.dependsOn && <span className="text-[11px] text-amber-300">waits on {card.dependsOn}</span>}
      {card.plan.length > 0 && <Progress value={Math.round((done / card.plan.length) * 100)} className="h-1" />}
      <span className="text-muted-foreground flex items-center gap-2 text-[11px]">
        {agent && <AgentLink agent={agent} className="text-[11px]" />}
        <span className="flex-1 text-right">{day(card.created)}{card.plan.length ? ` · ${done}/${card.plan.length}` : ''}</span>
        {evidence > 0 && <span title={card.refs.filter((r) => r.kind === 'workitem' && r.system === 'ado').map(refLabel).join(', ')}>ADO {evidence}</span>}
      </span>
    </div>
  );
}

function Column({ id, cards, onOpen }: { id: CardStatus; cards: CardT[]; onOpen: (key: string) => void }) {
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const all = useFloor((s) => s.cards);
  const [over, setOver] = React.useState(false);
  const col = columnMeta.find((c) => c.id === id);
  const reason = unsupported({ type: 'card.move', key: '', status: id });
  return (
    <section
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = reason ? 'none' : 'move';
        setOver(true);
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const key = e.dataTransfer.getData(DRAG_TYPE);
        const card = all.find((c) => c.key === key);
        if (!card || card.status === id || reason) return;
        void dispatch({ type: 'card.move', key, status: id });
      }}
      title={reason ?? undefined}
      className={cn('bg-muted/30 flex min-h-0 flex-col gap-2 rounded-xl border p-2.5 transition-colors', over && (reason ? 'border-destructive/50' : 'border-primary/60 bg-primary/5'))}>
      <h2 className="flex items-center gap-2 px-1 text-sm font-medium">
        <span className={cn('size-2 rounded-full', col?.dot)} />
        <span className="flex-1">{col?.label ?? id}</span>
        <span className="text-muted-foreground text-xs">{cards.length}</span>
      </h2>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
        {cards.map((c) => <BoardCard key={c.key} card={c} onOpen={() => onOpen(c.key)} />)}
        {cards.length === 0 && <span className="text-muted-foreground px-1 py-4 text-center text-xs">Drop a card here</span>}
      </div>
    </section>
  );
}

export function BoardPage() {
  const cards = useFloor((s) => s.cards);
  const agents = useFloor((s) => s.agents);
  const order = useFloor((s) => s.board.columns);
  const { route, go } = useRouter();
  const [view, setView] = React.useState('columns');
  const [selected, setSelected] = React.useState<Set<FilterKey>>(() => new Set());

  const [creating, setCreating] = React.useState(false);  const open = cards.find((c) => c.key === route.params.get('card'));
  const visible = React.useMemo(() => cards.filter((c) => !c.boardArchivedAt && matches(c, selected)), [cards, selected]);
  const openCard = (key: string) => go('board', { card: key });

  return (
    <CardActionMenuProvider>
    <Screen fill>
      <PageHeader title="Board" description="The single list of work. Agents read their card’s plan every turn and tick steps as they go." actions={<Button data-board-focus-fallback onClick={() => setCreating(true)}>New card</Button>} />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={view} onValueChange={setView}>
          <TabsList>
            <TabsTrigger value="columns">Columns</TabsTrigger>
            <TabsTrigger value="agents">By agent</TabsTrigger>
          </TabsList>
        </Tabs>
        <BoardFilter selected={selected} onChange={setSelected} />
        <span className="flex-1" />
        {view === 'columns' && <ColumnOrder order={order} />}
      </div>

      {view === 'columns' ? (
        <div className="min-h-0 flex-1 overflow-x-auto pb-1">
          <div className="grid h-full min-h-[420px] auto-cols-[minmax(240px,1fr)] grid-flow-col gap-3">
            {order.map((id) => <Column key={id} id={id} cards={visible.filter((c) => c.status === id)} onOpen={openCard} />)}
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-min gap-3 overflow-y-auto overscroll-contain lg:grid-cols-2">
          {agents.map((a) => {
            const list = visible.filter((c) => c.agentId === a.id);
            if (!list.length) return null;
            return (
              <section key={a.id} className="flex flex-col gap-3 rounded-xl border p-3 md:flex-row">
                <div className="flex w-44 shrink-0 items-center gap-2">
                  <AgentAvatar agent={a} size="sm" />
                  <span className="flex flex-col"><AgentLink agent={a} avatar={false} className="text-sm font-medium" /><span className="text-muted-foreground text-xs">{list.length} cards</span></span>
                </div>
                <div className="grid flex-1 gap-2 sm:grid-cols-2">{list.map((c) => <BoardCard key={c.key} card={c} onOpen={() => openCard(c.key)} />)}</div>
              </section>
            );
          })}
        </div>
      )}

      <Dialog open={!!open} onOpenChange={(o) => !o && go('board')}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          {open && (
            <>
              <DialogHeader>
                <DialogTitle>{open.title}</DialogTitle>
                <DialogDescription>Everything the owner agent reads before it works on this card.</DialogDescription>
              </DialogHeader>
              <CardDetail card={open} />
            </>
          )}
        </DialogContent>
      </Dialog>
      <NewCardDialog open={creating} onClose={() => setCreating(false)} />
    </Screen>
    </CardActionMenuProvider>  );
}
