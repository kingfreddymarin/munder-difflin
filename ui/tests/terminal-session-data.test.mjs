import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// session-data.ts only imports types, so it compiles to one self-contained module.
const outputDir = mkdtempSync(join(tmpdir(), 'paramount-session-data-test-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', 'src/components/app/terminal/session-data.ts',
]);
const file = readdirSync(outputDir, { recursive: true }).find((name) => String(name).endsWith('session-data.js'));
const { openAsks, agentTalk, groupArtifacts } = await import(pathToFileURL(join(outputDir, String(file))).href);

const msg = (over) => ({ id: 'x', chatId: 'c', from: 'cl', at: '2026-10-15T10:00:00Z', kind: 'text', text: 't', ...over });

test('openAsks keeps only this agent\'s unanswered questions and approvals, newest first', () => {
  const asks = openAsks([
    msg({ id: 'old', kind: 'question', at: '2026-10-15T09:00:00Z' }),
    msg({ id: 'new', kind: 'approval', at: '2026-10-15T11:00:00Z' }),
    msg({ id: 'read', kind: 'question', read: true }),
    msg({ id: 'answered', kind: 'question', answer: 'yes' }),
    msg({ id: 'other', kind: 'question', from: 'pw' }),
    msg({ id: 'plain', kind: 'text' }),
  ], 'cl');
  assert.deepEqual(asks.map((m) => m.id), ['new', 'old']);
});

test('agentTalk keeps agent-to-agent messages, dedupes inbox/outbox copies, scopes to one agent', () => {
  const ids = new Set(['cl', 'pw', 'pm']);
  const all = [
    msg({ id: 'a', from: 'pm', to: 'cl', at: '2026-10-15T09:00:00Z' }),
    msg({ id: 'a', from: 'pm', to: 'cl', at: '2026-10-15T09:00:00Z' }),
    msg({ id: 'b', from: 'cl', to: 'pw', at: '2026-10-15T10:00:00Z' }),
    msg({ id: 'c', from: 'pw', to: 'pm', at: '2026-10-15T11:00:00Z' }),
    msg({ id: 'human', from: 'you', to: 'cl' }),
    msg({ id: 'no-to', from: 'cl' }),
    msg({ id: 'outsider', from: 'cl', to: 'telegram' }),
  ];
  assert.deepEqual(agentTalk(all, ids).map((m) => m.id), ['c', 'b', 'a']);
  assert.deepEqual(agentTalk(all, ids, 'cl').map((m) => m.id), ['b', 'a']);
});

test('groupArtifacts orders groups, merges commits with committed files, drops empty groups', () => {
  const groups = groupArtifacts([
    { kind: 'link', label: 'pr', url: 'https://github.com/x/y/pull/1' },
    { kind: 'committed', label: 'a.ts' },
    { kind: 'changed', label: 'b.ts', status: 'M' },
    { kind: 'commit', label: 'msg', commit: 'abc' },
  ]);
  assert.deepEqual(groups.map((g) => g.id), ['changed', 'commits', 'links']);
  assert.deepEqual(groups[1].items.map((a) => a.label), ['a.ts', 'msg']);
  assert.deepEqual(groupArtifacts([]), []);
});
