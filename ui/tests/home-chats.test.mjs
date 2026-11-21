import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Compile the provider (and projection.ts through it), as electron-provider.test.mjs does.
const outputDir = mkdtempSync(join(tmpdir(), 'paramount-home-chats-test-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', 'src/data/electron-api.d.ts', 'src/data/electron-provider.ts',
]);
const emitted = readdirSync(outputDir, { recursive: true }).map(String).filter((n) => n.endsWith('.js'));
for (const f of emitted) {
  const path = join(outputDir, f);
  writeFileSync(path, readFileSync(path, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"));
}
const projectionFile = emitted.find((n) => n.endsWith('projection.js'));
const providerFile = emitted.find((n) => n.endsWith('electron-provider.js'));
const { askOptions, cardAsks, logActivity } = await import(pathToFileURL(join(outputDir, String(projectionFile))).href);
const { createElectronProvider } = await import(pathToFileURL(join(outputDir, String(providerFile))).href);
rmSync(outputDir, { recursive: true });

test('askOptions: two to six bullets or numbers are a decision, anything else is free text', () => {
  assert.deepEqual(askOptions('Ship it?\n- **Merge now**\n- Wait for `wheel`'), ['Merge now', 'Wait for wheel']);
  assert.deepEqual(askOptions('Pick:\n1. A\n2) B\n3. C'), ['A', 'B', 'C']);
  assert.deepEqual(askOptions('Just tell me the token budget.'), []);
  assert.deepEqual(askOptions('- only one'), []);
});

test('cardAsks: routes to the asker, ids round-trip, answered/dismissed/done are not open', () => {
  const tasks = [
    { id: 'T-1', status: 'doing', assignee: 'w1', humanQA: [{ q: 'Q0', from: 'w2', askedAt: '2026-10-15T09:00:00Z' }, { q: 'Q1', a: 'yes', mode: 'decision' }, { q: 'Q2', dismissedAt: '2026-10-15T09:10:00Z' }] },
    { id: 'T-2', status: 'done', humanQA: [{ q: 'old' }] },
  ];
  const asks = cardAsks(tasks, new Set(['w1', 'w2', 'god']), 'god');
  assert.deepEqual(asks.map((m) => [m.id, m.from, m.read]), [['T-1:0', 'w2', false], ['T-1:1', 'w1', true], ['T-1:2', 'w1', true], ['T-2:0', 'god', true]]);
  assert.equal(asks[1].answerMode, 'decision');
  assert.equal(asks[2].dismissed, true);
  assert.equal(asks[0].chatId, 'agent:w2');
});

test('logActivity: only known agents, newest first, unknown kinds dropped', () => {
  const log = [
    { ts: '2026-10-15T09:00:00Z', kind: 'spawn', agentId: 'w1' },
    { ts: '2026-10-15T09:05:00Z', kind: 'message', from: 'w1', to: 'human', subject: 'Need a merge call' },
    { ts: '2026-10-15T09:06:00Z', kind: 'spawn', agentId: 'stranger' },
    { ts: '2026-10-15T09:07:00Z', kind: 'something-new', agentId: 'w1' },
    { ts: 'not a date', kind: 'spawn', agentId: 'w1' },
  ];
  const feed = logActivity(log, new Set(['w1']), (id) => id.toUpperCase());
  assert.deepEqual(feed.map((e) => [e.kind, e.text]), [['message', 'Messaged you: Need a merge call'], ['lifecycle', 'Joined the floor']]);
});

function bridge(native) {
  const sent = [];
  return { sent, paramountSnapshot: async () => native, paramountDispatch: async (command) => { sent.push(command); return { ok: true, event: { id: 'e1', at: '2026-10-15T09:00:00Z', actor: 'you', command } }; },
    paramountSubscribe: () => () => {}, onHiveChanged: () => () => {}, hiveSend: async () => ({ ok: true }), hivePatchTask: async () => true, writePty: async () => true };
}

test('electron provider: activity, open asks, direct questions and saved layouts come from the core', async () => {
  const native = {
    registry: { godId: 'god', agents: { god: { name: 'Ada', role: 'lead' }, w1: { name: 'Bo', role: 'worker' } } },
    tasks: { tasks: [{ id: 'T-1', title: 'Ship', status: 'doing', assignee: 'w1', humanQA: [{ q: 'Merge?\n- Now\n- Later', askedAt: '2026-10-15T09:00:00Z' }] }] },
    messages: [
      { id: 'm1', owner: 'w1', from: 'w1', to: 'human', conversation: 'c1', requires_reply: true, subject: 'Budget?', body: 'How many tokens?', created_at: '2026-10-15T09:01:00Z' },
      { id: 'm2', owner: 'god', from: 'god', to: 'human', conversation: 'c2', requires_reply: true, subject: 'Q', body: 'x', created_at: '2026-10-15T09:01:00Z' },
      { id: 'm3', owner: 'god', from: 'human', to: 'god', conversation: 'c2', subject: 'Re', body: 'answered', created_at: '2026-10-15T09:02:00Z' },
    ],
    roster: { agents: [] }, ptys: [], config: {}, missions: [],
    log: [{ ts: '2026-10-15T09:03:00Z', kind: 'pty-submit', agentId: 'w1', source: 'queue' }],
    preferences: { home: { density: 'compact', tiles: { wins: { hidden: true } } }, chats: { hideUpdates: true } },
  };
  globalThis.window = { cth: bridge(native) };
  try {
    const snapshot = await createElectronProvider().snapshot();
    assert.deepEqual(snapshot.activity.map((e) => [e.agentId, e.text]), [['w1', 'Picked up its next message']]);
    assert.deepEqual(snapshot.homeLayout, { density: 'compact', tiles: { wins: { hidden: true } } });
    assert.equal(snapshot.chatView.hideUpdates, true);
    const card = snapshot.messages.find((m) => m.id === 'T-1:0');
    assert.deepEqual(card.options, ['Now', 'Later']);
    const open = snapshot.messages.find((m) => m.id === 'm1');
    assert.equal(open.kind, 'question');
    const answered = snapshot.messages.find((m) => m.id === 'm2');
    assert.equal(answered.answer, 'answered');
    assert.deepEqual(snapshot.notifications.map((n) => n.id).sort(), ['T-1:0', 'm1']);
  } finally {
    delete globalThis.window;
  }
});
