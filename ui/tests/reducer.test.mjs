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
