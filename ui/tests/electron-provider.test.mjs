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

test('projects live token detail, configured caps, cost and breaker with safe units', async () => {
  const native = nativeSnapshot();
  native.config = { costCapTokens: 4_000_000, costCapUsd: 12, agentTokenCaps: { god: 2_000_000 }, circuitBreaker: { enabled: true } };
  native.activity = { god: { busy: true, doing: 'Read', tokens: 1_250_000, inputTokens: 500_000,
    outputTokens: 250_000, cacheReadTokens: 400_000, cacheCreationTokens: 100_000,
    contextPct: 42, costUsd: 0.37, breaker: 'constrained' } };
  globalThis.window = { cth: bridge(native) };
  const snapshot = await createElectronProvider().snapshot();
  const agent = snapshot.agents[0];
  assert.equal(agent.tokensUsed, 1.25);
  assert.equal(agent.tokensReported, true);
  assert.equal(agent.tokensCap, 2);
  assert.equal(agent.tokensIn, 0.5);
  assert.equal(agent.tokensOut, 0.25);
  assert.equal(agent.tokensCached, 0.5);
  assert.equal(agent.contextPct, 42);
  assert.equal(agent.costUsd, 0.37);
  assert.equal(agent.breaker, 'constrained');
  assert.equal(agent.status, 'constrained');
  assert.equal(snapshot.settings.costCapTokens, 4_000_000);
  assert.equal(snapshot.settings.costCapUsd, 12);
});

test('keeps floor and per-agent budgets distinct and preserves unknown telemetry', async () => {
  const native = nativeSnapshot();
  native.config = { costCapTokens: 3_000_000, agentTokenCaps: { god: -5 } };
  native.activity = { god: { tokens: 'bad', inputTokens: NaN, contextPct: null, costUsd: Infinity, breaker: 'healthy' } };
  globalThis.window = { cth: bridge(native) };
  const agent = (await createElectronProvider().snapshot()).agents[0];
  assert.equal(agent.tokensUsed, 0);
  assert.equal(agent.tokensReported, false);
  assert.equal(agent.tokensCap, 0);
  assert.equal((await createElectronProvider().snapshot()).settings.costCapTokens, 3_000_000);
  assert.equal(agent.tokensIn, 0);
  assert.equal(agent.contextPct, null);
  assert.equal(agent.costUsd, null);
  assert.equal(agent.breaker, 'healthy');
});

test('existing-agent preset save reaches the actual Paramount preload bridge and preserves outcomes', async () => {
  const native = bridge();
  const seen = [];
  native.paramountSaveHirePreset = async (manifest) => {
    seen.push(manifest);
    return { canceled: false, path: '/tmp/review-worker.json' };
  };
  globalThis.window = { cth: native };
  const manifest = { spec: 'munder-difflin/hire@1', name: 'Review Worker', provider: 'claude' };
  const saved = await createElectronProvider().saveAgentPreset(manifest);
  assert.deepEqual(seen, [manifest]);
  assert.deepEqual(saved, { canceled: false, path: '/tmp/review-worker.json' });
  native.paramountSaveHirePreset = async () => ({ canceled: true });
  assert.deepEqual(await createElectronProvider().saveAgentPreset(manifest), { canceled: true });
  native.paramountSaveHirePreset = async () => ({ canceled: false, error: 'Could not save the agent preset.' });
  assert.deepEqual(await createElectronProvider().saveAgentPreset(manifest), { canceled: false, error: 'Could not save the agent preset.' });
});

test('rejects a malformed core response instead of showing fake data', async () => {
  globalThis.window = { cth: bridge({ agents: [] }) };
  await assert.rejects(createElectronProvider().snapshot(), /incomplete snapshot/);
});

test('main-process hires expose live terminals without a legacy renderer roster', async () => {
  const native = nativeSnapshot();
  native.roster = null;
  native.ptys[0].agentId = 'god';
  globalThis.window = { cth: bridge(native) };
  const snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.terminals.length, 1);
  assert.equal(snapshot.terminals[0].agentId, 'god');
  assert.equal(snapshot.terminals[0].ptyId, 'session-42');
  assert.equal(snapshot.terminals[0].cwd, '/work');
  native.ptys = [];
  assert.equal((await createElectronProvider().snapshot()).terminals.length, 0);
});

test('verbose heartbeat is a brief system update with original details available in Terminal', async () => {
  const native = nativeSnapshot();
  const body = 'Floor heartbeat — 1 actionable inbox message(s) awaiting you (worker/human mail). Drain your inbox NOW and act on them.\nActive agents (0): —.\nNo undrained inboxes.\nBoard (head):\n# Hive board\nRecent log:\n{"kind":"paramount-op","phase":"end"}';
  native.messages = [{ id: 'beat-1', owner: 'god', from: 'heartbeat', to: 'god', subject: 'Heartbeat', body, created_at: '2026-10-29T10:00:00Z' }];
  globalThis.window = { cth: bridge(native) };
  const snapshot = await createElectronProvider().snapshot();
  const message = snapshot.messages.find((m) => m.id === 'beat-1');
  assert.equal(message.kind, 'system');
  assert.equal(message.text, 'Heartbeat · 1 message waiting.');
  assert.equal(message.terminalAgentId, 'god');
  assert.equal(message.details, body);
  assert.ok(message.text.length < 80);
  assert.doesNotMatch(message.text, /paramount-op|Board|Drain/);
});

test('new heartbeat summaries preserve counts and do not rewrite human conversation', async () => {
  const native = nativeSnapshot();
  native.messages = [
    { id: 'beat-new', owner: 'god', from: 'heartbeat', to: 'god', subject: 'Heartbeat', body: 'Heartbeat: 3 messages waiting. Read your inbox and handle them.\nDetails: $AGENT_DIR/inbox', created_at: '2026-10-29T10:00:00Z' },
    { id: 'human', owner: 'god', from: 'human', to: 'god', subject: 'Heartbeat', body: 'Please explain the heartbeat log.', created_at: '2026-10-29T10:01:00Z' },
    { id: 'human-text', owner: 'god', from: 'human', to: 'god', subject: 'Message from human', body: 'Keep it short, please.', created_at: '2026-10-29T10:02:00Z' },
  ];
  globalThis.window = { cth: bridge(native) };
  const snapshot = await createElectronProvider().snapshot();
  const beat = snapshot.messages.find((m) => m.id === 'beat-new');
  assert.equal(beat.text, 'Heartbeat · 3 messages waiting.');
  const human = snapshot.messages.find((m) => m.id === 'human');
  assert.equal(human.kind, 'text');
  assert.match(human.text, /Please explain the heartbeat log\./);
  assert.equal(human.details, undefined);
  assert.equal(snapshot.messages.find((m) => m.id === 'human-text').text, 'Keep it short, please.');
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

test('maps card tags, workspace, dir and refs from the hive task and keeps the saved column order', async () => {
  const native = nativeSnapshot();
  Object.assign(native.tasks.tasks[0], {
    tags: ['compute', ' compute ', '', 7], workspace: 'Varium', dir: '/work/repo',
    refs: [
      { kind: 'pr', system: 'ado', id: '23572', url: 'https://dev.azure.com/o/p/_git/r/pullrequest/23572' },
      { kind: 'build', system: 'ado', id: '61204', url: 'http://insecure.example/61204' },
      { kind: 'file', system: 'ado', id: 'x', url: 'https://dev.azure.com/x' },
    ],
  });
  native.preferences = { board: { columns: ['done', 'doing', 'nope', 'done'] } };
  globalThis.window = { cth: bridge(native) };
  const snapshot = await createElectronProvider().snapshot();
  const card = snapshot.cards[0];
  assert.deepEqual(card.tags, ['compute']);
  assert.equal(card.workspace, 'Varium');
  assert.equal(card.dir, '/work/repo');
  assert.deepEqual(card.refs.map((ref) => ref.id), ['23572']);
  assert.deepEqual(snapshot.board.columns, ['done', 'doing', 'todo', 'blocked']);
});

test('openExternal and openIn send shell commands and keep the core errorId on a refusal', async () => {
  const api = bridge();
  const seen = [];
  api.paramountDispatch = async (command) => {
    seen.push(command);
    if (command.type === 'shell.openExternal' && !command.url.startsWith('https://github.com/'))
      return { ok: false, errorId: 'err-host', code: 'INVALID_INPUT', message: 'example.com is not an allowed host', error: 'x', correlationId: 'c9' };
    return { ok: true, event: { id: 'e', at: '', actor: 'you', command } };
  };
  globalThis.window = { cth: api };
  const provider = createElectronProvider();
  await provider.openExternal('https://github.com/org/repo/pull/1');
  await provider.openIn('vscode', '/work');
  assert.deepEqual(seen, [{ type: 'shell.openExternal', url: 'https://github.com/org/repo/pull/1' }, { type: 'shell.openIn', app: 'vscode', path: '/work' }]);
  const failure = await provider.openExternal('https://example.com').catch((error) => error);
  assert.deepEqual([failure.errorId, failure.code, failure.operation], ['err-host', 'INVALID_INPUT', 'shell.openExternal']);
});

test('openIn with no bridge is DISCONNECTED, not a silent no-op', async () => {
  globalThis.window = {};
  const failure = await createElectronProvider().openIn('warp', '/work').catch((error) => error);
  assert.equal(failure.code, 'DISCONNECTED');
});

test('agent.update: one field per command, only fields the core stores (name, tokensCap, model)', () => {
  globalThis.window = { cth: bridge() };
  const { unsupported } = createElectronProvider();
  const update = (patch) => unsupported({ type: 'agent.update', agentId: 'god', patch });
  assert.equal(update({ model: 'claude-opus-4-8' }), null);
  assert.equal(update({ name: 'Ada' }), null);
  assert.equal(update({ tokensCap: 2 }), null);
  assert.match(update({ color: 'sky' }), /color/);
  assert.match(update({ name: 'Ada', tokensCap: 2 }), /one agent field/);
});

test('team.models and agent.hire send the team commands and return their payloads', async () => {
  const api = bridge();
  const seen = [];
  const plan = { agentId: 'rev', name: 'Rev', engine: 'claude', cwd: '/w', isolate: false, command: 'claude', engineInstalled: true, confirmed: false, consentRequired: [], ignored: [] };
  api.paramountDispatch = async (command) => {
    seen.push(command);
    const event = { id: 'e', at: '', actor: 'you', command };
    if (command.type === 'team.models') return { ok: true, event, models: { engines: [{ id: 'claude', label: 'Claude', models: [{ id: 'm1', label: 'M1' }] }], defaultModel: 'm1', agents: { god: { engine: 'claude', model: 'm1' } } } };
    if (command.type === 'agent.hire') return command.manifest.name ? { ok: true, event, hire: plan } : { ok: false, errorId: 'err-h', code: 'INVALID_INPUT', message: 'name required', error: 'name required', correlationId: 'c' };
    return { ok: false, errorId: 'x', code: 'UNSUPPORTED', message: 'no', error: 'no', correlationId: 'c' };
  };
  globalThis.window = { cth: api };
  const provider = createElectronProvider();
  const models = await provider.teamModels();
  assert.equal(models.agents.god.model, 'm1');
  assert.deepEqual(await provider.hire({ spec: 'munder-difflin/hire@1', name: 'Rev' }, { cwd: '/w' }), plan);
  assert.deepEqual(seen[1], { type: 'agent.hire', manifest: { spec: 'munder-difflin/hire@1', name: 'Rev' }, cwd: '/w' });
  const failure = await provider.hire({ spec: 'munder-difflin/hire@1' }).catch((error) => error);
  assert.deepEqual([failure.errorId, failure.code, failure.operation], ['err-h', 'INVALID_INPUT', 'agent.hire']);
});

test('projects prerequisite and health evidence instead of invented ready state or empty logs', async () => {
  const native = nativeSnapshot();
  native.prereqs = { skid: { id: 'skid', label: 'Skidbladnir', installed: true, running: false, command: 'skid doctor' } };
  native.preferences = { setup: { dismissed: false } };
  native.log = [
    { ts: '2026-10-15T09:00:00Z', kind: 'drop', reason: 'no-inbox', agentId: 'god' },
    { ts: '2026-10-15T09:01:00Z', kind: 'paramount-error', code: 'INTERNAL', errorId: 'err-1' },
  ];
  globalThis.window = { cth: bridge(native) };
  const snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.setupDismissed, false);
  assert.equal(snapshot.prerequisites[0].state, 'installed-not-running');
  assert.equal(snapshot.prerequisites[0].level, 'optional');
  assert.equal(snapshot.services.find((service) => service.id === 'skid')?.state, 'warn');
  assert.equal(snapshot.log.length, 2);
  assert.equal(snapshot.log[0].source, 'drop');
  assert.equal(snapshot.log[1].level, 'error');
});

test('missing local runtime remains optional and preserves the main-agent and chat paths', async () => {
  const native = nativeSnapshot();
  native.prereqs = { skid: { id: 'skid', label: 'Skidbladnir', installed: false, running: false } };
  const api = bridge(native);
  globalThis.window = { cth: api };
  const provider = createElectronProvider();
  const snapshot = await provider.snapshot();
  assert.equal(snapshot.prerequisites[0].level, 'optional');
  assert.equal(snapshot.prerequisites[0].state, 'missing');
  assert.equal(snapshot.agents[0].role, 'paramount');
  await provider.dispatch({ type: 'chat.send', chatId: 'agent:god', text: 'Status?' });
  assert.equal(api.sent[0].message.to, 'god');
});

test('orchestrator preview and confirmation preserve the flag across the desktop bridge', async () => {
  const api = bridge();
  const seen = [];
  api.paramountDispatch = async (command) => {
    seen.push(command);
    return { ok: true, hire: { agentId: 'god', confirmed: command.confirm === true } };
  };
  globalThis.window = { cth: api };
  const provider = createElectronProvider();
  const manifest = { spec: 'munder-difflin/hire@1', name: 'Paramount' };
  let refreshes = 0;
  provider.onRefresh(() => refreshes++);
  await provider.hire(manifest, { orchestrator: true });
  assert.deepEqual(seen[0], { type: 'agent.hire', manifest, orchestrator: true });
  assert.equal(refreshes, 0);
  await provider.hire(manifest, { orchestrator: true, confirm: true });
  assert.deepEqual(seen[1], { type: 'agent.hire', manifest, orchestrator: true, confirm: true });
  assert.equal(refreshes, 1);
});

test('projects non-secret settings and redacted integrations from the core', async () => {
  const native = nativeSnapshot();
  native.config = { ...native.config, defaultModel: 'model-1', semanticMemory: true, circuitBreaker: { enabled: true, hardStop: false } };
  native.integrations = [{ id: 'github', label: 'GitHub', kind: 'github', baseUrl: 'https://api.github.com', authType: 'bearer', enabled: true, hasSecret: true }];
  globalThis.window = { cth: bridge(native) };
  const snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.settings.defaultModel, 'model-1');
  assert.equal(snapshot.settings.circuitBreaker.enabled, true);
  assert.deepEqual(snapshot.me.connections[0], { id: 'github', name: 'GitHub', detail: 'github', connected: true,
    kind: 'github', baseUrl: 'https://api.github.com', authType: 'bearer', hasSecret: true });
  assert.equal(JSON.stringify(snapshot).includes('secretRef'), false);
});

test('first-run setup state is mapped; an older core without it stays set up', async () => {
  const native = nativeSnapshot();
  native.floorSetup = { complete: false, harnessHome: null, suggestedHome: '/Users/a/Paramount', engines: [
    { id: 'claude', label: 'Claude Code', orchestrator: true, installed: true, models: ['claude-opus-5-5', 7] },
    { label: 'no id' }
  ] };
  globalThis.window = { cth: bridge(native) };
  const snapshot = await createElectronProvider().snapshot();
  assert.deepEqual(snapshot.floorSetup, { complete: false, harnessHome: null, suggestedHome: '/Users/a/Paramount', engines: [
    { id: 'claude', label: 'Claude Code', orchestrator: true, installed: true, models: ['claude-opus-5-5'] }
  ] });
  globalThis.window = { cth: bridge(nativeSnapshot()) };
  assert.equal((await createElectronProvider().snapshot()).floorSetup, undefined);
});

test('account launcher choices survive setup mapping and selection crosses setup/hire/configuration boundaries', async () => {
  const pick = { id: 'dcm', fingerprint: 'a'.repeat(64), allowUnrestricted: true };
  const launchers = { status: 'ok', choices: [{ id: 'dcm', provider: 'claude', label: 'dcm · Alternate', fingerprint: pick.fingerprint, unrestricted: true }] };
  const native = nativeSnapshot();
  native.floorSetup = { complete: false, harnessHome: null, suggestedHome: '/fixture', engines: [], launchers };
  const seen = [];
  const api = bridge(native);
  api.paramountDispatch = async (command) => {
    seen.push(command);
    return { ok: true, event: { id: 'launcher-event', at: '2026-01-01T00:00:00Z', actor: 'you', command, correlationId: 'fixture' }, hire: { agentId: 'fixture', confirmed: false } };
  };
  globalThis.window = { cth: api };
  const provider = createElectronProvider();
  assert.deepEqual((await provider.snapshot()).floorSetup.launchers, launchers);
  await provider.hire({ spec: 'munder-difflin/hire@1', name: 'Fixture' }, { launcher: pick });
  assert.deepEqual(seen.at(-1).launcher, pick);
  await provider.hire({ spec: 'munder-difflin/hire@1', name: 'Fixture' }, { launcher: null });
  assert.equal(seen.at(-1).launcher, null);
  await provider.dispatch({ type: 'setup.complete', home: '/fixture', engine: 'claude', launcher: pick });
  assert.deepEqual(seen.at(-1).launcher, pick);
  const cmd = { type: 'launchers.configure', scope: 'temps', launcher: pick };
  assert.equal(provider.unsupported(cmd), null);
  await provider.dispatch(cmd);
  assert.deepEqual(seen.at(-1), cmd);
});

test('setup and automatic startup commands refresh the live snapshot and preserve structured errors', async () => {
  const core = bridge();
  const commands = [];
  core.paramountDispatch = async (command) => {
    commands.push(command);
    return { ok: true, event: { id: 'startup', at: '', actor: 'you', command } };
  };
  globalThis.window = { cth: core };
  const provider = createElectronProvider();
  let refreshes = 0;
  provider.onRefresh(() => refreshes++);
  await provider.dispatch({ type: 'setup.complete', home: '/fixture/floor', engine: 'codex' });
  await provider.dispatch({ type: 'orchestrator.ensure' });
  // Rediscovery happens in main; the setup screen then re-reads the snapshot.
  await provider.dispatch({ type: 'launchers.refresh' });
  assert.deepEqual(commands.map((c) => c.type), ['setup.complete', 'orchestrator.ensure', 'launchers.refresh']);
  assert.equal(refreshes, 3);
  core.paramountDispatch = async () => ({ ok: false, code: 'UNSUPPORTED', errorId: 'E-startup', correlationId: 'startup-cid', message: 'Install the selected CLI from Health, then start from Team' });
  await assert.rejects(provider.dispatch({ type: 'orchestrator.ensure' }), (error) => {
    assert.equal(error.code, 'UNSUPPORTED');
    assert.equal(error.errorId, 'E-startup');
    assert.equal(error.correlationId, 'startup-cid');
    return true;
  });
});

test('a floor another app holds and a failed hook socket reach the UI as explicit states', async () => {
  const native = nativeSnapshot();
  native.floorSetup = { complete: true, harnessHome: '/floor', suggestedHome: '/floor', engines: [],
    floorLock: { state: 'refused', refusal: { floor: '/floor', owner: 'Munder Difflin 0.5.7', pid: 71506, since: '2026-11-12T14:14:41.949Z', userData: '/u/munder-difflin/floors/a' } } };
  native.hookSocket = { listening: false, lastError: 'EADDRINUSE', attempts: 4, path: '/floor/hive/hooks.sock' };
  globalThis.window = { cth: bridge(native) };
  const snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.floorSetup.floorLock.state, 'refused');
  assert.equal(snapshot.floorSetup.floorLock.refusal.owner, 'Munder Difflin 0.5.7');
  assert.deepEqual(snapshot.hookSocket, { listening: false, lastError: 'EADDRINUSE', attempts: 4 });
});

test('Team graph from a live floor: every agent reports to the orchestrator and a busy terminal shows working', async () => {
  // Owner use of 52051eda: a flat row with no lines, and nobody ever 'working', because reportsTo was
  // never set for live agents and the registry's status stays 'idle' while agents run.
  const native = nativeSnapshot();
  native.registry = { godId: 'god', agents: {
    god: { name: 'Ada', role: 'orchestrator', status: 'idle', isGod: true },
    jim: { name: 'Jim', role: 'worker', status: 'idle' },
    kev: { name: 'Kevin', role: 'worker', status: 'idle' },
  } };
  native.activity = {
    god: { busy: false, doing: '', tokens: 0, contextPct: null },
    jim: { busy: true, doing: 'Bash', tokens: 2_500_000, contextPct: 41 },
    kev: { busy: false, doing: '', tokens: 0, contextPct: null },
  };
  globalThis.window = { cth: bridge(native) };
  const { agents } = await createElectronProvider().snapshot();
  const by = Object.fromEntries(agents.map((a) => [a.id, a]));
  assert.deepEqual(agents.filter((a) => a.reportsTo === 'god').map((a) => a.id).sort(), ['jim', 'kev']);
  assert.equal(by.god.reportsTo, undefined);
  assert.deepEqual(agents.filter((a) => a.status === 'working').map((a) => a.id), ['jim']);
  assert.equal(by.jim.doing, 'Bash');
  assert.equal(by.jim.tokensUsed, 2.5);
  assert.equal(by.jim.contextPct, 41);
});

test('the floor log shows an archived restore as a warning with its note (review F4)', async () => {
  const native = nativeSnapshot();
  native.log = [{ kind: 'paramount-runtime', step: 'restore', agentId: 'god', outcome: 'archived', code: 'CWD_MISSING', note: "W2's folder /w/gone is gone, so W2 was archived instead of restored.", ts: 1 }];
  globalThis.window = { cth: bridge(native) };
  const { log } = await createElectronProvider().snapshot();
  assert.equal(log[0].level, 'warn');
  assert.equal(log[0].text, "paramount-runtime · CWD_MISSING · W2's folder /w/gone is gone, so W2 was archived instead of restored.");
});

test('Health distinguishes responsive core from absent or stopped orchestrator', async () => {
  const native = nativeSnapshot();
  native.registry.agents = {};
  native.roster.agents = [];
  native.ptys = [];
  globalThis.window = { cth: bridge(native) };
  let snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.services.find(s => s.id === 'core').state, 'ok');
  assert.equal(snapshot.services.find(s => s.id === 'orchestrator').state, 'warn');
  assert.match(snapshot.services.find(s => s.id === 'orchestrator').detail, /unknown/);
  assert.equal(snapshot.services.filter(s => s.group === 'command-center').every(s => s.state === 'ok'), false);
  native.registry.agents.god = { name: 'Ada', status: 'working' };
  snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.services.find(s => s.id === 'orchestrator').state, 'warn', 'registry working is not process evidence');
  assert.match(snapshot.services.find(s => s.id === 'orchestrator').detail, /Not running/);
});

test('Health reports explicit startup failure and preserves the separate failure banner data', async () => {
  const native = nativeSnapshot();
  native.ptys = [];
  native.orchestratorFailure = { agentId: 'god', provider: 'codex', message: 'Session unavailable in selected account', at: '2026-11-15T13:00:00Z' };
  globalThis.window = { cth: bridge(native) };
  let snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.services.find(s => s.id === 'core').state, 'ok');
  assert.equal(snapshot.services.find(s => s.id === 'orchestrator').state, 'fail');
  assert.equal(snapshot.services.find(s => s.id === 'orchestrator').detail, native.orchestratorFailure.message);
  assert.equal(snapshot.orchestratorFailure.message, native.orchestratorFailure.message);
  native.ptys = [{ id: 'session-42', agentId: 'god' }];
  snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.services.find(s => s.id === 'orchestrator').state, 'fail', 'live PTY does not erase an explicitly reported startup failure');
  delete native.orchestratorFailure;
  snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.services.find(s => s.id === 'orchestrator').state, 'ok');
  assert.equal(snapshot.orchestratorFailure, undefined);
  native.ptys = [];
  snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.services.find(s => s.id === 'orchestrator').state, 'warn', 'cleared failure alone is not proof of running');
});

test('Health uses live terminal ownership and keeps starting and optional services distinct', async () => {
  const native = nativeSnapshot();
  native.registry.agents.god.status = 'starting';
  native.ptys = [];
  native.prereqs = { skid: { id: 'skid', installed: false, running: false } };
  globalThis.window = { cth: bridge(native) };
  let snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.services.find(s => s.id === 'orchestrator').state, 'warn');
  assert.match(snapshot.services.find(s => s.id === 'orchestrator').detail, /Starting/);
  native.roster = null;
  native.ptys = [{ id: 'live-main', agentId: 'god' }];
  snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.services.find(s => s.id === 'orchestrator').state, 'ok');
  assert.equal(snapshot.services.find(s => s.id === 'skid').state, 'warn');
  native.registry.agents.god.archived = true;
  snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.services.find(s => s.id === 'orchestrator').state, 'warn');
  assert.match(snapshot.services.find(s => s.id === 'orchestrator').detail, /archived/);
});

test('Health does not mistake another agent or a malformed terminal for the orchestrator', async () => {
  const native = nativeSnapshot();
  // A stale roster points at a PTY whose authoritative current owner is a worker.
  native.ptys = [{ id: 'session-42', agentId: 'worker' }];
  globalThis.window = { cth: bridge(native) };
  let snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.services.find(s => s.id === 'orchestrator').state, 'warn');
  native.roster = null;
  native.ptys = [{ agentId: 'god' }];
  snapshot = await createElectronProvider().snapshot();
  assert.equal(snapshot.services.find(s => s.id === 'orchestrator').state, 'warn');
});

test('managed account catalog and writes retain exact public profile identity through provider', async () => {
  const account = { id: 'opaque-profile', provider: 'claude', label: 'Work', source: 'managed', fingerprint: 'fp', unrestricted: false, available: false };
  const sent = [];
  const native = bridge();
  native.paramountDispatch = async command => {
    sent.push(command);
    return command.type === 'team.models' ? { ok: true, models: { engines: [], agents: {}, accounts: [account] } }
      : { ok: true, event: { id: 'managed-event', at: '', actor: 'you', command } };
  };
  globalThis.window = { cth: native };
  const provider = createElectronProvider();
  assert.deepEqual((await provider.teamModels()).accounts, [account]);
  await provider.dispatch({ type: 'accounts.create', provider: 'claude', label: 'Work' });
  await provider.dispatch({ type: 'accounts.rename', id: 'opaque-profile', label: 'Personal' });
  assert.deepEqual(sent, [{ type: 'team.models' }, { type: 'accounts.create', provider: 'claude', label: 'Work' }, { type: 'accounts.rename', id: 'opaque-profile', label: 'Personal' }]);
});
