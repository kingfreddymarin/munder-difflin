// One place for how states, roles and colours look. Screens never pick colours themselves.
import type { AgentStatus, Role } from '@/data/types';

export const statusMeta: Record<AgentStatus, { label: string; dot: string; ring: string; text: string }> = {
  working: { label: 'Working', dot: 'bg-sky-400', ring: 'ring-sky-400', text: 'text-sky-300' },
  waiting: { label: 'Asked you', dot: 'bg-amber-400', ring: 'ring-amber-400', text: 'text-amber-300' },
  constrained: { label: 'Constrained', dot: 'bg-rose-400', ring: 'ring-rose-400', text: 'text-rose-300' },
  idle: { label: 'Idle', dot: 'bg-zinc-500', ring: 'ring-zinc-500', text: 'text-muted-foreground' },
  crashed: { label: 'Crashed', dot: 'bg-rose-500', ring: 'ring-rose-500', text: 'text-rose-400' },
};

export const roleMeta: Record<Role, { label: string; variant: 'info' | 'violet' | 'success' | 'secondary' | 'warning' | 'danger' }> = {
  paramount: { label: 'Paramount', variant: 'info' },
  lead: { label: 'Lead', variant: 'violet' },
  'co-lead': { label: 'Co-lead', variant: 'success' },
  worker: { label: 'Worker', variant: 'secondary' },
  ephemeral: { label: 'Ephemeral', variant: 'warning' },
  watcher: { label: 'Watcher', variant: 'success' },
};

export const accent: Record<string, { bg: string; fg: string }> = {
  sky: { bg: 'bg-sky-500/15', fg: 'text-sky-300' },
  violet: { bg: 'bg-violet-500/15', fg: 'text-violet-300' },
  teal: { bg: 'bg-teal-500/15', fg: 'text-teal-300' },
  slate: { bg: 'bg-zinc-500/20', fg: 'text-zinc-300' },
  pink: { bg: 'bg-pink-500/15', fg: 'text-pink-300' },
  emerald: { bg: 'bg-emerald-500/15', fg: 'text-emerald-300' },
  amber: { bg: 'bg-amber-500/15', fg: 'text-amber-300' },
};

export const stateTone = { ok: 'text-emerald-400', warn: 'text-amber-400', fail: 'text-rose-400' } as const;
export const stateDot = { ok: 'bg-emerald-400', warn: 'bg-amber-400', fail: 'bg-rose-400' } as const;

export function budgetTone(used: number, cap: number) {
  const p = cap > 0 ? used / cap : 0;
  return p >= 0.9 ? '[&_[data-slot=progress-indicator]]:bg-rose-400' : p >= 0.7 ? '[&_[data-slot=progress-indicator]]:bg-amber-400' : '';
}
