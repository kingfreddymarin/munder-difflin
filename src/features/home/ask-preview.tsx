// Home's "Ask me": a chats preview of every open ask, grouped by who is asking, with Munder's
// ASK ME reply (decide / answer / mark done / dismiss) right here. "Open chat" jumps to the thread.
import * as React from 'react';
import { AgentAvatar } from '@/components/app/agent-avatar';
import { AskReply, AskText } from '@/components/app/ask-reply';
import { clock } from '@/components/app/format';
import type { Agent, Message } from '@/data/types';

export const isOpenAsk = (m: Message) => (m.kind === 'question' || m.kind === 'approval') && !m.answer && !m.dismissed && !m.read;

export function AskPreview({ asks, agents, limit, onOpenChat, onOpenAgent }: {
  asks: Message[];
  agents: Agent[];
  limit?: number;
  onOpenChat: (chatId: string) => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const shown = limit === undefined ? asks : asks.slice(0, limit);
  if (!asks.length) return <span className="text-muted-foreground text-sm">Nothing waiting on you.</span>;
  return (
    <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto">
      {shown.map((m) => {
        const agent = agents.find((a) => a.id === m.from);
        const open = expanded === m.id;
        return (
          <li key={m.id} className="bg-muted/40 flex flex-col gap-1.5 rounded-lg border p-2.5">
            <div className="flex items-center gap-2 text-[11px]">
              {agent && (
                <button type="button" onClick={() => onOpenAgent(agent.id)} aria-label={`Open ${agent.name}'s settings`} className="rounded-full">
                  <AgentAvatar agent={agent} size="sm" tooltip={false} />
                </button>
              )}
              <span className="flex-1 truncate text-xs font-medium">{agent?.name ?? m.from}</span>
              <span className="text-muted-foreground">{clock(m.at)}</span>
              <button type="button" className="text-primary hover:underline" onClick={() => onOpenChat(m.chatId)}>Open chat</button>
            </div>
            <button type="button" className="text-left" onClick={() => setExpanded(open ? null : m.id)} aria-expanded={open}>
              <AskText text={m.text} clamp={!open} />
            </button>
            {open ? <AskReply m={m} compact onSent={() => setExpanded(null)} /> : (
              <button type="button" className="text-primary self-start text-xs hover:underline" onClick={() => setExpanded(m.id)}>
                {m.options?.length ? `Decide (${m.options.length} options) or reply` : 'Reply'}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
