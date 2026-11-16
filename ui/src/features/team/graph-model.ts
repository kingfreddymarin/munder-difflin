// Team graph layout. Agents sit in rows by reporting depth; open task cards get their own
// column per owner in a band below, wrapped into extra rows when they do not fit, so no two
// card boxes can overlap. Owner, dependsOn and parentId edges join them.
import type { Card, CardStatus } from '@/data/types';

export interface Point { x: number; y: number }
export interface TaskNode { key: string; title: string; status: CardStatus; priority: Card['priority']; agentId: string; x: number; y: number }
export type TaskEdgeKind = 'owner' | 'depends' | 'parent';
export interface TaskEdge { kind: TaskEdgeKind; from: string; to: string }
export interface TaskColumn { owner: string; x: number; top: number; shown: number; hidden: number }
export interface TaskGraph { nodes: TaskNode[]; edges: TaskEdge[]; columns: TaskColumn[]; height: number }

export const UNASSIGNED = '__unassigned__';
export const GRAPH_WIDTH = 780;
export const CARD_W = 120;
export const CARD_H = 30;
const COL_GAP = 130;
const ROW_GAP = 44;
const STATUS_ORDER: Record<CardStatus, number> = { blocked: 0, doing: 1, review: 2, todo: 3, backlog: 4, done: 5 };
const PRIORITY_ORDER: Record<Card['priority'], number> = { P1: 0, P2: 1, P3: 2, '': 3 };

/** Agent node centres: one row per reporting depth, spread across the graph. */
export function agentLayout(agents: readonly { id: string; reportsTo?: string }[]): Record<string, Point> {
  const depth = (id: string, seen = 0): number => {
    const a = agents.find((x) => x.id === id);
    return a?.reportsTo && seen < 6 ? 1 + depth(a.reportsTo, seen + 1) : 0;
  };
  const levels: Record<number, string[]> = {};
  agents.forEach((a) => (levels[depth(a.id)] ??= []).push(a.id));
  const pos: Record<string, Point> = {};
  Object.entries(levels).forEach(([lv, ids]) => ids.forEach((id, i) => (pos[id] = { x: 200 + ((i + 1) * 560) / (ids.length + 1), y: 80 + Number(lv) * 100 })));
  return pos;
}

/** Done cards are left out. Each owner shows at most `perAgent` cards (blocked first) in its
 *  own column; the rest are counted in `hidden`. `height` is the full graph height. */
export function buildTaskGraph(cards: readonly Card[], agentPos: Readonly<Record<string, Point>>, opts: { perAgent?: number; width?: number } = {}): TaskGraph {
  const perAgent = opts.perAgent ?? 3;
  const width = opts.width ?? GRAPH_WIDTH;
  const agentsBottom = Math.max(0, ...Object.values(agentPos).map((p) => p.y)) + 50;
  const open = cards.filter((c) => c.status !== 'done');
  if (open.length === 0) return { nodes: [], edges: [], columns: [], height: Math.max(agentsBottom, 280) };

  const byOwner = new Map<string, Card[]>();
  for (const card of open) {
    const owner = agentPos[card.agentId] ? card.agentId : UNASSIGNED;
    (byOwner.get(owner) ?? byOwner.set(owner, []).get(owner)!).push(card);
  }
  // Columns left to right in owner order, so owner edges cross as little as possible.
  const owners = [...byOwner.keys()].sort((a, b) => (a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : agentPos[a].x - agentPos[b].x || agentPos[a].y - agentPos[b].y));
  const perRow = Math.max(1, Math.floor((width - 20) / COL_GAP));
  const rowHeight = perAgent * ROW_GAP + 34; // room for "+N more" and the column label
  const bandTop = agentsBottom + 60;

  const nodes: TaskNode[] = [];
  const columns: TaskColumn[] = [];
  owners.forEach((owner, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, owners.length - row * perRow);
    const slot = i % perRow;
    const x = width / 2 + (slot - (inRow - 1) / 2) * COL_GAP;
    const top = bandTop + row * rowHeight;
    const list = byOwner.get(owner)!;
    const shown = [...list].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
      || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.key.localeCompare(b.key)).slice(0, perAgent);
    shown.forEach((card, j) => nodes.push({ key: card.key, title: card.title, status: card.status, priority: card.priority, agentId: card.agentId, x, y: top + j * ROW_GAP }));
    columns.push({ owner, x, top, shown: shown.length, hidden: list.length - shown.length });
  });

  const shownKeys = new Set(nodes.map((n) => n.key));
  const edges: TaskEdge[] = [];
  for (const node of nodes) {
    if (agentPos[node.agentId]) edges.push({ kind: 'owner', from: node.agentId, to: node.key });
    const card = open.find((c) => c.key === node.key)!;
    if (card.dependsOn && shownKeys.has(card.dependsOn)) edges.push({ kind: 'depends', from: node.key, to: card.dependsOn });
    if (card.parentId && shownKeys.has(card.parentId)) edges.push({ kind: 'parent', from: card.parentId, to: node.key });
  }
  const rows = Math.ceil(owners.length / perRow);
  return { nodes, edges, columns, height: bandTop + rows * rowHeight };
}
