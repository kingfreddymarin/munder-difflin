// Team graph built from data: reporting lines from agent.reportsTo, live edges from who is working,
// amber edges for agents waiting on you, dashed edges from automations to the agent they wake,
// and open task cards under their owner (see graph-model.ts).
import * as React from 'react';
import { useFloor } from '@/data/store';
import { statusMeta } from '@/components/app/status';
import { useRouter } from '@/app/router';
import type { CardStatus } from '@/data/types';
import { useAgentActionTargets } from './agent-action-menu';
import { agentLayout, buildTaskGraph, CARD_H, CARD_W, GRAPH_WIDTH, UNASSIGNED } from './graph-model';

const ringHex = { working: '#38bdf8', waiting: '#fbbf24', constrained: '#fb7185', idle: '#71717a', crashed: '#f43f5e' } as const;
const cardHex: Record<CardStatus, string> = { blocked: '#f43f5e', doing: '#38bdf8', review: '#a78bfa', todo: '#71717a', backlog: '#52525b', done: '#22c55e' };
const cardLabel: Record<CardStatus, string> = { blocked: 'Blocked', doing: 'Doing', review: 'In review', todo: 'To do', backlog: 'Backlog', done: 'Done' };
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

export function GraphPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const agents = useFloor((s) => s.agents);
  const automations = useFloor((s) => s.automations);
  const cards = useFloor((s) => s.cards);
  const actionTargets = useAgentActionTargets(agents.map((agent) => agent.id));
  const { go } = useRouter();
  const layout = React.useMemo(() => agentLayout(agents), [agents]);
  // The agent that reports to you: Paramount's own lead, else the first agent with no manager.
  const rootId = (agents.find((a) => a.role === 'paramount') ?? agents.find((a) => !a.reportsTo))?.id;
  const root = rootId ? layout[rootId] : undefined;
  const triggers = automations.filter((a) => a.enabled).slice(0, 4);
  const tasks = React.useMemo(() => buildTaskGraph(cards, layout), [cards, layout]);
  const taskPos = Object.fromEntries(tasks.nodes.map((n) => [n.key, n]));
  const openCard = (key: string) => go('board', { card: key });
  const activate = (e: React.KeyboardEvent, key: string) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(key); } };
  return (
    // Full-width drawing that scrolls inside the tile, so the task band is never clipped or covered.
    <div data-graph-scroll className="min-h-0 flex-1 overflow-auto">
    <svg viewBox={`0 0 ${GRAPH_WIDTH} ${tasks.height}`} role="img" aria-label="Team graph" className="block h-auto w-full min-w-[36rem]">
      <g fill="none" strokeWidth="2">
        {root && <line x1="480" y1="26" x2={root.x} y2={root.y - 18} stroke="#38bdf8" strokeWidth="3" />}
        {agents.filter((a) => a.reportsTo && layout[a.reportsTo]).map((a) => {
          const p = layout[a.id], q = layout[a.reportsTo!];
          return <line key={a.id} x1={q.x} y1={q.y + 21} x2={p.x} y2={p.y - 21} stroke={a.status === 'working' ? '#38bdf8' : '#3f3f46'} strokeWidth={a.status === 'working' ? 3 : 2} />;
        })}
        {agents.filter((a) => a.status === 'waiting').map((a) => <path key={`w-${a.id}`} d={`M${layout[a.id].x - 18} ${layout[a.id].y} C ${layout[a.id].x - 120} ${layout[a.id].y - 80}, 400 26, 462 26`} stroke="#fbbf24" strokeDasharray="6 5" />)}
        {triggers.map((t, i) => <line key={t.id} x1="158" y1={61 + i * 50} x2={(root?.x ?? 480) - 24} y2={root?.y ?? 70} stroke="#52525b" strokeDasharray="4 5" />)}
        {tasks.edges.map((e) => {
          const to = taskPos[e.to];
          if (e.kind === 'owner') {
            const a = layout[e.from];
            return <line key={`o-${e.to}`} data-edge="owner" x1={a.x} y1={a.y + 60} x2={to.x} y2={to.y - 15} stroke={cardHex[to.status]} strokeOpacity="0.5" />;
          }
          const from = taskPos[e.from];
          return <path key={`${e.kind}-${e.from}-${e.to}`} data-edge={e.kind} d={`M${from.x + 60} ${from.y} C ${from.x + 110} ${from.y}, ${to.x + 110} ${to.y}, ${to.x + 60} ${to.y}`} stroke="#a1a1aa" strokeDasharray={e.kind === 'depends' ? '6 4' : '2 4'} />;
        })}
      </g>
      {triggers.map((t, i) => (
        <g key={t.id}>
          <rect x="8" y={47 + i * 50} width="150" height="28" rx="14" fill="currentColor" className="text-muted" />
          <text x="83" y={65 + i * 50} textAnchor="middle" fontSize="11" fill="currentColor" className="text-muted-foreground">{t.name.length > 20 ? `${t.name.slice(0, 19)}…` : t.name}</text>
        </g>
      ))}
      <circle cx="480" cy="26" r="17" fill="currentColor" className="text-foreground" />
      <text x="480" y="30" textAnchor="middle" fontSize="11" fontWeight="600" fill="currentColor" className="text-background">You</text>
      {agents.map((a) => (
        <g key={a.id} role="button" tabIndex={0} aria-label={`${a.name}, ${statusMeta[a.status].label}. Right-click or Shift+F10 for agent actions.`} {...actionTargets[a.id]} onClick={() => onOpen(a.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(a.id); else actionTargets[a.id]?.onKeyDown?.(e); }} className="cursor-pointer">
          <circle cx={layout[a.id].x} cy={layout[a.id].y} r="21" fill="currentColor" className="text-secondary" stroke={ringHex[a.status]} strokeWidth="3" />
          <text x={layout[a.id].x} y={layout[a.id].y + 4} textAnchor="middle" fontSize="11" fontFamily="var(--font-mono)" fill="currentColor" className="text-foreground">{a.initials}</text>
          <text x={layout[a.id].x} y={layout[a.id].y + 38} textAnchor="middle" fontSize="12" fill="currentColor" className="text-muted-foreground">{a.name}</text>
          <text x={layout[a.id].x} y={layout[a.id].y + 53} textAnchor="middle" fontSize="9" fill="currentColor" className="text-muted-foreground">{a.teamNames?.join(', ') || ''} · {cards.filter((card) => card.agentId === a.id && card.status !== 'done').length} open / {cards.filter((card) => card.agentId === a.id && card.status === 'blocked').length} blocked</text>
        </g>
      ))}
      {tasks.nodes.map((n) => (
        <g key={n.key} data-task-node={n.key} role="button" tabIndex={0} aria-label={`Card ${n.key}: ${n.title}. ${cardLabel[n.status]}${n.priority ? `, ${n.priority}` : ''}. Owner ${agents.find((a) => a.id === n.agentId)?.name ?? 'unassigned'}.`} onClick={() => openCard(n.key)} onKeyDown={(e) => activate(e, n.key)} className="cursor-pointer">
          <rect x={n.x - CARD_W / 2} y={n.y - CARD_H / 2} width={CARD_W} height={CARD_H} rx="6" fill="currentColor" className="text-card" stroke={cardHex[n.status]} strokeWidth="2" />
          <text x={n.x} y={n.y - 2} textAnchor="middle" fontSize="9" fontFamily="var(--font-mono)" fill="currentColor" className="text-muted-foreground">{n.key} · {cardLabel[n.status]}{n.priority ? ` · ${n.priority}` : ''}</text>
          <text x={n.x} y={n.y + 10} textAnchor="middle" fontSize="10" fill="currentColor" className="text-foreground">{clip(n.title, 22)}</text>
        </g>
      ))}
      {tasks.columns.map((c) => (
        <g key={`col-${c.owner}`}>
          <text x={c.x} y={c.top - 24} textAnchor="middle" fontSize="10" fill="currentColor" className="text-muted-foreground">{c.owner === UNASSIGNED ? 'Unassigned' : clip(agents.find((a) => a.id === c.owner)?.name ?? c.owner, 18)}</text>
          {c.hidden > 0 && <text x={c.x} y={c.top + c.shown * 44} textAnchor="middle" fontSize="10" fill="currentColor" className="text-muted-foreground">+{c.hidden} more</text>}
        </g>
      ))}
    </svg>
    </div>
  );
}
