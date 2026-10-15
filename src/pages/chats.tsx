import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { IconButton } from '@/components/animate-ui/components/buttons/icon';
import { Send } from '@/components/animate-ui/icons/send';
import { FilterChips } from '@/components/app/filter-chips';
import { AgentAvatar } from '@/components/app/agent-avatar';
import { AgentSummary } from '@/components/app/agent-summary';
import { MessageItem } from '@/components/app/message-item';
import { roleMeta, statusMeta } from '@/components/app/status';
import { clock } from '@/components/app/format';
import { useDispatch, useFloor } from '@/data/store';
import { useRouter } from '@/app/router';
import { cn } from '@/lib/utils';
import type { Chat } from '@/data/types';

type Filter = 'all' | 'unread' | 'leads' | 'workers' | 'groups';

export function ChatsPage() {
  const chats = useFloor((s) => s.chats);
  const messages = useFloor((s) => s.messages);
  const agents = useFloor((s) => s.agents);
  const dispatch = useDispatch();
  const { route, go } = useRouter();
  const [filter, setFilter] = React.useState<Filter>('all');
  const [q, setQ] = React.useState('');
  const [draft, setDraft] = React.useState('');
  const current = route.params.get('c') ?? chats[0]?.id;
  const endRef = React.useRef<HTMLDivElement>(null);

  const lead = (c: Chat) => agents.find((a) => a.id === c.agentIds[0]);
  const lastOf = (id: string) => [...messages].reverse().find((m) => m.chatId === id && m.kind !== 'context');
  const unreadOf = (id: string) => messages.filter((m) => m.chatId === id && m.from !== 'you' && !m.read && m.kind !== 'context' && m.kind !== 'route').length;

  const list = React.useMemo(() => {
    return chats
      .filter((c) => {
        const a = lead(c);
        if (q && !c.title.toLowerCase().includes(q.toLowerCase())) return false;
        if (filter === 'unread') return unreadOf(c.id) > 0;
        if (filter === 'groups') return c.kind !== 'agent';
        if (filter === 'leads') return !!a && ['paramount', 'lead', 'co-lead'].includes(a.role);
        if (filter === 'workers') return !!a && ['worker', 'ephemeral', 'watcher'].includes(a.role);
        return true;
      })
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (lastOf(b.id)?.at ?? '').localeCompare(lastOf(a.id)?.at ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, messages, agents, filter, q]);

  const chat = chats.find((c) => c.id === current);
  const thread = React.useMemo(() => messages.filter((m) => m.chatId === current), [messages, current]);
  const focus = chat ? (chat.kind === 'agent' ? lead(chat) : agents.find((a) => a.id === chat.agentIds[0])) : undefined;

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.length, current]);

  const send = () => {
    const text = draft.trim();
    if (!text || !chat) return;
    void dispatch({ type: 'chat.send', chatId: chat.id, text }).then((ok) => { if (ok) setDraft(''); });
  };

  return (
    <div className="bg-card grid h-full min-h-0 grid-cols-1 overflow-hidden rounded-xl border lg:grid-cols-[300px_1fr] 2xl:grid-cols-[300px_1fr_320px]">
      <aside className="flex min-h-0 flex-col gap-3 overflow-hidden border-r p-3">
        <Input placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" />
        <FilterChips label="Filter chats" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }, { value: 'leads', label: 'Leads' }, { value: 'workers', label: 'Workers' }, { value: 'groups', label: 'Groups' }]} />
        <nav className="flex min-h-0 flex-col gap-0.5 overflow-hidden" aria-label="Chats">
          {list.map((c) => {
            const a = lead(c);
            const last = lastOf(c.id);
            const unread = unreadOf(c.id);
            return (
              <button key={c.id} type="button" onClick={() => go('chats', { c: c.id })} className={cn('hover:bg-accent flex items-center gap-3 rounded-lg p-2 text-left', c.id === current && 'bg-accent')}>
                {a && c.kind === 'agent' ? <AgentAvatar agent={a} tooltip={false} /> : <span className="bg-secondary flex size-10 items-center justify-center rounded-full font-mono text-xs">{c.kind === 'group' ? '#' : 'TG'}</span>}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{c.title}</span>
                    {a && c.kind === 'agent' && <Badge variant={roleMeta[a.role].variant} className="px-1.5 py-0 text-[10px]">{roleMeta[a.role].label}</Badge>}
                    <span className="text-muted-foreground ml-auto text-[11px]">{last ? clock(last.at) : ''}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={cn('truncate text-xs', a?.status === 'waiting' ? 'text-amber-300' : 'text-muted-foreground')}>{last?.text ?? ''}</span>
                    {unread > 0 && <span className="bg-primary text-primary-foreground ml-auto rounded-full px-1.5 text-[10px] font-semibold">{unread}</span>}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col">
        {chat && (
          <header className="flex items-center gap-3 border-b px-4 py-3">
            {focus && chat.kind === 'agent' ? <AgentAvatar agent={focus} size="sm" /> : null}
            <div className="flex flex-1 flex-col">
              <span className="font-medium">{chat.title}</span>
              <span className={cn('text-xs', focus ? statusMeta[focus.status].text : 'text-muted-foreground')}>{chat.kind === 'agent' && focus ? focus.doing : `${chat.agentIds.length} agents`}</span>
            </div>
            {chat.kind === 'agent' && focus && (
              <button type="button" className="text-primary text-sm hover:underline" onClick={() => go('terminal', { a: focus.id })}>
                Terminal
              </button>
            )}
          </header>
        )}
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-2.5 overflow-hidden p-4">
          <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto">
          {thread.map((m) => (
            <MessageItem key={m.id} m={m} agents={agents} showNames={chat?.kind !== 'agent'} />
          ))}
          <div ref={endRef} />
          </div>
        </div>
        <div className="flex items-center gap-2 border-t p-3">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder={chat ? `Message ${chat.title} · goes to the front of its queue` : 'Pick a chat'}
            aria-label="Message"
            className="h-11 rounded-full px-4"
          />
          <IconButton aria-label="Send" onClick={send} className="size-11 rounded-full">
            <Send animateOnHover />
          </IconButton>
        </div>
      </section>

      {focus && (
        <aside className="hidden min-h-0 overflow-hidden border-l p-4 2xl:block">
          <AgentSummary agent={focus} onOpenProfile={() => go('team', { agent: focus.id })} />
        </aside>
      )}
    </div>
  );
}
