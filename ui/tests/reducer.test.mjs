import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// reducer.ts has only type imports, so it compiles on its own.
const outputDir = mkdtempSync(join(tmpdir(), 'paramount-reducer-test-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', 'src/data/reducer.ts',
]);
const { applyEvent } = await import(pathToFileURL(join(outputDir, 'reducer.js')).href);
rmSync(outputDir, { recursive: true });

test('a core event for a command the UI does not model (diagnostics.save) keeps the snapshot', () => {
  // Found by the packaged-app smoke: after Export diagnostics saved a file, the core's
  // diagnostics.save event made applyEvent return undefined and the app showed "Connecting to the floor…".
  const snapshot = { agents: [], chats: [], messages: [], audit: [], notifications: [] };
  const event = { id: 'e1', at: '2026-10-15T19:43:19.343Z', actor: 'you', command: { type: 'diagnostics.save', name: 'x.json' } };
  assert.equal(applyEvent(snapshot, event), snapshot);
});

test('setup.complete marks the floor set up at the chosen folder and audits it', () => {
  const snapshot = { agents: [], chats: [], messages: [], audit: [], notifications: [],
    floorSetup: { complete: false, harnessHome: null, suggestedHome: '/a', engines: [] } };
  const event = { id: 'e2', at: '2026-11-12T09:00:00.000Z', actor: 'you', command: { type: 'setup.complete', home: '/floor', engine: 'claude', model: 'claude-opus-5-5' } };
  const next = applyEvent(snapshot, event);
  assert.equal(next.floorSetup.complete, true);
  assert.equal(next.floorSetup.harnessHome, '/floor');
  assert.equal(next.audit.length, 1);
});

// NSC-231: card.update reducer tests ----------------------------------------

const baseCard = { key: 'NSC-99', title: 'Old title', status: 'todo', priority: 'P2', agentId: 'agent-a',
  created: '2026-01-01T00:00:00.000Z', createdBy: 'you', updated: '2026-01-01T00:00:00.000Z',
  description: '', plan: [], doneMeans: [], tags: [], refs: [], tokens: 0, origin: 'you', people: [] };
const baseSnap = (extra = {}) => ({ agents: [], chats: [], messages: [], audit: [], notifications: [], cards: [{ ...baseCard, ...extra }] });
const ev = (command, at = '2026-11-21T10:00:00.000Z') => ({ id: 'ev1', at, actor: 'you', command });

test('card.update title patch renames the card and stamps updated', () => {
  const next = applyEvent(baseSnap(), ev({ type: 'card.update', key: 'NSC-99', patch: { title: 'New title' } }));
  assert.equal(next.cards[0].title, 'New title');
  assert.equal(next.cards[0].updated, '2026-11-21T10:00:00.000Z');
});

test('card.update description patch fills a missing field', () => {
  const next = applyEvent(baseSnap(), ev({ type: 'card.update', key: 'NSC-99', patch: { description: 'Now has a description.' } }));
  assert.equal(next.cards[0].description, 'Now has a description.');
});

test('card.update priority maps 1→P1, 2→P2, 3→P3 correctly', () => {
  for (const [num, str] of [[1, 'P1'], [2, 'P2'], [3, 'P3']]) {
    const next = applyEvent(baseSnap(), ev({ type: 'card.update', key: 'NSC-99', patch: { priority: num } }));
    assert.equal(next.cards[0].priority, str, `priority ${num} → ${str}`);
  }
});

test('card.update assignee patch changes agentId', () => {
  const next = applyEvent(baseSnap(), ev({ type: 'card.update', key: 'NSC-99', patch: { assignee: 'agent-b' } }));
  assert.equal(next.cards[0].agentId, 'agent-b');
});

test('card.update on unknown key is a no-op', () => {
  const snap = baseSnap();
  const next = applyEvent(snap, ev({ type: 'card.update', key: 'NSC-00', patch: { title: 'Ghost' } }));
  assert.equal(next, snap);
});

test('card.update creates an audit entry with the patched card as target', () => {
  const next = applyEvent(baseSnap(), ev({ type: 'card.update', key: 'NSC-99', patch: { title: 'New title' } }));
  assert.equal(next.audit.length, 1);
  assert.equal(next.audit[0].target, 'NSC-99');
  assert.equal(next.audit[0].action, 'Updated card');
});

test('card.update empty patch leaves fields unchanged but stamps updated', () => {
  const snap = baseSnap();
  const next = applyEvent(snap, ev({ type: 'card.update', key: 'NSC-99', patch: {} }));
  assert.equal(next.cards[0].title, 'Old title');
  assert.equal(next.cards[0].updated, '2026-11-21T10:00:00.000Z');
});

test('card.archive retains the card, status and update time in the snapshot', () => {
  for (const status of ['todo', 'doing', 'blocked', 'done']) {
    const snap = baseSnap({ status });
    const event = ev({ type: 'card.archive', key: 'NSC-99' });
    const next = applyEvent(snap, event);
    assert.deepEqual(next.cards, [{ ...snap.cards[0], boardArchivedAt: event.at }]);
    assert.equal(applyEvent(next, { ...event, at: '2026-11-22T10:00:00.000Z' }), next);
  }
});

// NSC-244: parent/child cards ------------------------------------------------

const familySnap = () => ({ agents: [], chats: [], messages: [], audit: [], notifications: [], cards: [
  { ...baseCard, key: 'NSC-1' }, { ...baseCard, key: 'NSC-2', parentId: 'NSC-1' }, { ...baseCard, key: 'NSC-3', parentId: 'NSC-2' }, { ...baseCard, key: 'NSC-4' },
] });

test('card.update sets and clears a parent', () => {
  const set = applyEvent(familySnap(), ev({ type: 'card.update', key: 'NSC-4', patch: { parentId: 'NSC-1' } }));
  assert.equal(set.cards[3].parentId, 'NSC-1');
  const cleared = applyEvent(set, ev({ type: 'card.update', key: 'NSC-2', patch: { parentId: '' } }));
  assert.equal(cleared.cards[1].parentId, undefined);
});

test('card.update ignores a missing parent, a self parent and a cycle', () => {
  for (const [key, parentId] of [['NSC-4', 'NSC-404'], ['NSC-4', 'NSC-4'], ['NSC-1', 'NSC-3'], ['NSC-1', 'NSC-2']]) {
    const snap = familySnap();
    assert.equal(applyEvent(snap, ev({ type: 'card.update', key, patch: { parentId } })), snap, `${key} → ${parentId}`);
  }
});
