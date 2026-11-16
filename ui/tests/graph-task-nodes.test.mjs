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
const { buildTaskGraph, agentLayout, UNASSIGNED, CARD_W, CARD_H, GRAPH_WIDTH } = mod.exports;

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

test('the graph panel renders task nodes and edges, and a card opens on the Board', () => {
  const panel = src('../src/features/team/graph-panel.tsx');
  assert.match(panel, /buildTaskGraph\(cards, layout\)/);
  assert.match(panel, /data-task-node=\{n\.key\}/);
  assert.match(panel, /aria-label=\{`Card \$\{n\.key\}: \$\{n\.title\}\. \$\{cardLabel\[n\.status\]\}/);
  assert.match(panel, /Owner \$\{agents\.find\(\(a\) => a\.id === n\.agentId\)\?\.name \?\? 'unassigned'\}/);
  assert.match(panel, /const openCard = \(key: string\) => go\('board', \{ card: key \}\)/);
  assert.match(panel, /data-edge="owner"/);
  assert.match(panel, /data-edge=\{e\.kind\}/);
  assert.match(panel, /\+\{c\.hidden\} more/);
  // agents and automations are still drawn
  assert.match(panel, /triggers\.map/);
  assert.match(panel, /agents\.map\(\(a\) => \(\n\s*<g key=\{a\.id\}/);
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

// Dwight F2: the band grew the drawing, but the tile did not, so Activity and Data sources
// covered every task node. The tile now fills its grid cell and the graph scrolls inside it.
test('the graph scrolls inside a tile that fills its grid cell', () => {
  const panel = src('../src/features/team/graph-panel.tsx');
  const team = src('../src/pages/team.tsx');
  assert.match(panel, /<div data-graph-scroll className="min-h-0 flex-1 overflow-auto">/);
  assert.match(panel, /viewBox=\{`0 0 \$\{GRAPH_WIDTH\} \$\{tasks\.height\}`\}/);
  assert.match(panel, /className="block h-auto w-full min-w-\[36rem\]"/);
  assert.match(team, /id=\{`team-panel-\$\{id\}`\} className="min-h-0 min-w-0">\n\s*<Tile [^\n]*className="h-full">/);
});

test('a task card opens with Enter or Space', () => {
  const panel = src('../src/features/team/graph-panel.tsx');
  assert.match(panel, /if \(e\.key === 'Enter' \|\| e\.key === ' '\) \{ e\.preventDefault\(\); openCard\(key\); \}/);
  assert.match(panel, /onKeyDown=\{\(e\) => activate\(e, n\.key\)\}/);
});
