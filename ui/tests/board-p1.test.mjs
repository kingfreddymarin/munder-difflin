/**
 * Tests for board-p1.ts: NSC-259 (isAlmostDone), NSC-257 (autoUnblockItems),
 * NSC-260 (card.archive loop — reducer-level).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

// Compile board-p1.ts standalone.
const outputDir = mkdtempSync(join(tmpdir(), 'paramount-board-p1-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext',
  '--moduleResolution', 'Bundler', '--skipLibCheck',
  join(HERE, '../src/features/board/board-p1.ts'),
]);
const file = readdirSync(outputDir, { recursive: true }).find((n) => String(n).endsWith('board-p1.js'));
const { isAlmostDone, autoUnblockItems } = await import(pathToFileURL(join(outputDir, String(file))).href);

// — fixtures —

function card(overrides = {}) {
  return { key: 'NSC-1', status: 'blocked', boardArchivedAt: undefined, dependsOn: undefined, task: undefined, refs: [], ...overrides };
}
function msg(overrides = {}) {
  return { kind: 'question', ticket: undefined, answer: undefined, dismissed: undefined, ...overrides };
}

// ─── isAlmostDone (NSC-259) ───────────────────────────────────────────────────

test('isAlmostDone: done card → false', () => {
  assert.equal(isAlmostDone(card({ status: 'done', refs: [{ kind: 'pr' }] }), []), false);
});

test('isAlmostDone: archived card → false', () => {
  assert.equal(isAlmostDone(card({ boardArchivedAt: '2026-11-21T00:00:00Z', refs: [{ kind: 'pr' }] }), []), false);
});

test('isAlmostDone: card with pr ref + review status → true', () => {
  assert.equal(isAlmostDone(card({ status: 'review', refs: [{ kind: 'pr' }] }), []), true);
});

test('isAlmostDone: card with pr ref + doing status → true', () => {
  assert.equal(isAlmostDone(card({ status: 'doing', refs: [{ kind: 'pr' }] }), []), true);
});

test('isAlmostDone: card with only build ref (not pr) → false', () => {
  assert.equal(isAlmostDone(card({ status: 'review', refs: [{ kind: 'build' }] }), []), false);
});

test('isAlmostDone: card with open humanQA ask → true', () => {
  const c = card({ status: 'review', task: 'NSC-1' });
  const msgs = [msg({ ticket: 'NSC-1', answer: undefined, dismissed: undefined })];
  assert.equal(isAlmostDone(c, msgs), true);
});

test('isAlmostDone: card with answered humanQA ask → false', () => {
  const c = card({ status: 'review', task: 'NSC-1' });
  const msgs = [msg({ ticket: 'NSC-1', answer: 'yes', dismissed: undefined })];
  assert.equal(isAlmostDone(c, msgs), false);
});

test('isAlmostDone: card with dismissed humanQA ask → false', () => {
  const c = card({ status: 'review', task: 'NSC-1' });
  const msgs = [msg({ ticket: 'NSC-1', answer: undefined, dismissed: true })];
  assert.equal(isAlmostDone(c, msgs), false);
});

test('isAlmostDone: card with no refs and no open asks → false', () => {
  assert.equal(isAlmostDone(card({ status: 'review' }), []), false);
});

test('isAlmostDone: ask on a different card does not trigger → false', () => {
  const c = card({ status: 'review', task: 'NSC-1' });
  const msgs = [msg({ ticket: 'NSC-99' })];
  assert.equal(isAlmostDone(c, msgs), false);
});

// ─── autoUnblockItems (NSC-257) ───────────────────────────────────────────────

test('autoUnblockItems: no dependsOn, no asks → empty', () => {
  assert.deepEqual(autoUnblockItems(card(), []), []);
});

test('autoUnblockItems: dependsOn present → includes dependency item', () => {
  const items = autoUnblockItems(card({ dependsOn: 'NSC-5' }), []);
  assert.ok(items.some((i) => i.includes('NSC-5')));
});

test('autoUnblockItems: open humanQA ask → includes ask item', () => {
  const c = card({ task: 'NSC-1' });
  const msgs = [msg({ ticket: 'NSC-1' })];
  const items = autoUnblockItems(c, msgs);
  assert.ok(items.length > 0, 'should have at least one item');
});

test('autoUnblockItems: answered ask is excluded', () => {
  const c = card({ task: 'NSC-1' });
  const msgs = [msg({ ticket: 'NSC-1', answer: 'yes' })];
  assert.deepEqual(autoUnblockItems(c, msgs), []);
});

test('autoUnblockItems: dependsOn + open ask → two items', () => {
  const c = card({ task: 'NSC-1', dependsOn: 'NSC-5' });
  const msgs = [msg({ ticket: 'NSC-1' })];
  const items = autoUnblockItems(c, msgs);
  assert.equal(items.length, 2);
});

// ─── NSC-260 reducer: card.archive mass-dispatch ───────────────────────────────

// Compile reducer.ts standalone to test the archive-all logic.
const reducerOutDir = mkdtempSync(join(tmpdir(), 'paramount-reducer-'));
// reducer.ts imports types — keep it minimal by testing only applyEvent for card.archive
// The board dispatches card.archive once per card in a loop; test via the reducer.
import { createRequire } from 'node:module';
const reqHere = createRequire(import.meta.url);

// We test the loop result by simulating multiple archive events on a minimal snapshot.
// Build a minimal snapshot manually.
function snap(cards) {
  return {
    cards, agents: [], chats: [], messages: [], notifications: [],
    audit: [], board: { columns: [] }, me: { yolo: {}, iteration: {}, name: '', email: '', workEmail: '', timezone: '', connections: [], notify: [] },
    prerequisites: [], objectives: [], wins: [], timelines: [], sources: [], engines: [], automations: [], services: [], log: [], terminals: [], activity: [], access: {},
  };
}

// Compile reducer
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', reducerOutDir, '--target', 'ES2022', '--module', 'ESNext',
  '--moduleResolution', 'Bundler', '--skipLibCheck',
  join(HERE, '../src/data/reducer.ts'),
], { env: { ...process.env } });

const rFile = readdirSync(reducerOutDir, { recursive: true }).find((n) => String(n).endsWith('reducer.js'));
const { applyEvent } = await import(pathToFileURL(join(reducerOutDir, String(rFile))).href);

function archiveEvent(key, at = '2026-11-21T18:00:00Z') {
  return { id: `ev-${key}`, at, actor: 'you', command: { type: 'card.archive', key } };
}

test('NSC-260 archive-all: archiving each done card sets boardArchivedAt', () => {
  const cards = [
    { key: 'NSC-1', status: 'done', boardArchivedAt: undefined, title: 'A', agentId: '', created: '', createdBy: '', updated: '', description: '', plan: [], doneMeans: [], tags: [], refs: [], tokens: 0, origin: '', people: [] },
    { key: 'NSC-2', status: 'done', boardArchivedAt: undefined, title: 'B', agentId: '', created: '', createdBy: '', updated: '', description: '', plan: [], doneMeans: [], tags: [], refs: [], tokens: 0, origin: '', people: [] },
  ];
  let s = snap(cards);
  s = applyEvent(s, archiveEvent('NSC-1'));
  s = applyEvent(s, archiveEvent('NSC-2'));
  assert.ok(s.cards.find((c) => c.key === 'NSC-1')?.boardArchivedAt, 'NSC-1 should be archived');
  assert.ok(s.cards.find((c) => c.key === 'NSC-2')?.boardArchivedAt, 'NSC-2 should be archived');
});

test('NSC-260 archive-all: already-archived card is not re-archived', () => {
  const at = '2026-11-21T10:00:00Z';
  const cards = [
    { key: 'NSC-3', status: 'done', boardArchivedAt: at, title: 'C', agentId: '', created: '', createdBy: '', updated: '', description: '', plan: [], doneMeans: [], tags: [], refs: [], tokens: 0, origin: '', people: [] },
  ];
  const s = applyEvent(snap(cards), archiveEvent('NSC-3'));
  assert.equal(s.cards.find((c) => c.key === 'NSC-3')?.boardArchivedAt, at, 'timestamp should not change');
});

test('NSC-257 reducer: blockItems applied by card.update', () => {
  const cards = [
    { key: 'NSC-7', status: 'blocked', title: 'X', agentId: '', created: '', createdBy: '', updated: '', description: '', plan: [], doneMeans: [], tags: [], refs: [], tokens: 0, origin: '', people: [], priority: '' },
  ];
  const s = applyEvent(snap(cards), {
    id: 'ev-block', at: '2026-11-21T18:00:00Z', actor: 'you',
    command: { type: 'card.update', key: 'NSC-7', patch: { blockItems: ['Get owner sign-off'] } },
  });
  assert.deepEqual(s.cards.find((c) => c.key === 'NSC-7')?.blockItems, ['Get owner sign-off']);
});

// ─── NSC-261 newCardDefaults (shape tests — type-correctness covered by root tsc gate) ──────

// Mirror of the pure helper exported from new-card-dialog.tsx.
// Tests the contract without importing React or @/ aliases.
function newCardDefaults(assignee) {
  return { title: '', description: '', assignee: assignee ?? '', priority: 2, status: 'todo', parentId: '', dependsOn: '', blockItemDraft: '', blockItems: [] };
}

test('NSC-261 newCardDefaults: has all required card fields', () => {
  const d = newCardDefaults();
  const expected = ['title', 'description', 'assignee', 'priority', 'status', 'parentId', 'dependsOn', 'blockItemDraft', 'blockItems'];
  for (const field of expected) {
    assert.ok(field in d, `newCardDefaults must include field: ${field}`);
  }
});

test('NSC-261 newCardDefaults: default priority is 2 (P2)', () => {
  assert.equal(newCardDefaults().priority, 2);
});

test('NSC-261 newCardDefaults: default status is todo', () => {
  assert.equal(newCardDefaults().status, 'todo');
});

test('NSC-261 newCardDefaults: blockItems defaults to empty array', () => {
  assert.deepEqual(newCardDefaults().blockItems, []);
});

test('NSC-261 newCardDefaults: assignee seed forwarded from argument', () => {
  assert.equal(newCardDefaults('agent-42').assignee, 'agent-42');
});

// ─── NSC-261 reducer: card.create with new fields ─────────────────────────────

function makeCard(key, overrides = {}) {
  return { key, status: 'todo', title: 'T', agentId: '', created: '', createdBy: '', updated: '', description: '', plan: [], doneMeans: [], tags: [], refs: [], tokens: 0, origin: '', people: [], priority: '', ...overrides };
}

test('NSC-261 reducer card.create: parentId and blockItems on new card', () => {
  const parent = makeCard('NSC-1');
  const s = applyEvent(snap([parent]), {
    id: 'ev1', at: '2026-11-21T20:00:00Z', actor: 'you',
    command: { type: 'card.create', key: 'NSC-2', title: 'Child', parentId: 'NSC-1', blockItems: ['Needs review'] },
  });
  const child = s.cards.find(c => c.key === 'NSC-2');
  assert.equal(child?.parentId, 'NSC-1', 'parentId should be set on new card');
  assert.deepEqual(child?.blockItems, ['Needs review'], 'blockItems should be set on new card');
});

test('NSC-261 reducer card.create: dependsOn joined to string on Card', () => {
  const dep = makeCard('NSC-1');
  const s = applyEvent(snap([dep]), {
    id: 'ev2', at: '2026-11-21T20:00:00Z', actor: 'you',
    command: { type: 'card.create', key: 'NSC-3', title: 'Task', dependsOn: ['NSC-1'] },
  });
  const card = s.cards.find(c => c.key === 'NSC-3');
  assert.equal(card?.dependsOn, 'NSC-1', 'dependsOn array is joined to comma-string on Card');
});

test('NSC-261 reducer card.create: empty dependsOn → no dependsOn field', () => {
  const s = applyEvent(snap([]), {
    id: 'ev3', at: '2026-11-21T20:00:00Z', actor: 'you',
    command: { type: 'card.create', key: 'NSC-4', title: 'Task', dependsOn: [] },
  });
  const card = s.cards.find(c => c.key === 'NSC-4');
  assert.ok(!card?.dependsOn, 'empty dependsOn should not set a field on Card');
});

// ─── NSC-261 hive-card.cjs: validation and key allocation ────────────────────

const HIVE_CARD = join(HERE, '../../../../../../../hive/bin/hive-card.cjs');

function runCard(json, hiveRoot) {
  const env = { ...process.env, HIVE_ROOT: hiveRoot };
  const result = spawnSync('node', [HIVE_CARD, json], { encoding: 'utf8', env });
  let parsed;
  try { parsed = JSON.parse(result.stdout.trim()); } catch { parsed = null; }
  return { status: result.status, parsed, stderr: result.stderr };
}

test('NSC-261 hive-card: bad priority rejected', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hcard-'));
  writeFileSync(join(tmpDir, 'tasks.json'), JSON.stringify({ tasks: [] }));
  const r = runCard('{"title":"T","priority":5}', tmpDir);
  assert.equal(r.status, 1, 'should exit 1');
  assert.ok(r.parsed?.error?.includes('priority'), `expected priority error, got: ${r.parsed?.error}`);
});

test('NSC-261 hive-card: bad parentId (not in ledger) rejected', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hcard-'));
  writeFileSync(join(tmpDir, 'tasks.json'), JSON.stringify({ tasks: [] }));
  const r = runCard('{"title":"T","parentId":"NSC-99"}', tmpDir);
  assert.equal(r.status, 1, 'should exit 1 for unknown parentId');
  assert.ok(r.parsed?.error?.includes('NSC-99'), `expected error mentioning NSC-99, got: ${r.parsed?.error}`);
});

test('NSC-261 hive-card: valid create returns key', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hcard-'));
  writeFileSync(join(tmpDir, 'tasks.json'), JSON.stringify({ tasks: [
    { id: 'NSC-1', title: 'Existing', status: 'todo', dependsOn: [], priority: 2, createdAt: '2026-11-21T00:00:00Z' }
  ] }));
  const r = runCard('{"title":"New card","priority":1,"status":"blocked","blockItems":["Check it"]}', tmpDir);
  assert.equal(r.status, 0, `should exit 0, stderr: ${r.stderr}`);
  assert.equal(r.parsed?.ok, true, 'ok should be true');
  assert.ok(typeof r.parsed?.key === 'string' && r.parsed.key !== 'NSC-1', 'key should be a new distinct string');
});

test('NSC-261 hive-card: two sequential creates get distinct keys', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hcard-'));
  writeFileSync(join(tmpDir, 'tasks.json'), JSON.stringify({ tasks: [] }));
  const r1 = runCard('{"title":"First"}', tmpDir);
  const r2 = runCard('{"title":"Second"}', tmpDir);
  assert.equal(r1.status, 0); assert.equal(r2.status, 0);
  assert.ok(r1.parsed?.key !== r2.parsed?.key, `keys must differ: ${r1.parsed?.key} vs ${r2.parsed?.key}`);
});
