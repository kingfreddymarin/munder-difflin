'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'council-review-config-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
const load = require('./load-ts.cjs');
const { readConfig, writeConfig, modelForRole } = load('src/main/config.ts');
const { dispatchParamount } = load('src/main/paramount.ts');
const { dispatchFloorSetup } = load('src/main/paramount-floor-setup.ts');
const { buildWorkerLaunch } = load('src/main/workerLaunch.ts');
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));
const catalog = { version: 1, providers: { claude: [{ id: 'claude-opus-4-8', label: 'Opus' }], codex: [{ id: 'gpt-x', label: 'GPT' }] } };
function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'council-review-startup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agents = {}, launches = [];
  const deps = { tasks: () => ({ tasks: [] }), agents: () => agents, appendEvent() {}, publish() {}, team: {
    hiveRoot: () => path.join(home, 'hive'), launcherDiscovery: () => ({ status: 'ok', choices: [], profiles: [] }), setupComplete: () => true,
    modelCatalog: () => catalog, appVersion: '0.5.5', defaultModel: () => undefined, orchestratorProvider: () => 'claude', orchestratorModel: () => 'claude-opus-4-8',
    orchestratorId: () => Object.keys(agents).find((id) => agents[id].isGod), hasLivePty: (id) => agents[id]?.live === true, defaultCommand: () => 'claude', autoMode: () => false,
    defaultCwd: () => home, isDirectory: () => true, commandAvailable: () => true,
    spawnHire: async (spawn) => { launches.push(spawn); agents[spawn.plan.agentId] = { ...agents[spawn.plan.agentId], isGod: true, name: spawn.plan.name, provider: spawn.provider, live: options.earlyExit ? false : true }; return { ok: true }; }
  } };
  return { home, deps, agents, launches, ensure: () => dispatchParamount({ type: 'orchestrator.ensure' }, deps) };
}
for (const provider of ['claude', 'codex']) test(`P1: actual stored defaults -> ${provider} setup with Engine default -> actual role resolver -> automatic launch`, async (t) => {
  const f = fixture(t);
  writeConfig({ harnessHome: null, onboardingComplete: false, godProvider: 'claude', godModel: 'claude-opus-4-8' });
  assert.equal(readConfig().godModel, 'claude-opus-4-8');
  const setup = { launcherDiscovery: f.deps.team.launcherDiscovery, config: readConfig, suggestedHome: () => f.home,
    engines: () => [{ id: provider, label: provider, installed: true, orchestrator: true, models: catalog.providers[provider].map((m) => m.id) }],
    ensureHome: () => ({ ok: true }), complete: writeConfig, appendEvent() {}, publish() {} };
  const saved = dispatchFloorSetup({ type: 'setup.complete', home: f.home, engine: provider }, setup, { cid: 'regression', fail: (code, message) => ({ ok: false, code, message }) });
  assert.equal(saved.ok, true);
  assert.equal(readConfig().godModel, '', 'explicit empty string must survive config persistence/default merging');
  const effective = modelForRole({ isGod: true }, readConfig());
  assert.ok(effective === '' || effective == null, 'spawnAgentCore must not inject a recommended or stale model');
  f.deps.team.orchestratorProvider = () => readConfig().godProvider;
  f.deps.team.orchestratorModel = () => modelForRole({ isGod: true }, readConfig());
  assert.equal((await f.ensure()).ok, true); assert.equal(f.launches.length, 1); assert.equal(f.launches[0].provider, provider);
  assert.equal(f.launches[0].args.includes('--model'), false);
  const resolved = buildWorkerLaunch({ requestProvider: provider, requestModel: effective, autoMode: false });
  assert.equal(resolved.args.includes('--model'), false);
});
test('P2: live -> stopped -> remount reconciles ownership; concurrent remounts create exactly one resumed launch', async (t) => {
  const f = fixture(t); f.agents.saved = { isGod: true, live: true, name: 'Saved' };
  const before = await f.ensure(); assert.equal(before.ok, true); assert.equal(f.launches.length, 0);
  f.agents.saved.live = false;
  const after = await Promise.all(Array.from({ length: 8 }, f.ensure));
  assert.ok(after.every((r) => r.ok)); assert.notEqual(after[0], before);
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].resume, true); assert.equal(f.launches[0].plan.agentId, 'saved');
  assert.equal((await f.ensure()).ok, true); assert.equal(f.launches.length, 1);
});
test('P2: allocated -> early exit permits one automatic recovery, then reports stopped without a restart loop', async (t) => {
  const f = fixture(t, { earlyExit: true });
  assert.equal((await f.ensure()).ok, true); assert.equal(f.launches.length, 1);
  assert.equal((await f.ensure()).ok, true); assert.equal(f.launches.length, 2);
  const stopped = await f.ensure(); assert.equal(stopped.ok, false); assert.match(stopped.errorId, /\S/); assert.match(stopped.message, /bounded automatic recovery/);
  for (let i = 0; i < 3; i++) assert.equal((await f.ensure()).ok, false);
  assert.equal(f.launches.length, 2);
});
test('row 8: first start requests baseline resume and restart reuses the registered orchestrator identity', async (t) => {
  const fresh = fixture(t); assert.equal((await fresh.ensure()).ok, true); assert.equal(fresh.launches[0].resume, true);
  const restarted = fixture(t); restarted.agents.god = { isGod: true, live: false, name: 'Saved orchestrator', lastSessionId: 'fixture-session' };
  const results = await Promise.all([restarted.ensure(), restarted.ensure()]); assert.ok(results.every((r) => r.ok));
  assert.equal(restarted.launches.length, 1); assert.equal(restarted.launches[0].plan.agentId, 'god'); assert.equal(restarted.launches[0].resume, true);
  assert.equal(restarted.agents.god.lastSessionId, 'fixture-session');
  const { HiveManager } = load('src/main/hive.ts');
  const hive = new HiveManager(() => restarted.home);
  const meta = { id: 'god', name: 'Saved orchestrator', isGod: true, provider: 'claude', cwd: restarted.home };
  await hive.ensureAgent(meta); hive.recordSession('god', 'fixture-session');
  await hive.ensureAgent(meta);
  assert.equal(hive.lastSession('god'), 'fixture-session', 'provisioning preserves the resume key read by spawnAgentCore');
});
test('row 16: stale role/global defaults fall to provider default; explicit cross-engine models and flags are refused', async (t) => {
  const f = fixture(t); f.deps.team.orchestratorProvider = () => 'codex'; f.deps.team.orchestratorModel = () => 'claude-opus-4-8';
  assert.equal((await f.ensure()).ok, true); assert.equal(f.launches[0].provider, 'codex'); assert.equal(f.launches[0].args.includes('--model'), false);
  for (const manifest of [
    { provider: 'codex', model: 'claude-opus-4-8' },
    { provider: 'codex', commandFlags: ['--model', 'claude-opus-4-8'] },
    { provider: 'codex', commandFlags: ['--model=claude-opus-4-8'] }
  ]) assert.equal((await dispatchParamount({ type: 'agent.hire', manifest: { spec: 'munder-difflin/hire@1', name: 'Bad', ...manifest } }, f.deps)).ok, false);
  const preview = await dispatchParamount({ type: 'agent.hire', manifest: { spec: 'munder-difflin/hire@1', name: 'Good', provider: 'codex', commandFlags: ['--model=gpt-x'] } }, f.deps);
  assert.equal(preview.ok, true); assert.equal(preview.hire.model, 'gpt-x'); assert.match(preview.hire.command, /--model gpt-x/);
});
test('row 10: the actual main wake adapter passes live worker mail without a god and retains safety facts', () => {
  const ts = require('typescript'); const source = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const start = source.indexOf('function runWorkerWakeBeat()'); const end = source.indexOf('/** (Re)arm the always-on beats', start);
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const captured = [], nudged = [];
  const env = {
    hive: { enabled: () => true, registry: () => ({ godId: null, agents: { live: {}, paused: {}, archived: { archived: true }, offline: {} } }), inbox: () => [{ id: 'fixture-mail', created_at: new Date().toISOString() }] },
    paramountOrchestrators: new Set(), ptyForAgent: (id) => id === 'offline' ? undefined : `pty-${id}`, control: { snapshot: (id) => ({ paused: id === 'paused' }) },
    telemetry: { getAgentUsage: () => null, getSpans: () => [] }, ptyManager: { lastOutputAt: () => 1 }, activityEvidenceAt: () => 1,
    workerWake: { decide: (facts) => { captured.push(...facts); return facts.filter((f) => !f.paused).map((f) => f.agentId); }, shouldReportHold: () => false },
    nudgeWorker: (...args) => nudged.push(args), WORKER_WAKE_REPORT_MS: 60000, console: { log() {}, warn() {} }
  };
  new Function(...Object.keys(env), js + '\nrunWorkerWakeBeat();')(...Object.values(env));
  assert.deepEqual(captured.map((f) => f.agentId), ['live', 'paused']); assert.equal(captured[1].paused, true);
  assert.deepEqual(nudged, [['pty-live', ['fixture-mail'], false]]);
});
