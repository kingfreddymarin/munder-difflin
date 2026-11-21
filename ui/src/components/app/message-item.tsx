// Renders any message kind. Used by Chats, the phone view and agent sheets.
import { Badge } from '@/components/ui/badge';
import { CheckCheck } from '@/components/animate-ui/icons/check-check';
import { Paperclip } from '@/components/animate-ui/icons/paperclip';
import { X } from '@/components/animate-ui/icons/x';
import { cn } from '@/lib/utils';
import type { Agent, Message } from '@/data/types';
import { AskReply, AskText } from './ask-reply';
import { useDispatch } from '@/data/store';
import { ExternalLink } from './external-link';
import { clock } from './format';
import { useRouter } from '@/app/router';

/** `onHide` is offered on update cards (pipeline, routing, context, suggestions) so Chats can tuck them away. */
export function MessageItem({ m, agents, showNames, onHide }: { m: Message; agents: Agent[]; showNames: boolean; onHide?: () => void }) {
  const { go } = useRouter();
  const you = m.from === 'you';
  const from = agents.find((a) => a.id === m.from);
  const name = you ? 'You' : (from?.name ?? m.from);

  const hide = onHide && (
    <button type="button" aria-label="Hide this update" title="Hide this update" onClick={onHide} className="text-muted-foreground hover:text-foreground ml-auto rounded p-0.5">
      <X className="size-3.5" />
    </button>
  );
  if (m.kind === 'system') return (
    <div role="status" className="text-muted-foreground flex max-w-full flex-wrap items-center gap-2 self-start rounded-md border border-dashed px-2.5 py-1.5 text-xs">
      <span>{m.text}</span>
      {m.terminalAgentId && <button type="button" className="text-primary hover:underline" onClick={() => go('terminal', { a: m.terminalAgentId!, tab: 'updates' })}>Open terminal</button>}
      {hide}
    </div>
  );
  if (m.kind === 'route')
    return <div className="text-muted-foreground flex items-center gap-1 self-center text-xs">→ {m.text}{hide}</div>;
  if (m.kind === 'context')
    return <div className="text-muted-foreground flex items-center gap-1 self-center rounded-md border border-dashed px-2 py-1 text-xs">Added to context · {m.text}{hide}</div>;

  const bubble = cn('max-w-[78%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed', you ? 'bg-primary/15 self-end rounded-tr-sm' : 'bg-muted self-start rounded-tl-sm');
  const header = (
    <div className="flex items-center gap-2 text-xs">
      {(showNames || !you) && m.kind !== 'text' && <span className="font-medium">{name}</span>}
      {showNames && m.kind === 'text' && !you && <span className="font-medium">{name}</span>}
      {m.ticket && <span className="text-muted-foreground font-mono">{m.ticket}</span>}
    </div>
  );
  const foot = (
    <div className="text-muted-foreground mt-1 flex items-center justify-end gap-1 text-[11px]">
      {m.priority && <Badge variant="info" className="px-1.5 py-0 text-[10px]">priority</Badge>}
      {clock(m.at)}
      {you && <CheckCheck className={cn('size-3.5', m.read ? 'text-primary' : '')} />}
    </div>
  );

  if (m.kind === 'text')
    return (
      <div className={bubble}>
        {showNames && !you && header}
        <p>{m.text}</p>
        {foot}
      </div>
    );

  if (m.kind === 'file')
    return (
      <div className={cn(bubble, 'flex items-center gap-3')}>
        <Paperclip className="size-4" />
        <div className="flex flex-col">
          {showNames && header}
          <span>{m.text}</span>
          <span className="text-muted-foreground text-xs">{m.meta}</span>
        </div>
      </div>
    );

  const tone = m.kind === 'question' || m.kind === 'approval' ? 'border-amber-500/40 bg-amber-500/5' : m.kind === 'suggestion' ? 'border-violet-500/40 border-dashed bg-violet-500/5' : 'bg-card';
  const label = { question: 'Question', approval: 'Approval', suggestion: 'Suggestion from the graph', build: 'Pipeline' }[m.kind];
  return (
    <div className={cn('flex max-w-[560px] flex-col gap-2 self-start rounded-xl border p-3.5', tone)}>
      <div className="flex items-center gap-2 text-xs">
        <Badge variant={m.kind === 'suggestion' ? 'violet' : m.kind === 'build' ? 'info' : 'warning'}>{label}</Badge>
        <span className="text-muted-foreground">
          {name} · {clock(m.at)}
        </span>
        {hide}
      </div>
      {m.kind === 'question' || m.kind === 'approval' ? <AskText text={m.text} /> : <p className="text-sm leading-relaxed">{m.text}</p>}
      {m.meta && <p className="text-muted-foreground text-xs">{m.meta}</p>}
      {m.rows && (
        <ul className="flex flex-col gap-1.5">
          {m.rows.map((r) => (
            <li key={r.label} className="flex items-center gap-2 text-sm">
              <span className={cn('size-2 rounded-full', r.ok ? 'bg-emerald-400' : 'bg-rose-400')} />
              <span className="flex-1">{r.label}</span>
              <span className={cn('text-xs', r.ok ? 'text-emerald-400' : 'text-rose-400')}>{r.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {m.links && (
        <div className="flex flex-wrap gap-3 text-sm">
          {m.links.map((l) => (
            <ExternalLink key={l.label} href={l.href}>{l.label}</ExternalLink>
          ))}
        </div>
      )}
      {(m.kind === 'question' || m.kind === 'approval') && <AskReply m={m} />}
    </div>
  );
}
