import * as React from 'react';
import { useFloor } from '@/data/store';
import { statusMeta } from '@/components/app/status';
import { useRouter } from '@/app/router';
import type { CardStatus } from '@/data/types';
import { useAgentActionTargets } from './agent-action-menu';
import { AGENT_H, AGENT_W, agentKey, buildGraphLayout, cardKey, CARD_H, CARD_W, GRAPH_WIDTH, triggerKey, TRIGGER_H, TRIGGER_W, UNASSIGNED, YOU, type GraphBox } from './graph-model';
import { useGraphPlacement } from './use-graph-placement';

const activeStroke = 'stroke-yellow-700 dark:stroke-yellow-300';
const neutralStroke = 'stroke-neutral-500';
const agentStroke = { working: activeStroke, waiting: activeStroke, constrained: neutralStroke, idle: neutralStroke, crashed: neutralStroke };
const cardStroke: Record<CardStatus, string> = { blocked: activeStroke, doing: activeStroke, review: neutralStroke, todo: neutralStroke, backlog: neutralStroke, done: neutralStroke };
const cardLabel: Record<CardStatus, string> = { blocked: 'Blocked', doing: 'Doing', review: 'In review', todo: 'To do', backlog: 'Backlog', done: 'Done' };
const toolbarButton = 'rounded px-2 py-1 font-medium hover:bg-neutral-200 dark:hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-current disabled:opacity-40';
const clip = (text: string, limit: number) => {
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : text;
};

/** Where the line between two node centres meets the edge of the first node. */
function edgePoint(from: GraphBox, to: GraphBox) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const fraction = Math.min(from.width / 2 / Math.abs(dx), from.height / 2 / Math.abs(dy));
  return { x: from.x + dx * fraction, y: from.y + dy * fraction };
}

function GraphEdge({ from, to, kind, strokeClass = 'stroke-current', dash, strong = false }: { from: GraphBox; to: GraphBox; kind: string; strokeClass?: string; dash?: string; strong?: boolean }) {
  if (from === to) return null;
  const a = edgePoint(from, to);
  const b = edgePoint(to, from);
  return <line data-edge={kind} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={strokeClass} strokeDasharray={dash} strokeWidth={strong ? 2.5 : 1.5} opacity={strong ? 0.9 : 0.65} />;
}

export function GraphPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const floor = useFloor((s) => s.floorSetup?.harnessHome);
  const storageKey = `paramount.team.graph.v1:${floor ?? 'sample'}`;
  return <FloorGraph key={storageKey} storageKey={storageKey} onOpen={onOpen} />;
}

function FloorGraph({ storageKey, onOpen }: { storageKey: string; onOpen: (id: string) => void }) {
  const agents = useFloor((s) => s.agents);
  const automations = useFloor((s) => s.automations);
  const cards = useFloor((s) => s.cards);
  const actionTargets = useAgentActionTargets(agents.map((agent) => agent.id));
  const { go } = useRouter();
  const scroll = React.useRef<HTMLDivElement>(null);
  const svg = React.useRef<SVGSVGElement>(null);
  const hintId = React.useId();
  const clipId = React.useId();
  const agentsById = React.useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const countsByAgent = React.useMemo(() => {
    const counts = new Map<string, { open: number; blocked: number }>();
    for (const card of cards) {
      if (card.status === 'done') continue;
      const owner = counts.get(card.agentId) ?? { open: 0, blocked: 0 };
      owner.open++;
      if (card.status === 'blocked') owner.blocked++;
      counts.set(card.agentId, owner);
    }
    return counts;
  }, [cards]);
  const rootId = (agents.find((a) => a.role === 'paramount') ?? agents.find((a) => !a.reportsTo))?.id;
  const triggers = React.useMemo(() => automations.filter((a) => a.enabled).slice(0, 4), [automations]);
  const { slots, tasks, height } = React.useMemo(() => buildGraphLayout(agents, cards, triggers.map((t) => t.id)), [agents, cards, triggers]);
  const { displayed, bind, notice, reset, canReset } = useGraphPlacement(storageKey, slots, height, svg);
  const root = rootId ? displayed[agentKey(rootId)] : undefined;
  const openCard = (key: string) => go('board', { card: key });

  function jumpToTask() {
    if (!tasks.nodes.length || !svg.current) return;
    const first = tasks.nodes.reduce((top, node) => displayed[cardKey(node.key)].y < displayed[cardKey(top.key)].y ? node : top);
    const target = [...svg.current.querySelectorAll<SVGGElement>('[data-task-node]')].find((node) => node.dataset.taskNode === first.key);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 border-b border-neutral-300 pb-1 text-xs text-black dark:border-neutral-700 dark:text-white">
        <span id={hintId} className="mr-auto text-neutral-600 dark:text-neutral-400">Drag nodes or use the arrow keys.</span>
        <button type="button" className={toolbarButton} onClick={() => scroll.current?.scrollTo(0, 0)}>Top</button>
        <button type="button" className={toolbarButton} onClick={jumpToTask} disabled={!tasks.nodes.length}>Tasks</button>
        <button type="button" className={toolbarButton} onClick={reset} disabled={!canReset}>Reset layout</button>
      </div>
      <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-600 dark:text-neutral-400" aria-label="Connection types">
        <span><span aria-hidden="true">━ </span>Reporting / ownership</span>
        <span><span aria-hidden="true" className="text-yellow-700 dark:text-yellow-300">┄ </span>Waiting on you</span>
        <span><span aria-hidden="true">┄ </span>Trigger / dependency</span>
        <span><span aria-hidden="true">┈ </span>Parent task</span>
      </div>
      <span className="sr-only" role="status">{notice}</span>
      <div ref={scroll} data-graph-scroll className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg bg-neutral-100 dark:bg-neutral-900">
        <svg ref={svg} viewBox={`0 0 ${GRAPH_WIDTH} ${height}`} role="group" aria-label="Team graph" className="block h-auto w-full min-w-[36rem]">
          <defs>
            {[[AGENT_W, AGENT_H], [CARD_W, CARD_H], [TRIGGER_W, TRIGGER_H]].map(([width, h]) => (
              <clipPath id={`${clipId}-${width}`} key={width}><rect x={-width / 2 + 7} y={-h / 2} width={width - 14} height={h} /></clipPath>
            ))}
          </defs>
          <g aria-hidden="true" className="pointer-events-none text-neutral-600 dark:text-neutral-400">
            {root && <GraphEdge from={YOU} to={root} kind="reports" strokeClass={activeStroke} strong />}
            {agents.map((a) => {
              const manager = a.reportsTo && agentsById.has(a.reportsTo) ? displayed[agentKey(a.reportsTo)] : undefined;
              return manager && <GraphEdge key={a.id} from={manager} to={displayed[agentKey(a.id)]} kind="reports" strokeClass={a.status === 'working' ? activeStroke : undefined} strong={a.status === 'working'} />;
            })}
            {agents.filter((a) => a.status === 'waiting').map((a) => <GraphEdge key={a.id} from={displayed[agentKey(a.id)]} to={YOU} kind="waiting" strokeClass={activeStroke} dash="6 5" />)}
            {triggers.map((t) => <GraphEdge key={t.id} from={displayed[triggerKey(t.id)]} to={root ?? YOU} kind="trigger" dash="4 5" />)}
            {tasks.edges.map((e) => <GraphEdge key={`${e.kind}-${e.from}-${e.to}`} from={displayed[e.kind === 'owner' ? agentKey(e.from) : cardKey(e.from)]} to={displayed[cardKey(e.to)]} kind={e.kind} dash={e.kind === 'depends' ? '6 4' : e.kind === 'parent' ? '2 4' : undefined} />)}
          </g>
          <circle cx={YOU.x} cy={YOU.y} r="17" fill="currentColor" className="text-black dark:text-white" />
          <text x={YOU.x} y={YOU.y + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill="currentColor" className="text-white dark:text-black">You</text>
          {triggers.map((t) => {
            const id = triggerKey(t.id);
            const { x, y, width, height: h } = displayed[id];
            return <g key={id} {...bind(id, t.name, () => go('team', { panel: 'automations' }))} data-graph-node={id} aria-label={`Automation ${t.name}. Open Automations.`} aria-describedby={hintId} transform={`translate(${x} ${y})`}>
              <rect x={-width / 2} y={-h / 2} width={width} height={h} rx="7" className="fill-white stroke-neutral-500 dark:fill-neutral-950" strokeDasharray="3 3" />
              <text x="0" y="4" clipPath={`url(#${clipId}-${width})`} textAnchor="middle" fontSize="11" fill="currentColor" className="text-black dark:text-white">{clip(t.name, 21)}</text>
              <title>{t.name}</title>
            </g>;
          })}
          {agents.map((a) => {
            const id = agentKey(a.id);
            const { x, y, width, height: h } = displayed[id];
            const counts = countsByAgent.get(a.id);
            const summary = `${counts?.open ?? 0} open · ${counts?.blocked ?? 0} blocked`;
            const team = a.teamNames?.join(', ');
            const label = `${a.name}, ${statusMeta[a.status].label}. ${team ? `${team}. ` : ''}${summary}. Right-click or Shift+F10 for agent actions.`;
            return <g key={id} {...bind(id, a.name, () => onOpen(a.id), actionTargets[a.id]?.onKeyDown)} onContextMenu={actionTargets[a.id]?.onContextMenu} data-graph-node={id} aria-label={label} aria-describedby={hintId} transform={`translate(${x} ${y})`}>
              <rect x={-width / 2} y={-h / 2} width={width} height={h} rx="9" className="fill-white stroke-neutral-400 dark:fill-neutral-950 dark:stroke-neutral-600" strokeWidth="2" />
              <circle cy="-17" r="11" className={`fill-neutral-100 dark:fill-neutral-800 ${agentStroke[a.status]}`} strokeWidth="2" />
              <text y="-14" textAnchor="middle" fontSize="8" fontFamily="var(--font-mono)" fill="currentColor" className="text-black dark:text-white">{a.initials}</text>
              <g clipPath={`url(#${clipId}-${width})`} textAnchor="middle" fill="currentColor">
                <text y="4" fontSize="11" fontWeight="600" className="text-black dark:text-white">{clip(a.name, 16)}</text>
                <text y="15" fontSize="9" className="text-neutral-600 dark:text-neutral-400">{team && clip(team, 18)}</text>
                <text y={team ? 25 : 19} fontSize="9" className="text-neutral-600 dark:text-neutral-400">{summary}</text>
              </g>
              <title>{[a.name, team, statusMeta[a.status].label].filter(Boolean).join(' · ')}</title>
            </g>;
          })}
          {tasks.columns.map((c) => {
            const owner = c.owner === UNASSIGNED ? 'Unassigned' : agentsById.get(c.owner)?.name ?? c.owner;
            return <g key={c.owner} transform={`translate(${c.x} ${c.top - 28})`}>
              <text y="4" clipPath={`url(#${clipId}-${CARD_W})`} textAnchor="middle" fontSize="10" fill="currentColor" className="text-neutral-600 dark:text-neutral-400">{c.hidden ? `${clip(owner, 11)} · +${c.hidden} more` : clip(owner, 19)}</text>
              <title>{owner}{c.hidden > 0 && ` · +${c.hidden} more`}</title>
            </g>;
          })}
          {tasks.nodes.map((n) => {
            const id = cardKey(n.key);
            const { x, y, width, height: h } = displayed[id];
            const owner = agentsById.get(n.agentId)?.name ?? 'unassigned';
            const status = `${cardLabel[n.status]}${n.priority ? `, ${n.priority}` : ''}`;
            const label = `Card ${n.key}: ${n.title}. ${status}. Owner ${owner}.`;
            return <g key={id} {...bind(id, n.key, () => openCard(n.key))} data-graph-node={id} data-task-node={n.key} aria-label={label} aria-describedby={hintId} transform={`translate(${x} ${y})`}>
              <rect x={-width / 2} y={-h / 2} width={width} height={h} rx="6" className={`fill-white dark:fill-neutral-950 ${cardStroke[n.status]}`} strokeWidth="2" />
              <g clipPath={`url(#${clipId}-${width})`} textAnchor="middle" fill="currentColor">
                <text y="-2" fontSize="9" className="text-neutral-600 dark:text-neutral-400">{clip(`${n.key} · ${status}`, 23)}</text>
                <text y="10" fontSize="10" className="text-black dark:text-white">{clip(n.title, 19)}</text>
              </g>
              <title>{label}</title>
            </g>;
          })}
        </svg>
      </div>
    </>
  );
}
