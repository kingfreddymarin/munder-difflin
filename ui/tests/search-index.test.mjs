import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

// Compile search-index.ts standalone (no @/ aliases — pure module).
const outputDir = mkdtempSync(join(tmpdir(), 'paramount-search-index-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', join(HERE, '../src/features/search/search-index.ts'),
]);
const file = readdirSync(outputDir, { recursive: true }).find((n) => String(n).endsWith('search-index.js'));
const { buildSearchIndex, filterResults, groupResults, STATIC_VIEWS, STATIC_SETTINGS, KIND_ORDER, KIND_LABELS } =
  await import(pathToFileURL(join(outputDir, String(file))).href);

// — fixtures —

function agent(id, name, role = 'worker') { return { id, name, role }; }
function card(key, title, status = 'doing') { return { key, title, status }; }
function automation(id, name, when = 'on push') { return { id, name, when }; }

// — buildSearchIndex —

test('buildSearchIndex: empty floor → only static items', () => {
  const index = buildSearchIndex([], [], []);
  assert.ok(index.length > 0, 'static items present');
  assert.ok(index.every((r) => r.kind === 'view' || r.kind === 'setting'));
});

test('buildSearchIndex: agents appear with route=terminal and agent param', () => {
  const index = buildSearchIndex([agent('a1', 'Ada'), agent('a2', 'Bob')], [], []);
  const agents = index.filter((r) => r.kind === 'agent');
  assert.equal(agents.length, 2);
  assert.equal(agents[0].label, 'Ada');
  assert.equal(agents[0].route, 'terminal');
  assert.deepEqual(agents[0].params, { a: 'a1' });
});

test('buildSearchIndex: tasks appear with route=board and no params', () => {
  const index = buildSearchIndex([], [card('c1', 'Ship auth'), card('c2', 'Fix bug')], []);
  const tasks = index.filter((r) => r.kind === 'task');
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].label, 'Ship auth');
  assert.equal(tasks[0].route, 'board');
  assert.equal(tasks[0].params, undefined);
});

test('buildSearchIndex: automations appear with route=team and panel=automations', () => {
  const index = buildSearchIndex([], [], [automation('x1', 'Deploy on push')]);
  const autos = index.filter((r) => r.kind === 'automation');
  assert.equal(autos.length, 1);
  assert.equal(autos[0].label, 'Deploy on push');
  assert.equal(autos[0].route, 'team');
  assert.deepEqual(autos[0].params, { panel: 'automations' });
});

test('buildSearchIndex: each result has a unique id', () => {
  const index = buildSearchIndex([agent('a1', 'Ada')], [card('c1', 'Ship')], [automation('x1', 'Auto')]);
  const ids = index.map((r) => r.id);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size, 'duplicate ids detected');
});

test('buildSearchIndex: static views cover all navigable routes', () => {
  const index = buildSearchIndex([], [], []);
  const viewRoutes = new Set(index.filter((r) => r.kind === 'view').map((r) => r.route));
  for (const route of ['home', 'terminal', 'board', 'team', 'health', 'settings', 'side-agent']) {
    assert.ok(viewRoutes.has(route), `missing view for route: ${route}`);
  }
});

test('buildSearchIndex: static settings cover all settings tabs', () => {
  const index = buildSearchIndex([], [], []);
  const settingTabs = new Set(
    index.filter((r) => r.kind === 'setting').map((r) => r.params?.tab).filter(Boolean),
  );
  for (const tab of ['account', 'connections', 'team', 'providers', 'memory', 'autonomy', 'notifications', 'audit']) {
    assert.ok(settingTabs.has(tab), `missing settings tab: ${tab}`);
  }
});

// — filterResults —

test('filterResults: empty query returns all items', () => {
  const index = buildSearchIndex([agent('a1', 'Ada')], [], []);
  assert.deepEqual(filterResults(index, ''), index);
  assert.deepEqual(filterResults(index, '   '), index);
});

test('filterResults: label match (case-insensitive)', () => {
  const index = buildSearchIndex([agent('a1', 'Ada'), agent('a2', 'Bob')], [], []);
  const results = filterResults(index, 'ada');
  assert.ok(results.some((r) => r.label === 'Ada'));
  assert.ok(!results.some((r) => r.label === 'Bob'));
});

test('filterResults: detail match', () => {
  const index = buildSearchIndex([], [card('c1', 'Ship auth', 'blocked')], []);
  const results = filterResults(index, 'blocked');
  assert.ok(results.some((r) => r.id === 'task:c1'));
});

test('filterResults: static settings matched by keyword', () => {
  const index = buildSearchIndex([], [], []);
  const results = filterResults(index, 'provider');
  assert.ok(results.some((r) => r.id === 'setting:providers'), 'AI engines tab must match "provider"');
});

test('filterResults: query with no match returns empty list', () => {
  const index = buildSearchIndex([agent('a1', 'Ada')], [], []);
  const results = filterResults(index, 'xyzzy-no-match');
  assert.equal(results.length, 0);
});

// — groupResults —

test('groupResults: kinds appear in KIND_ORDER and empty groups are dropped', () => {
  const index = buildSearchIndex([agent('a1', 'Ada')], [], []);
  const groups = groupResults(index);
  const kinds = groups.map((g) => g.kind);
  // agent should be first (KIND_ORDER[0] = 'agent')
  assert.equal(kinds[0], 'agent');
  // No task or automation in input → those groups absent
  assert.ok(!kinds.includes('task'));
  assert.ok(!kinds.includes('automation'));
});

test('groupResults: all results appear in exactly one group', () => {
  const all = buildSearchIndex([agent('a1', 'Ada')], [card('c1', 'Ship')], [automation('x1', 'Auto')]);
  const groups = groupResults(all);
  const flatFromGroups = groups.flatMap((g) => g.results);
  assert.equal(flatFromGroups.length, all.length);
});

test('groupResults: group labels use KIND_LABELS', () => {
  const index = buildSearchIndex([agent('a1', 'Ada')], [], []);
  const groups = groupResults(index);
  const agentGroup = groups.find((g) => g.kind === 'agent');
  assert.equal(agentGroup?.label, KIND_LABELS.agent);
});

// — integration: navigation targets from app-shell —

test('search navigates automations panel via team route', () => {
  const index = buildSearchIndex([], [], [automation('x1', 'Nightly build')]);
  const item = index.find((r) => r.kind === 'automation');
  assert.ok(item, 'automation item present');
  assert.equal(item.route, 'team');
  assert.deepEqual(item.params, { panel: 'automations' });
});

test('agent navigation uses terminal route with agent id param', () => {
  const index = buildSearchIndex([agent('agent-99', 'Marvin', 'lead')], [], []);
  const item = index.find((r) => r.id === 'agent:agent-99');
  assert.ok(item);
  assert.equal(item.route, 'terminal');
  assert.deepEqual(item.params, { a: 'agent-99' });
});
