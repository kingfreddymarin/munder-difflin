import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// card-tree.ts has only type imports, so it compiles on its own.
const outputDir = mkdtempSync(join(tmpdir(), 'paramount-card-tree-test-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', 'src/data/card-tree.ts',
]);
const { childRollup, childrenOf, inFamily, isUnder, parentCandidates } = await import(pathToFileURL(join(outputDir, 'card-tree.js')).href);
rmSync(outputDir, { recursive: true });

const card = (key, extra = {}) => ({ key, title: key, status: 'todo', tags: [], refs: [], plan: [], ...extra });
const cards = [
  card('EPIC'),
  card('A', { parentId: 'EPIC', status: 'done' }),
  card('B', { parentId: 'EPIC', status: 'done' }),
  card('C', { parentId: 'EPIC', status: 'doing' }),
  card('D', { parentId: 'EPIC' }),
  card('E', { parentId: 'EPIC', status: 'blocked' }),
  card('GONE', { parentId: 'EPIC', status: 'done', boardArchivedAt: '2026-11-01T00:00:00.000Z' }),
  card('A1', { parentId: 'A' }),
  card('LONE'),
];

test('rollup counts done children on the Board and skips archived ones', () => {
  assert.deepEqual(childRollup(cards, 'EPIC'), { done: 2, total: 5 });
  assert.deepEqual(childRollup(cards, 'A'), { done: 0, total: 1 });
  assert.equal(childRollup(cards, 'LONE'), null);
  assert.deepEqual(childrenOf(cards, 'EPIC').map((c) => c.key), ['A', 'B', 'C', 'D', 'E']);
});

test('parent candidates leave out the card itself, its descendants and archived cards', () => {
  assert.deepEqual(parentCandidates(cards, cards[0]).map((c) => c.key), ['LONE']);
  assert.deepEqual(parentCandidates(cards, cards[1]).map((c) => c.key), ['EPIC', 'B', 'C', 'D', 'E', 'LONE']);
  assert.equal(isUnder(cards, 'A1', 'EPIC'), true);
  assert.equal(isUnder(cards, 'EPIC', 'A1'), false);
});

test('isUnder stops on a cycle already in the data', () => {
  const loop = [card('X', { parentId: 'Y' }), card('Y', { parentId: 'X' })];
  assert.equal(isUnder(loop, 'X', 'Z'), false);
  assert.equal(isUnder(loop, 'X', 'Y'), true);
});

test('the parent filter keeps the parent and its direct children', () => {
  assert.deepEqual(cards.filter((c) => inFamily(c, ['EPIC'])).map((c) => c.key), ['EPIC', 'A', 'B', 'C', 'D', 'E', 'GONE']);
  assert.deepEqual(cards.filter((c) => inFamily(c, ['A', 'LONE'])).map((c) => c.key), ['A', 'A1', 'LONE']);
});
