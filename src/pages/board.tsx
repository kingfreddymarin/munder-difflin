import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Progress } from '@/components/animate-ui/components/radix/progress';
import { Tabs, TabsList, TabsTrigger } from '@/components/animate-ui/components/radix/tabs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/animate-ui/components/radix/dialog';
import { Paperclip } from '@/components/animate-ui/icons/paperclip';
import { PageHeader } from '@/components/app/panel';
import { SeeAll } from '@/components/app/see-all';
import { FilterChips } from '@/components/app/filter-chips';
import { AgentAvatar } from '@/components/app/agent-avatar';
import { CardDetail, columns } from '@/components/app/card-detail';
import { day } from '@/components/app/format';
import { useFloor } from '@/data/store';
import { useRouter } from '@/app/router';
import { cn } from '@/lib/utils';
import type { Card as CardT } from '@/data/types';
import { Screen } from '@/components/app/screen';

function BoardCard({ card, onOpen }: { card: CardT; onOpen: () => void }) {
  const agent = useFloor((s) => s.agents.find((a) => a.id === card.agentId));
  const done = card.plan.filter((p) => p.state === 'done').length;
  return (
    <button type="button" onClick={onOpen} className="bg-card hover:border-primary/50 flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors">
      <span className="flex items-center gap-2 text-[11px]">
        <span className="text-muted-foreground flex-1 font-mono">{card.key}</span>
        <Badge variant={card.priority === 'P1' ? 'danger' : card.priority === 'P2' ? 'violet' : 'secondary'} className="px-1.5 py-0 text-[10px]">{card.priority}</Badge>
      </span>
      <span className="text-sm leading-snug font-medium">{card.title}</span>
      {card.dependsOn && <span className="text-[11px] text-amber-300">waits on {card.dependsOn}</span>}
      {card.plan.length > 0 && <Progress value={Math.round((done / card.plan.length) * 100)} className="h-1" />}
      <span className="text-muted-foreground flex items-center gap-2 text-[11px]">
        {agent && <AgentAvatar agent={agent} size="sm" />}
        <span className="flex-1">{day(card.created)}{card.plan.length ? ` · ${done}/${card.plan.length}` : ''}</span>
        {card.evidence.length > 0 && <span className="flex items-center gap-0.5"><Paperclip className="size-3" />{card.evidence.length}</span>}
        <span>{card.tokens}M</span>
      </span>
    </button>
  );
}

export function BoardPage() {
  const cards = useFloor((s) => s.cards);
  const agents = useFloor((s) => s.agents);
  const { route, go } = useRouter();
  const [view, setView] = React.useState('columns');
  const [agent, setAgent] = React.useState('all');
  const open = cards.find((c) => c.key === route.params.get('card'));
  const visible = React.useMemo(() => cards.filter((c) => agent === 'all' || c.agentId === agent), [cards, agent]);
  const openCard = (key: string) => go('board', { card: key });

  return (
    <Screen fill>
      <PageHeader title="Board" description="The single list of work. Agents read their card’s plan every turn and tick steps as they go." actions={<Button>New card</Button>} />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={view} onValueChange={setView}>
          <TabsList>
            <TabsTrigger value="columns">Columns</TabsTrigger>
            <TabsTrigger value="agents">By agent</TabsTrigger>
          </TabsList>
        </Tabs>
        <FilterChips label="Filter by agent" value={agent} onChange={setAgent} options={[{ value: 'all', label: 'All agents' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} />
      </div>

      {view === 'columns' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="grid h-full min-h-[20rem] grid-cols-3 gap-3 xl:grid-cols-6">
            {columns.map((col) => {
              const list = visible.filter((c) => c.status === col.id);
              return (
                <section key={col.id} className="bg-muted/30 flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain rounded-xl border p-2.5">
                  <h2 className="flex items-center gap-2 px-1 text-sm font-medium">
                    <span className={cn('size-2 rounded-full', col.dot)} />
                    <span className="flex-1">{col.label}</span>
                    <span className="text-muted-foreground text-xs">{list.length}</span>
                  </h2>
                  {list.slice(0, 3).map((c) => <BoardCard key={c.key} card={c} onOpen={() => openCard(c.key)} />)}
                  {list.length > 3 && <SeeAll title={col.label} count={list.length}>{list.map((c) => <BoardCard key={c.key} card={c} onOpen={() => openCard(c.key)} />)}</SeeAll>}
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-min gap-3 overflow-y-auto overscroll-contain lg:grid-cols-2">
          {agents.filter((a) => agent === 'all' || a.id === agent).map((a) => {
            const list = cards.filter((c) => c.agentId === a.id);
            if (!list.length) return null;
            return (
              <section key={a.id} className="flex flex-col gap-3 rounded-xl border p-3 md:flex-row">
                <div className="flex w-44 shrink-0 items-center gap-2">
                  <AgentAvatar agent={a} size="sm" />
                  <span className="flex flex-col"><span className="text-sm font-medium">{a.name}</span><span className="text-muted-foreground text-xs">{list.length} cards</span></span>
                </div>
                <div className="grid flex-1 gap-2 sm:grid-cols-2">{list.slice(0, 2).map((c) => <BoardCard key={c.key} card={c} onOpen={() => openCard(c.key)} />)}{list.length > 2 && <SeeAll title={a.name} count={list.length}>{list.map((c) => <BoardCard key={c.key} card={c} onOpen={() => openCard(c.key)} />)}</SeeAll>}</div>
              </section>
            );
          })}
        </div>
      )}

      <Dialog open={!!open} onOpenChange={(o) => !o && go('board')}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
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
    </Screen>
  );
}
