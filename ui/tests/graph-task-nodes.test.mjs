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
const { buildTaskGraph, UNASSIGNED } = mod.exports;

const card = (key, agentId, status = 'todo', extra = {}) => ({ key, title: `Card ${key}`, status, priority: '', agentId, created: '', createdBy: '', updated: '', description: '', plan: [], doneMeans: [], tags: [], refs: [], ...extra });
const pos = { god: { x: 480, y: 80 }, jim: { x: 300, y: 180 }, pam: { x: 660, y: 180 } };

test('open cards become nodes under their owner with status and owner identity', () => {
  const g = buildTaskGraph([card('NSC-1', 'jim', 'doing'), card('NSC-2', 'pam', 'blocked', { priority: 'P1' })], pos);
  assert.equal(g.nodes.length, 2);
  const one = g.nodes.find((n) => n.key === 'NSC-1');
  assert.equal(one.agentId, 'jim');
  assert.equal(one.status, 'doing');
  assert.equal(one.x, 300, 'sits under its owner');
  assert.ok(one.y > 180, 'below the agents');
  assert.equal(g.nodes.find((n) => n.key === 'NSC-2').priority, 'P1');
  assert.deepEqual(g.edges.filter((e) => e.kind === 'owner').map((e) => [e.from, e.to]).sort(), [['jim', 'NSC-1'], ['pam', 'NSC-2']]);
});

test('done cards are left out and no cards means no band', () => {
  assert.deepEqual(buildTaskGraph([card('NSC-3', 'jim', 'done')], pos), { nodes: [], edges: [], hidden: {}, bandY: null });
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
  assert.equal(g.hidden.jim, 2);
});

test('cards whose owner is not on the graph are grouped as unassigned', () => {
  const g = buildTaskGraph([card('U-1', 'gone'), card('U-2', '')], pos);
  assert.equal(g.nodes.length, 2);
  assert.ok(g.nodes.every((n) => n.x === g.nodes[0].x), 'one unassigned column');
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
  assert.match(panel, /\+\{count\} more/);
  // agents and automations are still drawn
  assert.match(panel, /triggers\.map/);
  assert.match(panel, /agents\.map\(\(a\) => \(\n\s*<g key=\{a\.id\}/);
});
