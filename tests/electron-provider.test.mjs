import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Compile the provider and its relative imports, then add the `.js` extension Node's ESM loader needs.
const outputDir = mkdtempSync(join(tmpdir(), 'paramount-provider-test-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', 'src/data/electron-api.d.ts', 'src/data/electron-provider.ts',
]);
for (const file of readdirSync(outputDir).filter((name) => name.endsWith('.js'))) {
  const path = join(outputDir, file);
  writeFileSync(path, readFileSync(path, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"));
}
const { createElectronProvider } = await import(pathToFileURL(join(outputDir, 'electron-provider.js')).href);
const { BackendError, toBackendError } = await import(pathToFileURL(join(outputDir, 'errors.js')).href);
rmSync(outputDir, { recursive: true });

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
    paramountDispatch: async (command) => command.type === 'diagnostics.bundle'
      ? { ok: true, event: { id: 'e1', at: '', actor: 'you', command }, diagnostics: { generatedAt: 'now', correlationId: 'c1', app: {}, os: {}, config: {}, logTail: [], crashes: [], errors: [] } }
      : command.type === 'agents.discover'
      ? { ok: true, event: { id: 'e2', at: '', actor: 'you', command }, discovery: { agents: [{ source: 'claude', id: 'rev', name: 'Reviewer', description: '', instructionsPath: 'x', origin: 'user', warnings: [] }], warnings: [], roots: { claude: [], codex: [], munder: [] } } }
      : command.type === 'agents.import' && command.id === 'rev'
      ? { ok: true, event: { id: 'e3', at: '', actor: 'you', command }, imported: { agent: { id: 'rev' }, manifest: {}, adjustments: [] } }
      : command.type === 'agents.import'
      ? { ok: false, errorId: 'err-404', code: 'NOT_FOUND', message: 'No such agent', error: 'No such agent', correlationId: 'c8' }
      : { ok: false, errorId: 'err-7', code: 'UNSUPPORTED', message: 'Unsupported command', error: 'Unsupported command', correlationId: 'c7' },
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

test('core failures keep their errorId and code', async () => {
  const api = bridge();
  globalThis.window = { cth: api };
  const provider = createElectronProvider();
  const failure = await provider.dispatch({ type: 'floor.yolo', patch: { on: true } }).catch((error) => error);
  assert.ok(failure instanceof BackendError);
  assert.deepEqual([failure.errorId, failure.code, failure.operation], ['err-7', 'UNSUPPORTED', 'floor.yolo']);
});

test('a missing bridge is DISCONNECTED with a ui- errorId', async () => {
  globalThis.window = {};
  const failure = await createElectronProvider().snapshot().catch((error) => error);
  assert.equal(failure.code, 'DISCONNECTED');
  assert.match(failure.errorId, /^ui-/);
});

test('prefers window.paramount and parses rejected snapshots', async () => {
  const api = bridge();
  api.paramountSnapshot = async () => { throw new Error("Error invoking remote method 'x': Error: [err-9] INTERNAL: disk full"); };
  globalThis.window = { paramount: api, cth: bridge() };
  const failure = await createElectronProvider().snapshot().catch((error) => error);
  assert.deepEqual([failure.errorId, failure.code, failure.message], ['err-9', 'INTERNAL', 'disk full']);
  assert.equal(toBackendError('plain').code, 'INTERNAL');
});

test('diagnostics calls diagnostics.bundle', async () => {
  globalThis.window = { cth: bridge() };
  const bundle = await createElectronProvider().diagnostics();
  assert.equal(bundle.correlationId, 'c1');
});

test('agents.discover and agents.import return their payloads and keep core errorIds', async () => {
  globalThis.window = { cth: bridge() };
  const provider = createElectronProvider();
  const discovery = await provider.discoverAgents({ sources: ['claude'] });
  assert.equal(discovery.agents[0].id, 'rev');
  const imported = await provider.importAgent('claude', 'rev');
  assert.equal(imported.agent.id, 'rev');
  const failure = await provider.importAgent('claude', 'nope').catch((error) => error);
  assert.deepEqual([failure.errorId, failure.code, failure.operation], ['err-404', 'NOT_FOUND', 'agents.import']);
});

test('a result without its payload is an INTERNAL error, not undefined', async () => {
  const api = bridge();
  api.paramountDispatch = async (command) => ({ ok: true, event: { id: 'e', at: '', actor: 'you', command } });
  globalThis.window = { cth: api };
  const failure = await createElectronProvider().discoverAgents().catch((error) => error);
  assert.deepEqual([failure.code, failure.operation], ['INTERNAL', 'agents.discover']);
});
