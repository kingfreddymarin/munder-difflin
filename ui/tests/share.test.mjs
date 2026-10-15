import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const outputDir = mkdtempSync(join(tmpdir(), 'paramount-share-test-'));
execFileSync('node_modules/.bin/tsc', ['--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--skipLibCheck', 'src/data/share.ts']);
const { share } = await import(pathToFileURL(join(outputDir, 'share.js')).href);
rmSync(outputDir, { recursive: true });

const floor = () => ({ agents: [{ id: 'a', name: 'Ada', tags: ['x'] }, { id: 'b', name: 'Bo', tags: [] }], cards: [{ key: 'T-1', status: 'doing' }], me: { yolo: { on: false } } });

test('an identical refresh returns the previous snapshot itself', () => {
  const prev = floor();
  assert.equal(share(prev, floor()), prev);
});

test('only the changed branch is new; untouched slices and items keep their reference', () => {
  const prev = floor();
  const next = floor();
  next.agents[1].name = 'Bea';
  const out = share(prev, next);
  assert.notEqual(out, prev);
  assert.notEqual(out.agents, prev.agents);
  assert.equal(out.agents[0], prev.agents[0]);
  assert.notEqual(out.agents[1], prev.agents[1]);
  assert.equal(out.agents[1].tags, prev.agents[1].tags);
  assert.equal(out.cards, prev.cards);
  assert.equal(out.me, prev.me);
  assert.deepEqual(out, next);
});

test('added, removed and renamed keys and items are changes', () => {
  const prev = { a: 1, b: undefined, list: [1, 2] };
  assert.notEqual(share(prev, { a: 1, c: undefined, list: [1, 2] }), prev);
  assert.notEqual(share(prev, { a: 1, b: undefined, list: [1] }).list, prev.list);
  assert.notEqual(share(prev, { a: 1, b: undefined, list: [1, 2, 3] }).list, prev.list);
});
