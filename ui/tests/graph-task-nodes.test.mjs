import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// NSC-193 (owner): the Team graph shows task cards as nodes beside agents and automations,
// with status and owner, joined to their owner and to the cards they depend on.
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const js = ts.transpileModule(src('../src/features/team/graph-model.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const { buildTaskGraph, agentLayout, buildGraphLayout, placeGraphNodes, canPlace, keyboardGraphMove, UNASSIGNED, CARD_W, CARD_H, GRAPH_WIDTH } = mod.exports;

const card = (key, agentId, status = 'todo', extra = {}) => ({ key, title: `Card ${key}`, status, priority: '', agentId, created: '', createdBy: '', updated: '', description: '', plan: [], doneMeans: [], tags: [], refs: [], ...extra });
const pos = { god: { x: 480, y: 80 }, jim: { x: 300, y: 180 }, pam: { x: 660, y: 180 } };

test('open cards become nodes under their owner with status and owner identity', () => {
  const g = buildTaskGraph([card('NSC-1', 'jim', 'doing'), card('NSC-2', 'pam', 'blocked', { priority: 'P1' })], pos);
  assert.equal(g.nodes.length, 2);
  const one = g.nodes.find((n) => n.key === 'NSC-1');
  assert.equal(one.agentId, 'jim');
  assert.equal(one.status, 'doing');
  assert.ok(one.x < g.nodes.find((n) => n.key === 'NSC-2').x, 'columns follow owner order left to right');
  assert.ok(one.y > 180 + 50, 'below the agents and their labels');
  assert.equal(g.columns.find((c) => c.owner === 'jim').x, one.x);
  assert.equal(g.nodes.find((n) => n.key === 'NSC-2').priority, 'P1');
  assert.deepEqual(g.edges.filter((e) => e.kind === 'owner').map((e) => [e.from, e.to]).sort(), [['jim', 'NSC-1'], ['pam', 'NSC-2']]);
});

test('done cards are left out and no cards means no band', () => {
  const g = buildTaskGraph([card('NSC-3', 'jim', 'done')], pos);
  assert.deepEqual([g.nodes, g.edges, g.columns], [[], [], []]);
  assert.ok(g.height >= 280);
});

test('dependsOn and parentId between shown cards become card edges', () => {
  const g = buildTaskGraph([
    card('NSC-10', 'jim', 'doing'),
    card('NSC-11', 'jim', 'blocked', { dependsOn: 'NSC-10', parentId: 'NSC-12' }),
    card('NSC-12', 'pam', 'todo'),
    card('NSC-13', 'pam', 'todo', { dependsOn: 'NSC-999' })
  ], pos);
  assert.ok(g.edges.some((e) => e.kind === 'depends' && e.from === 'NSC-11' && e.to === 'NSC-10'));
  assert.ok(g.edges.some((e) => e.kind === 'parent' && e.from === 'NSC-12' && e.to === 'NSC-11'));
  assert.ok(!g.edges.some((e) => e.to === 'NSC-999'), 'no edge to a card that is not shown');
});

test('each owner shows at most perAgent cards, blocked first, the rest counted', () => {
  const g = buildTaskGraph([
    card('A-1', 'jim', 'backlog'), card('A-2', 'jim', 'todo', { priority: 'P1' }), card('A-3', 'jim', 'blocked'),
    card('A-4', 'jim', 'doing'), card('A-5', 'jim', 'todo')
  ], pos, { perAgent: 3 });
  assert.deepEqual(g.nodes.map((n) => n.key), ['A-3', 'A-4', 'A-2']);
  assert.equal(g.columns.find((c) => c.owner === 'jim').hidden, 2);
});

test('cards whose owner is not on the graph are grouped as unassigned', () => {
  const g = buildTaskGraph([card('U-1', 'gone'), card('U-2', '')], pos);
  assert.equal(g.nodes.length, 2);
  assert.ok(g.nodes.every((n) => n.x === g.nodes[0].x), 'one unassigned column');
  assert.equal(g.columns.at(-1).owner, UNASSIGNED, 'Unassigned is the last column');
  assert.equal(g.edges.filter((e) => e.kind === 'owner').length, 0);
  assert.equal(UNASSIGNED, '__unassigned__');
});

// Dwight F1: owners sharing or crowding an x (lead and middle report, Unassigned and the
// rightmost agent, rows of 4+) drew cards on top of each other.
const shapes = {
  1: [{ id: 'a0' }],
  2: [{ id: 'a0' }, { id: 'a1', reportsTo: 'a0' }],
  3: [{ id: 'a0' }, { id: 'a1', reportsTo: 'a0' }, { id: 'a2', reportsTo: 'a0' }],
  4: [{ id: 'a0' }, { id: 'a1', reportsTo: 'a0' }, { id: 'a2', reportsTo: 'a0' }, { id: 'a3', reportsTo: 'a0' }],
  5: [{ id: 'a0' }, ...[1, 2, 3, 4].map((i) => ({ id: `a${i}`, reportsTo: 'a0' }))],
  6: [{ id: 'a0' }, { id: 'a1', reportsTo: 'a0' }, { id: 'a2', reportsTo: 'a0' }, { id: 'a3', reportsTo: 'a1' }, { id: 'a4', reportsTo: 'a1' }, { id: 'a5', reportsTo: 'a2' }],
  7: [{ id: 'a0' }, ...[1, 2, 3, 4, 5, 6].map((i) => ({ id: `a${i}`, reportsTo: 'a0' }))]
};
const overlaps = (p, q, w, h) => Math.abs(p.x - q.x) < w && Math.abs(p.y - q.y) < h;
for (const [n, agents] of Object.entries(shapes)) {
  test(`no two task cards overlap, and none covers an agent, with ${n} agent(s)`, () => {
    const layout = agentLayout(agents);
    const cards = agents.flatMap((a) => [1, 2, 3, 4].map((i) => card(`${a.id}-${i}`, a.id, i === 1 ? 'blocked' : 'todo')));
    cards.push(card('U-1', 'gone'), card('U-2', 'gone'));
    const g = buildTaskGraph(cards, layout);
    assert.equal(g.columns.length, agents.length + 1, 'one column per owner plus Unassigned');
    for (let i = 0; i < g.nodes.length; i++) for (let j = i + 1; j < g.nodes.length; j++) {
      assert.ok(!overlaps(g.nodes[i], g.nodes[j], CARD_W, CARD_H), `${g.nodes[i].key} overlaps ${g.nodes[j].key}`);
    }
    const agentBottom = Math.max(...Object.values(layout).map((p) => p.y)) + 53;
    for (const node of g.nodes) {
      assert.ok(node.y - CARD_H / 2 > agentBottom, `${node.key} sits in the agent rows`);
      assert.ok(node.x - CARD_W / 2 >= 0 && node.x + CARD_W / 2 <= GRAPH_WIDTH, `${node.key} leaves the graph width`);
      assert.ok(node.y + CARD_H / 2 <= g.height, `${node.key} is below the drawing height`);
    }
    for (const c of g.columns) if (c.hidden) assert.ok(c.top + c.shown * 44 < g.height, 'the +N more line is inside the drawing');
  });
}

test('the Team page keeps graph and neighbouring tiles in their grid cells', () => {
  const team = src('../src/pages/team.tsx');
  assert.match(team, /id=\{`team-panel-\$\{id\}`\} className="min-h-0 min-w-0">\n\s*<Tile [^\n]*className="h-full">/);
});

const crowded = [{ id: 'lead' }, ...Array.from({ length: 21 }, (_, i) => ({ id: `agent-${i}`, reportsTo: i < 16 ? 'lead' : 'agent-4' }))];
const triggers = ['t1', 't2', 't3', 't4'];
const mixed = [...crowded.flatMap(({ id }) => ['1', '2', '3', '4'].map((i) => card(`${id}-${i}`, id))), card('orphan', '')];

for (const [label, agents, cards, automationIds] of [
  ['empty floor', [], [], []],
  ['only tasks and automations', [], [card('orphan', '')], triggers],
  ['many siblings and wrapped tasks', crowded, mixed, triggers],
  ['cyclic reporting and no tasks', [{ id: 'a', reportsTo: 'b' }, { id: 'b', reportsTo: 'a' }], [], triggers],
]) {
  test(`all default node and label bounds have clearance on ${label}`, () => {
    const { slots, height } = buildGraphLayout(agents, cards, automationIds);
    for (const [id, box] of Object.entries(slots)) {
      assert.ok(canPlace(box, id, slots, slots, height), `${id} touches another node or is outside the drawing`);
    }
  });
}

test('valid saved moves persist by identity after refresh, including distinct node families', () => {
  const agents = [{ id: 'same' }, { id: 'next', reportsTo: 'same' }];
  const cards = [card('same', 'same')];
  const { slots, height } = buildGraphLayout(agents, cards, ['same']);
  const saved = { 'agent:same': { x: 600, y: 86 }, 'card:same': { x: 250, y: 300 }, 'automation:same': { x: 150, y: 190 } };
  assert.ok(Object.keys(saved).every((id) => canPlace({ ...slots[id], ...saved[id] }, id, slots, slots, height)));
  const refreshed = buildGraphLayout(agents, cards.map((c) => ({ ...c, title: 'Renamed' })), ['same']);
  const placed = placeGraphNodes(refreshed.slots, saved, refreshed.height);
  for (const [id, point] of Object.entries(saved)) assert.deepEqual(placed[id], { ...slots[id], ...point });
  assert.deepEqual(placeGraphNodes(refreshed.slots, {}, refreshed.height), refreshed.slots);
});

test('conflicting or invalid saved positions recover safely when nodes enter or leave', () => {
  const saved = { 'agent:a': { x: 250, y: 174 }, 'agent:b': { x: 250, y: 174 }, 'card:orphan': { x: 0, y: 400 }, 'automation:t1': { x: null, y: 100 }, you: { x: 700, y: 30 } };
  const agents = [{ id: 'a' }, { id: 'b' }];
  const cards = [card('orphan', '')];
  const { slots, height } = buildGraphLayout(agents, cards, ['t1']);
  const placed = placeGraphNodes(slots, saved, height);
  assert.equal(placed['agent:a'].y, 174);
  for (const id of ['agent:b', 'card:orphan', 'automation:t1', 'you']) assert.deepEqual(placed[id], slots[id]);
  const crowded = buildGraphLayout([...agents, { id: 'new', reportsTo: 'a' }], cards, ['t1']);
  // The new node is at the centre of the second row. A move into its slot falls back.
  const previous = { 'agent:a': { x: 510, y: 174 } };
  assert.equal(placeGraphNodes(slots, previous, height)['agent:a'].y, 174);
  assert.deepEqual(placeGraphNodes(crowded.slots, previous, crowded.height)['agent:a'], crowded.slots['agent:a']);
});

test('arrow movement finds a clear landing beyond a neighbour and stops at the canvas edge', () => {
  const slots = {
    'agent:a': { x: 200, y: 86, width: 108, height: 62 },
    'agent:b': { x: 322, y: 86, width: 108, height: 62 },
  };
  const right = { x: 1, y: 0 };
  const id = 'agent:a';
  const point = keyboardGraphMove(id, right, slots, slots, 280);
  assert.ok(point && point.x > slots['agent:b'].x);
  assert.ok(canPlace({ ...slots[id], ...point }, id, slots, slots, 280));
  const placed = placeGraphNodes(slots, { [id]: { x: 722, y: 86 } }, 280);
  assert.equal(keyboardGraphMove(id, right, slots, placed, 280), undefined);
});
