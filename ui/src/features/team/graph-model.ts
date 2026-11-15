// Task cards as graph nodes: open cards sit in a band under their owner agent, joined by an
// owner edge; dependsOn and parentId between shown cards become card-to-card edges.
import type { Card, CardStatus } from '@/data/types';

export interface Point { x: number; y: number }
export interface TaskNode { key: string; title: string; status: CardStatus; priority: Card['priority']; agentId: string; x: number; y: number }
export type TaskEdgeKind = 'owner' | 'depends' | 'parent';
export interface TaskEdge { kind: TaskEdgeKind; from: string; to: string }
export interface TaskGraph { nodes: TaskNode[]; edges: TaskEdge[]; hidden: Record<string, number>; bandY: number | null }

export const UNASSIGNED = '__unassigned__';
const STATUS_ORDER: Record<CardStatus, number> = { blocked: 0, doing: 1, review: 2, todo: 3, backlog: 4, done: 5 };
const PRIORITY_ORDER: Record<Card['priority'], number> = { P1: 0, P2: 1, P3: 2, '': 3 };

/** Edges use agent ids for owners and card keys for cards. Done cards are left out; each
 *  owner shows at most `perAgent` cards (blocked first) and the rest are counted in `hidden`. */
export function buildTaskGraph(cards: readonly Card[], agentPos: Readonly<Record<string, Point>>, opts: { perAgent?: number; width?: number } = {}): TaskGraph {
  const perAgent = opts.perAgent ?? 3;
  const width = opts.width ?? 780;
  const open = cards.filter((c) => c.status !== 'done');
  if (open.length === 0) return { nodes: [], edges: [], hidden: {}, bandY: null };

  const byOwner = new Map<string, Card[]>();
  for (const card of open) {
    const owner = agentPos[card.agentId] ? card.agentId : UNASSIGNED;
    (byOwner.get(owner) ?? byOwner.set(owner, []).get(owner)!).push(card);
  }
  const bandY = Math.max(0, ...Object.values(agentPos).map((p) => p.y)) + 110;
  const nodes: TaskNode[] = [];
  const hidden: Record<string, number> = {};
  for (const [owner, list] of byOwner) {
    const shown = [...list].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
      || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.key.localeCompare(b.key)).slice(0, perAgent);
    if (list.length > shown.length) hidden[owner] = list.length - shown.length;
    const cx = owner === UNASSIGNED ? width - 70 : agentPos[owner].x;
    shown.forEach((card, i) => nodes.push({
      key: card.key, title: card.title, status: card.status, priority: card.priority, agentId: card.agentId,
      x: Math.min(width - 60, Math.max(60, cx)), y: bandY + i * 44
    }));
  }

  const shownKeys = new Set(nodes.map((n) => n.key));
  const edges: TaskEdge[] = [];
  for (const node of nodes) {
    if (agentPos[node.agentId]) edges.push({ kind: 'owner', from: node.agentId, to: node.key });
    const card = open.find((c) => c.key === node.key)!;
    if (card.dependsOn && shownKeys.has(card.dependsOn)) edges.push({ kind: 'depends', from: node.key, to: card.dependsOn });
    if (card.parentId && shownKeys.has(card.parentId)) edges.push({ kind: 'parent', from: card.parentId, to: node.key });
  }
  return { nodes, edges, hidden, bandY };
}
