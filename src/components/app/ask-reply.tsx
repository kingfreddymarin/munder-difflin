// Munder's ASK ME, inline: an agent's ask with the three ways to respond.
//   decision - pick one of the ask's listed options
//   answer   - write a reply
//   done     - for a to-do only you can do (an assignment): mark it done, with an optional result note
// Plus Dismiss for a card ask (the question stays on the card, it just stops waiting on you).
// Failures surface in the store's ErrorNotice toast with errorId + code; the draft is kept for a retry.
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { useDispatch, useUnsupported } from '@/data/store';
import type { AskMode, Message } from '@/data/types';
import { cn } from '@/lib/utils';

const modeLabel: Record<AskMode, string> = { answer: 'You answered', decision: 'You decided', done: 'You marked it done' };

/** The ask's markdown, kept readable without a markdown renderer: first line bold, line breaks kept. */
export function AskText({ text, clamp }: { text: string; clamp?: boolean }) {
  const [first, ...rest] = text.split('\n');
  const clean = (s: string) => s.replace(/\*\*|__/g, '');
  return (
    <div className={cn('flex flex-col gap-1 text-sm leading-snug', clamp && 'line-clamp-3')}>
      <span className="font-medium">{clean(first ?? '')}</span>
      {rest.join('\n').trim() && <span className="text-muted-foreground whitespace-pre-wrap text-xs">{clean(rest.join('\n').trim())}</span>}
    </div>
  );
}

export function AskReply({ m, compact, onSent }: { m: Message; compact?: boolean; onSent?: () => void }) {
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState<AskMode | 'dismiss' | null>(null);

  if (m.dismissed) return <span className="text-muted-foreground text-xs">Dismissed · still on {m.ticket ?? 'the card'}</span>;
  if (m.answer) {
    return (
      <span className="text-xs text-emerald-400">
        {modeLabel[m.answerMode ?? 'answer']} “{m.answer}”
      </span>
    );
  }

  const blocked = unsupported({ type: 'ask.reply', messageId: m.id, mode: 'answer', text: 'x' });
  const reply = async (mode: AskMode, text: string) => {
    if (!text.trim() || sending) return;
    setSending(mode);
    const ok = await dispatch({ type: 'ask.reply', messageId: m.id, mode, text: text.trim() });
    setSending(null);
    if (ok) { setDraft(''); onSent?.(); }
  };
  const dismiss = async () => {
    setSending('dismiss');
    await dispatch({ type: 'ask.dismiss', messageId: m.id });
    setSending(null);
  };

  return (
    <div className="flex flex-col gap-2" title={blocked ?? undefined}>
      {!!m.options?.length && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Decide">
          {m.options.map((o, i) => (
            <Button key={o} size="sm" variant={i === 0 ? 'default' : 'outline'} className="h-7 px-2.5 text-xs" disabled={!!sending || !!blocked} onClick={() => void reply('decision', o)}>
              {sending === 'decision' ? 'Sending…' : o}
            </Button>
          ))}
        </div>
      )}
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void reply('answer', draft); }}
        placeholder={m.options?.length ? 'Or write your own answer…' : 'Your answer, or the result if you did it…'}
        aria-label="Your reply"
        disabled={!!blocked}
        className={cn('resize-none text-sm', compact ? 'min-h-10' : 'min-h-16')}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" className="h-7 px-2.5 text-xs" disabled={!draft.trim() || !!sending || !!blocked} onClick={() => void reply('answer', draft)}>
          {sending === 'answer' ? 'Sending…' : 'Send answer'}
        </Button>
        <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={!!sending || !!blocked} title="For a to-do only you could do: tell the agent it is done" onClick={() => void reply('done', draft.trim() || 'Done')}>
          {sending === 'done' ? 'Sending…' : 'Mark done'}
        </Button>
        {m.dismissible && (
          <Button size="sm" variant="ghost" className="text-muted-foreground h-7 px-2.5 text-xs" disabled={!!sending} title="Stop waiting on me; the question stays on the card" onClick={() => void dismiss()}>
            {sending === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
          </Button>
        )}
        {m.ticket && <Badge variant="outline" className="ml-auto font-mono text-[10px]">{m.ticket}</Badge>}
      </div>
      {blocked && <span className="text-muted-foreground text-xs">{blocked}</span>}
    </div>
  );
}
