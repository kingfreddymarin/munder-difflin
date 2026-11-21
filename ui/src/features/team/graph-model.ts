// Team graph layout. Agents sit in rows by reporting depth; open task cards get their own
// column per owner in a band below, wrapped into extra rows when they do not fit, so no two
// card boxes can overlap. Owner, dependsOn and parentId edges join them.
import type { Card, CardStatus, Snapshot } from '@/data/types';

export type GraphTeam = NonNullable<Snapshot['teams']>[number];

export interface Point { x: number; y: number }
export interface GraphBox extends Point { width: number; height: number }
export interface TaskNode { key: string; title: string; status: CardStatus; priority: Card['priority']; agentId: string; x: number; y: number }
export type TaskEdgeKind = 'owner' | 'depends' | 'parent';
export interface TaskEdge { kind: TaskEdgeKind; from: string; to: string }
export interface TaskColumn { owner: string; x: number; top: number; shown: number; hidden: number }
export interface TaskGraph { nodes: TaskNode[]; edges: TaskEdge[]; columns: TaskColumn[]; height: number }

export const UNASSIGNED = '__unassigned__';
export const GRAPH_WIDTH = 780;
export const AGENT_W = 108;
export const AGENT_H = 62;
export const CARD_W = 120;
export const CARD_H = 30;
export const TEAM_W = 166;
export const TEAM_H = 38;
export const TRIGGER_W = 144;
export const TRIGGER_H = 28;
export const YOU: GraphBox = { x: 468, y: 25, width: 38, height: 36 };
export const agentKey = (id: string) => `agent:${id}`;
export const cardKey = (id: string) => `card:${id}`;
export const teamKey = (id: string) => `team:${id}`;
export const triggerKey = (id: string) => `automation:${id}`;
const COL_GAP = 130;
const ROW_GAP = 44;
const STATUS_ORDER: Record<CardStatus, number> = { blocked: 0, doing: 1, review: 2, todo: 3, backlog: 4, done: 5 };
const PRIORITY_ORDER: Record<Card['priority'], number> = { P1: 0, P2: 1, P3: 2, '': 3 };

/** Agent node centres: rows by reporting depth, wrapping before the labels crowd. */
export function agentLayout(agents: readonly { id: string; reportsTo?: string }[]): Record<string, Point> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const depth = (id: string, seen = 0): number => {
    const a = byId.get(id);
    return a?.reportsTo && seen < 6 ? 1 + depth(a.reportsTo, seen + 1) : 0;
  };
  const levels: Record<number, string[]> = {};
  agents.forEach((a) => (levels[depth(a.id)] ??= []).push(a.id));
  const positions: [string, Point][] = [];
  let y = 86;
  for (const ids of Object.values(levels)) {
    for (let start = 0; start < ids.length; start += 5) {
      const row = ids.slice(start, start + 5);
      row.forEach((id, i) => positions.push([id, { x: 468 + (i - (row.length - 1) / 2) * 122, y }]));
      y += 88;
    }
  }
  return Object.fromEntries(positions);
}

/** Done cards are left out. Each owner shows at most `perAgent` cards (blocked first) in its
 *  own column; the rest are counted in `hidden`. `height` is the full graph height. */
export function buildTaskGraph(cards: readonly Card[], agentPos: Readonly<Record<string, Point>>, opts: { perAgent?: number; width?: number; taskTop?: number } = {}): TaskGraph {
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
  const bandTop = Math.max(agentsBottom + 60, opts.taskTop ?? 0);

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

export type GraphPositions = Readonly<Record<string, Point>>;
export type GraphBoxes = Readonly<Record<string, GraphBox>>;

/** Keep the tree connected when a parent is archived and therefore has no graph node. */
export function visibleTeamChain(team: GraphTeam, visible: ReadonlySet<string>) {
  const members = new Set([team.leadId, ...team.memberIds]);
  return [...members].filter((id) => visible.has(id)).map((id) => {
    let parentId = id === team.leadId ? undefined : teamParent(team, id);
    const seen = new Set([id]);
    while (parentId && members.has(parentId) && !seen.has(parentId) && !visible.has(parentId)) {
      seen.add(parentId);
      parentId = parentId === team.leadId ? undefined : teamParent(team, parentId);
    }
    return { id, parentId: parentId && !seen.has(parentId) && members.has(parentId) && visible.has(parentId) ? parentId : undefined };
  });
}

function teamParent(team: GraphTeam, id: string): string {
  return team.parents && Object.hasOwn(team.parents, id) ? team.parents[id] : team.leadId;
}

export function buildGraphLayout(agents: readonly { id: string; reportsTo?: string }[], cards: readonly Card[], triggerIds: readonly string[], teamIds: readonly string[] = []) {
  const layout = agentLayout(agents);
  const triggers = triggerIds.map((id, i) => [triggerKey(id), { x: 82, y: 86 + i * 42, width: TRIGGER_W, height: TRIGGER_H }] as const);
  const triggerBottom = triggers.length ? triggers[triggers.length - 1][1].y + TRIGGER_H / 2 : 0;
  const teamTop = Math.max(triggerBottom, ...Object.values(layout).map((box) => box.y + AGENT_H / 2), YOU.y + YOU.height / 2) + 48;
  const teams = teamIds.map((id, index) => {
    const row = Math.floor(index / 4);
    const inRow = Math.min(4, teamIds.length - row * 4);
    const x = GRAPH_WIDTH / 2 + (index % 4 - (inRow - 1) / 2) * 184;
    return [teamKey(id), { x, y: teamTop + row * 56, width: TEAM_W, height: TEAM_H }] as const;
  });
  const teamBottom = teams.length ? teams[teams.length - 1][1].y + TEAM_H / 2 : 0;
  const tasks = buildTaskGraph(cards, layout, { taskTop: Math.max(triggerBottom, teamBottom) + 80 });
  const height = Math.max(tasks.height, triggerBottom + 12, teamBottom + 12);
  const slots: GraphBoxes = Object.fromEntries([
    ['you', YOU],
    ...Object.entries(layout).map(([id, p]) => [agentKey(id), { ...p, width: AGENT_W, height: AGENT_H }]),
    ...triggers,
    ...teams,
    ...tasks.nodes.map((node) => [cardKey(node.key), { x: node.x, y: node.y, width: CARD_W, height: CARD_H }]),
    ...tasks.columns.map((c) => [`column:${c.owner}`, { x: c.x, y: c.top - 28, width: CARD_W, height: 14 }]),
  ]);
  return { height, slots, tasks };
}

export function canPlace(box: GraphBox, id: string, slots: GraphBoxes, placed: GraphBoxes, height: number): boolean {
  const { x, y, width, height: boxHeight } = box;
  if (x < width / 2 + 4 || x > GRAPH_WIDTH - width / 2 - 4 || y < boxHeight / 2 + 4 || y > height - boxHeight / 2 - 4) return false;
  const clear = ([otherId, other]: [string, GraphBox]) => otherId === id
    || Math.abs(x - other.x) >= (width + other.width) / 2 + 3
    || Math.abs(y - other.y) >= (boxHeight + other.height) / 2 + 3;
  // Keep the default slots clear so every node can recover from a stale saved position.
  return Object.entries(slots).every(clear) && Object.entries(placed).every(clear);
}

export function placeGraphNodes(slots: GraphBoxes, saved: GraphPositions, height: number): GraphBoxes {
  const placed: Record<string, GraphBox> = { ...slots };
  for (const [id, slot] of Object.entries(slots)) {
    if (id === 'you' || id.startsWith('column:')) continue;
    const point = saved[id];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const box = { ...slot, x: point.x, y: point.y };
    if (canPlace(box, id, slots, placed, height)) placed[id] = box;
  }
  return placed;
}

export function keyboardGraphMove(id: string, direction: Point, slots: GraphBoxes, placed: GraphBoxes, height: number): Point | undefined {
  const box = placed[id];
  // If a neighbour blocks the next step, look for the next clear landing point on that axis.
  for (let distance = 12; distance <= Math.max(GRAPH_WIDTH, height); distance += 4) {
    const point = { x: box.x + direction.x * distance, y: box.y + direction.y * distance };
    if (canPlace({ ...box, ...point }, id, slots, placed, height)) return point;
  }
}
