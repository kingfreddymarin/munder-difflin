// "Ask me": everything waiting on you, as a bell in the top-right corner.
import * as React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/animate-ui/components/radix/popover';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Bell } from '@/components/animate-ui/icons/bell';
import { Badge } from '@/components/ui/badge';
import { useDispatch, useFloor } from '@/data/store';
import { useRouter } from './router';
import { clock } from '@/components/app/format';

const kindBadge = { question: 'warning', approval: 'warning', suggestion: 'violet', alert: 'danger' } as const;

export function NotificationsMenu() {
  const notifications = useFloor((s) => s.notifications);
  const agents = useFloor((s) => s.agents);
  const dispatch = useDispatch();
  const { go } = useRouter();
  const open = React.useMemo(() => notifications.filter((n) => !n.resolved), [notifications]);
  const done = React.useMemo(() => notifications.filter((n) => n.resolved).slice(0, 3), [notifications]);
  const who = (id: string) => agents.find((a) => a.id === id)?.name ?? 'System';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Ask me: ${open.length} waiting`} className="relative">
          <Bell animateOnHover animate={open.length > 0 ? undefined : false} className="size-5" />
          {open.length > 0 && (
            <span className="bg-amber-400 text-amber-950 absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full text-[10px] font-semibold">{open.length}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <span className="flex-1 font-semibold">Ask me</span>
          <span className="text-muted-foreground text-xs">{open.length} waiting on you</span>
        </div>
        <div className="flex max-h-[420px] flex-col gap-2 overflow-y-auto p-3">
          <AnimatePresence initial={false}>
            {open.map((n) => (
              <motion.div key={n.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0, marginTop: 0 }} className="bg-muted/50 flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex items-center gap-2 text-xs">
                  <Badge variant={kindBadge[n.kind]}>{n.kind}</Badge>
                  <span className="text-muted-foreground flex-1">{who(n.from)}</span>
                  <span className="text-muted-foreground">{clock(n.at)}</span>
                </div>
                <span className="text-sm font-medium">{n.title}</span>
                <span className="text-muted-foreground text-xs leading-relaxed">{n.body}</span>
                <div className="flex flex-wrap gap-2">
                  {n.actions.map((a, i) => (
                    <Button key={a} size="sm" variant={i === 0 ? 'default' : 'outline'} onClick={() => dispatch({ type: 'notification.act', notificationId: n.id, action: a })}>
                      {a}
                    </Button>
                  ))}
                  {n.chatId && (
                    <Button size="sm" variant="ghost" onClick={() => go('chats', { c: n.chatId! })}>
                      Open chat
                    </Button>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {open.length === 0 && <span className="text-muted-foreground px-1 py-6 text-center text-sm">Nothing waiting on you.</span>}
          {done.length > 0 && (
            <div className="flex flex-col gap-1 border-t pt-2">
              <span className="text-muted-foreground px-1 text-xs">Recently answered</span>
              {done.map((n) => (
                <span key={n.id} className="text-muted-foreground px-1 text-xs">
                  {n.title} · <span className="text-foreground">{n.resolved}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
