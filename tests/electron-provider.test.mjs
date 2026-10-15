import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const outputDir = mkdtempSync(join(tmpdir(), 'paramount-provider-test-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', 'src/data/electron-api.d.ts', 'src/data/electron-provider.ts',
]);
const compiled = readFileSync(join(outputDir, 'electron-provider.js'));
rmSync(outputDir, { recursive: true });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { createElectronProvider } = await import(moduleUrl);

function nativeSnapshot() {
  return {
    registry: { godId: 'god', agents: { god: { name: 'Ada', role: 'lead', status: 'working' } } },
    tasks: { tasks: [{ id: 'T-1', title: 'Ship a build', status: 'doing', priority: 1, assignee: 'god',
      humanQA: [{ q: 'Publish now?' }] }] },
    messages: [], roster: { agents: [{ id: 'god', name: 'Ada', ptyId: 'session-42' }] },
    ptys: [{ id: 'session-42', cwd: '/work' }], config: { notifications: true }, missions: [], preferences: {},
  };
}

function bridge(snapshot = nativeSnapshot()) {
  const sent = [];
  let notify = () => {};
  return {
    sent,
    paramountSnapshot: async () => snapshot,
    paramountDispatch: async () => ({ ok: false, error: 'Unsupported command' }),
    onParamountEvent: (listener) => { notify = listener; return () => { notify = () => {}; }; },
    emit: (event) => notify(event),
    hiveSend: async (message, from) => { sent.push({ message, from }); return { ok: true }; },
    hivePatchTask: async () => ({ ok: true }),
    writePty: async () => ({ ok: true }),
  };
}

test('projects live agents, tasks, questions and PTYs without mock fixtures', async () => {
  globalThis.window = { cth: bridge() };
  const snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.agents[0].name, 'Ada');
  assert.equal(snapshot.cards[0].key, 'T-1');
  assert.equal(snapshot.notifications[0].messageId, 'T-1:0');
  assert.equal(snapshot.terminals[0].ptyId, 'session-42');
  assert.equal(snapshot.agents.length, 1);
});

test('rejects a malformed core response instead of showing fake data', async () => {
  globalThis.window = { cth: bridge({ agents: [] }) };
  await assert.rejects(createElectronProvider().snapshot(), /incomplete snapshot/);
});

test('sends chat to the selected real agent and surfaces command failures', async () => {
  const api = bridge();
  globalThis.window = { cth: api };
  const provider = createElectronProvider();
  await provider.snapshot();
  await provider.dispatch({ type: 'chat.send', chatId: 'agent:god', text: 'Status?' });
  assert.equal(api.sent[0].message.to, 'god');
  assert.equal(api.sent[0].message.body, 'Status?');
  await assert.rejects(provider.dispatch({ type: 'floor.yolo', patch: { on: true } }), /Unsupported command/);
});

test('push invalidation triggers a fresh snapshot request', async () => {
  const api = bridge();
  globalThis.window = { cth: api };
  const provider = createElectronProvider();
  let count = 0;
  const off = provider.onRefresh(() => count++);
  api.emit({ kind: 'invalidate', source: 'hive', at: new Date().toISOString() });
  assert.equal(count, 1);
  off();
  api.emit({ kind: 'invalidate', source: 'hive', at: new Date().toISOString() });
  assert.equal(count, 1);
});
