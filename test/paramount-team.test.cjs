'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { dispatchParamount } = loadTs('src/main/paramount.ts');
const { nextCardKey, uniqueAgentId, readAgentModels, agentModelPick } = loadTs('src/main/paramount-team.ts');

const CATALOG = {
  version: 1,
  providers: {
    claude: [
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-future', label: 'Future', minAppVersion: '9.0.0' }
    ],
    codex: [{ label: 'CLI default' }, { id: 'gpt-x', label: 'GPT X' }]
  }
};

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-team-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-team-cwd-'));
  const state = {
    tasks: [{ id: 'NSC-1' }, { id: 'NSC-7' }, { id: 'OLD-40' }],
    agents: { jim: { name: 'Jim', provider: 'claude' }, pam: { name: 'Pam', provider: 'codex' } },
    events: [], steps: [], spawned: []
  };
  const team = {
    launcherDiscovery: () => ({ status: 'ok', choices: [], profiles: [] }),
    hiveRoot: () => root,
    addTask: (task) => { if (state.tasks.some((t) => t.id === task.id)) return false; state.tasks.push(task); return true; },
    modelCatalog: () => CATALOG,
    appVersion: '0.5.5',
    defaultModel: () => 'claude-sonnet-4-6',
    orchestratorProvider: () => 'claude',
    orchestratorModel: () => 'claude-opus-4-8',
    orchestratorId: () => Object.entries(state.agents).find(([, a]) => a.isGod)?.[0],
    hasLivePty: (id) => state.agents[id]?.live !== false && state.agents[id]?.archived !== true,
    defaultCommand: () => 'claude',
    autoMode: () => false,
    defaultCwd: () => work,
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    commandAvailable: () => true,
    spawnHire: async (spawn) => { state.spawned.push(spawn); if (spawn.isGod) state.agents[spawn.plan.agentId] = { name: spawn.plan.name, provider: spawn.provider, isGod: true, live: true }; return { ok: true }; },
    restartAgent: async (id, mode) => { state.restarted = { id, mode }; return { ok: true, resumed: mode === 'resume' }; },
    ...overrides
  };
  const deps = {
    tasks: () => ({ tasks: state.tasks }),
    agents: () => state.agents,
    appendEvent: (event) => state.events.push(event),
    publish: () => {},
    logStep: (step) => state.steps.push(step),
    team
  };
  return { state, deps, root, work };
}

test('card.create adds the next key on the ledger prefix and emits one event', () => {
  const { state, deps } = fixture();
  const result = dispatchParamount({ type: 'card.create', title: 'Fix the build', assignee: 'jim', priority: 1 }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.card.key, 'NSC-8');
  const card = state.tasks.find((t) => t.id === 'NSC-8');
  assert.equal(card.title, 'Fix the build');
  assert.equal(card.assignee, 'jim');
  assert.equal(card.status, 'todo');
  assert.equal(state.events.length, 1);
});

test('agent.switch validates the target and passes the exact provider, model and account without hiring', async () => {
  let selected;
  const f = fixture({ switchAgent: async (id, target) => { selected = { id, ...target }; return { ok: true }; } });
  const result = await dispatchParamount({ type: 'agent.switch', agentId: 'jim', provider: 'codex', model: 'gpt-x', launcher: null }, f.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(selected, { id: 'jim', provider: 'codex', model: 'gpt-x', launcher: null });
  assert.equal(f.state.spawned.length, 0);
});

test('agent.switch rejects unavailable models and never invokes the switch callback', async () => {
  let called = false;
  const f = fixture({ switchAgent: async () => { called = true; return { ok: true }; } });
  const result = await dispatchParamount({ type: 'agent.switch', agentId: 'jim', provider: 'codex', model: 'not-offered', launcher: null }, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_INPUT');
  assert.equal(called, false);
});

test('agent.switch requires an explicit account when launchers were discovered', async () => {
  let called = false;
  const choice = { id: 'dcxm', provider: 'codex', label: 'dcxm · Alternate', fingerprint: 'a'.repeat(64), unrestricted: false };
  const f = fixture({ launcherDiscovery: () => ({ status: 'ok', choices: [choice], profiles: [{ ...choice, bin: 'codex', args: [], home: '/tmp/codex-alt' }] }), switchAgent: async () => { called = true; return { ok: true }; } });
  const result = await dispatchParamount({ type: 'agent.switch', agentId: 'jim', provider: 'codex', model: 'gpt-x', launcher: null }, f.deps);
  assert.equal(result.ok, false);
  assert.match(result.message, /exact account launcher/);
  assert.equal(called, false);
});

test('team delegation atomically creates a lead parent and owned dependent subtasks then messages each owner', () => {
  const messages = [];
  const { state, deps, root } = fixture({
    addTasksBatch: (rows) => { if (rows.some((row) => state.tasks.some((item) => item.id === row.id))) return false; state.tasks.push(...rows); return true; },
    sendAgentMessage: (agentId, subject, body) => messages.push({ agentId, subject, body })
  });
  fs.mkdirSync(path.join(root, 'council', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'council', 'extensions', 'teams.json'), JSON.stringify({ version: 1, teams: [{ id: 'platform', name: 'Platform', leadId: 'jim', memberIds: ['jim', 'pam'] }], reportsTo: { pam: 'jim' } }));
  const result = dispatchParamount({ type: 'team.delegate', teamId: 'platform', title: 'Ship feature', subtasks: [
    { title: 'Implement', ownerId: 'jim', dependsOn: [] },
    { title: 'Review', ownerId: 'pam', dependsOn: [0] }
  ] }, deps);
  assert.equal(result.ok, true);
  const parent = state.tasks.find((task) => task.id === result.delegated.parentKey);
  const [first, second] = result.delegated.childKeys.map((key) => state.tasks.find((task) => task.id === key));
  assert.equal(parent.assignee, 'jim');
  assert.equal(first.parentId, parent.id);
  assert.deepEqual(second.dependsOn, [first.id]);
  assert.deepEqual(messages.map((message) => message.agentId), ['jim', 'pam']);
  assert.match(messages[1].body, new RegExp(first.id));
});

test('agent.restart preserves the selected identity and explicitly chooses resume or fresh', async () => {
  const { state, deps } = fixture();
  const resumed = await dispatchParamount({ type: 'agent.restart', agentId: 'jim', mode: 'resume' }, deps);
  assert.equal(resumed.ok, true);
  assert.deepEqual(state.restarted, { id: 'jim', mode: 'resume' });
  const fresh = await dispatchParamount({ type: 'agent.restart', agentId: 'jim', mode: 'fresh' }, deps);
  assert.equal(fresh.ok, true);
  assert.deepEqual(state.restarted, { id: 'jim', mode: 'fresh' });
  assert.equal(dispatchParamount({ type: 'agent.restart', agentId: 'jim', mode: 'other' }, deps).code, 'INVALID_INPUT');
  state.agents.god = { name: 'God', isGod: true };
  assert.equal((await dispatchParamount({ type: 'agent.restart', agentId: 'god', mode: 'resume' }, deps)).ok, true);
  assert.deepEqual(state.restarted, { id: 'god', mode: 'resume' });
});

test('card.create rejects bad input with an errorId and code', () => {
  const { state, deps } = fixture();
  for (const command of [
    { type: 'card.create', title: '  ' },
    { type: 'card.create', title: 'x', priority: 9 },
    { type: 'card.create', title: 'x', status: 'done' },
    { type: 'card.create', title: 'x', token: 'secret' }
  ]) {
    const result = dispatchParamount(command, deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_INPUT');
    assert.match(result.errorId, /\S/);
  }
  assert.equal(dispatchParamount({ type: 'card.create', title: 'x', assignee: 'ghost' }, deps).code, 'NOT_FOUND');
  assert.equal(state.events.length, 0);
});

test('card.create without team deps is UNSUPPORTED, not silently ignored', () => {
  const { deps } = fixture();
  delete deps.team;
  const result = dispatchParamount({ type: 'card.create', title: 'x' }, deps);
  assert.equal(result.code, 'UNSUPPORTED');
});

test('nextCardKey follows the most used prefix and starts at P-1', () => {
  assert.equal(nextCardKey([]), 'P-1');
  assert.equal(nextCardKey(['A-1', 'A-2', 'B-9']), 'A-3');
  assert.equal(nextCardKey(['free-form', 'X-10']), 'X-11');
});

test('configured ticket prefix only advances keys in that namespace', () => {
  assert.equal(nextCardKey(['NSC-9', 'LAB-2', 'LAB-5'], 'LAB'), 'LAB-6');
  const { deps } = fixture({ ticketKeyPrefix: () => 'LAB' });
  const result = dispatchParamount({ type: 'card.create', title: 'Check launch' }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.card.key, 'LAB-1');
});

test('team.models lists engines from the catalog, filtered by version, with the default and picks', () => {
  const { deps } = fixture();
  const result = dispatchParamount({ type: 'team.models' }, deps);
  assert.equal(result.ok, true);
  const claude = result.models.engines.find((e) => e.id === 'claude');
  assert.deepEqual(claude.models.map((m) => m.id), ['claude-sonnet-4-6', 'claude-opus-4-8']);
  assert.equal(result.models.defaultModel, 'claude-sonnet-4-6');
  assert.deepEqual(result.models.agents.jim, { engine: 'claude', installed: true, accountSelection: 'default' });
  assert.deepEqual(result.models.agents.pam, { engine: 'codex', installed: true, accountSelection: 'default' });
});

test('agent.update model saves a pick that the spawn path reads, and empty clears it', () => {
  const { state, deps, root } = fixture();
  const set = dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { model: 'claude-opus-4-8' } }, deps);
  assert.equal(set.ok, true);
  assert.equal(agentModelPick(root, 'jim'), 'claude-opus-4-8');
  assert.deepEqual(dispatchParamount({ type: 'team.models' }, deps).models.agents.jim, { engine: 'claude', model: 'claude-opus-4-8', installed: true, accountSelection: 'default' });
  const clear = dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { model: '' } }, deps);
  assert.equal(clear.ok, true);
  assert.equal(agentModelPick(root, 'jim'), undefined);
  assert.equal(state.events.length, 3);
});

test('agent.update model refuses unknown models, other engines and mixed patches', () => {
  const { deps } = fixture();
  assert.equal(dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { model: 'gpt-x' } }, deps).code, 'INVALID_INPUT');
  assert.equal(dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { model: 'gpt-x', engine: 'codex' } }, deps).code, 'UNSUPPORTED');
  assert.equal(dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { model: 'claude-opus-4-8', name: 'J' } }, deps).code, 'INVALID_INPUT');
  assert.equal(dispatchParamount({ type: 'agent.update', agentId: 'nobody', patch: { model: 'claude-opus-4-8' } }, deps).code, 'NOT_FOUND');
  // A non-model agent.update still goes to the core handler.
  const rename = dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { color: 'red' } }, { ...deps, renameAgent: () => ({ ok: true }) });
  assert.equal(rename.code, 'UNSUPPORTED');
});

test('a corrupt picks file is reported, never reset silently', () => {
  const { deps, root } = fixture();
  fs.writeFileSync(path.join(root, 'paramount-agent-models.json'), '[]');
  assert.throws(() => readAgentModels(root), /corrupt/);
  const result = dispatchParamount({ type: 'team.models' }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INTERNAL');
});

test('agent.hire without confirm returns the plan and spawns nothing', () => {
  const { state, deps, work } = fixture();
  const result = dispatchParamount({ type: 'agent.hire', manifest: { spec: 'munder-difflin/hire@1', name: 'Jim', description: 'Reviewer', model: 'claude-opus-4-8', skills: ['md-audit'] } }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.hire.confirmed, false);
  assert.equal(result.hire.agentId, 'jim-2');
  assert.equal(result.hire.cwd, work);
  assert.match(result.hire.command, /^claude .*--model claude-opus-4-8/);
  assert.deepEqual(result.hire.ignored, ['skills']);
  assert.equal(state.spawned.length, 0);
});

test('agent.hire with confirm spawns once and delivers the goal through spawnHire', async () => {
  const { state, deps } = fixture();
  const result = await dispatchParamount({ type: 'agent.hire', confirm: true, manifest: { spec: 'munder-difflin/hire@1', name: 'Dwight', goal: 'Sell paper', provider: 'codex' } }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.hire.confirmed, true);
  assert.equal(state.spawned.length, 1);
  assert.equal(state.spawned[0].bin, 'codex');
  assert.equal(state.spawned[0].goal, 'Sell paper');
  assert.equal(state.events.length, 1);
});

test('agent.hire refuses invalid manifests, missing folders, missing CLIs and failed spawns', async () => {
  const bad = fixture();
  assert.equal(dispatchParamount({ type: 'agent.hire', manifest: { name: 'No spec' } }, bad.deps).code, 'INVALID_INPUT');
  assert.equal(dispatchParamount({ type: 'agent.hire', manifest: { spec: 'munder-difflin/hire@1', name: 'A', commandFlags: ['--dangerously-skip-permissions'] } }, bad.deps).code, 'INVALID_INPUT');
  assert.equal(dispatchParamount({ type: 'agent.hire', cwd: '/definitely/not/here', manifest: { spec: 'munder-difflin/hire@1', name: 'A' } }, bad.deps).code, 'INVALID_INPUT');
  const noCli = fixture({ commandAvailable: () => false });
  const missing = await dispatchParamount({ type: 'agent.hire', confirm: true, manifest: { spec: 'munder-difflin/hire@1', name: 'A' } }, noCli.deps);
  assert.equal(missing.code, 'UNSUPPORTED');
  assert.equal(noCli.state.spawned.length, 0);
  const broken = fixture({ spawnHire: async () => ({ ok: false, error: 'pty exploded' }) });
  const failed = await dispatchParamount({ type: 'agent.hire', confirm: true, manifest: { spec: 'munder-difflin/hire@1', name: 'A' } }, broken.deps);
  assert.equal(failed.code, 'INTERNAL');
  assert.match(failed.message, /pty exploded/);
  assert.equal(broken.state.events.length, 0);
});

test('uniqueAgentId never reuses a registry id', () => {
  assert.equal(uniqueAgentId('Jim Halpert', []), 'jim-halpert');
  assert.equal(uniqueAgentId('Jim', ['jim', 'jim-2']), 'jim-3');
  assert.equal(uniqueAgentId('!!!', []), 'agent');
});

const orchestratorHire = (confirm = false) => ({
  type: 'agent.hire', orchestrator: true, confirm,
  manifest: { spec: 'munder-difflin/hire@1', name: 'Paramount' }
});

test('orchestrator preview uses the configured engine and model without spawning', () => {
  const { state, deps } = fixture({ orchestratorProvider: () => 'codex', orchestratorModel: () => 'gpt-x' });
  const models = dispatchParamount({ type: 'team.models' }, deps);
  assert.equal(models.models.orchestratorProvider, 'codex');
  assert.equal(models.models.orchestratorModel, 'gpt-x');
  const result = dispatchParamount(orchestratorHire(), deps);
  assert.equal(result.ok, true);
  assert.equal(result.hire.agentId, 'god');
  assert.equal(result.hire.role, 'Paramount orchestrator');
  assert.equal(result.hire.engine, 'codex');
  assert.equal(result.hire.model, 'gpt-x');
  assert.match(result.hire.command, /^codex .*--model gpt-x/);
  assert.equal(result.hire.confirmed, false);
  assert.equal(state.spawned.length, 0);
});

test('confirmed orchestrator uses the main-agent identity and preserves explicit model choice', async () => {
  const { state, deps } = fixture();
  const command = orchestratorHire(true);
  command.manifest.model = 'claude-sonnet-4-6';
  const result = await dispatchParamount(command, deps);
  assert.equal(result.ok, true);
  assert.equal(state.spawned.length, 1);
  assert.equal(state.spawned[0].isGod, true);
  assert.equal(state.spawned[0].plan.agentId, 'god');
  assert.equal(state.spawned[0].provider, 'claude');
  assert.deepEqual(state.spawned[0].args.slice(-2), ['--model', 'claude-sonnet-4-6']);
});

test('orchestrator rejects an existing main agent or reserved id before spawning', async () => {
  for (const registered of [{ main: { isGod: true } }, { god: { name: 'Reserved' } }]) {
    const { state, deps } = fixture();
    state.agents = registered;
    for (const confirm of [false, true]) {
      const result = await dispatchParamount(orchestratorHire(confirm), deps);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'CONFLICT');
    }
    assert.equal(state.spawned.length, 0);
  }
});

test('orchestrator validates its flag and surfaces missing CLI and launch failures', async () => {
  const { deps } = fixture();
  assert.equal(dispatchParamount({ ...orchestratorHire(), orchestrator: 'yes' }, deps).code, 'INVALID_INPUT');
  const absent = fixture({ commandAvailable: () => false });
  assert.equal((await dispatchParamount(orchestratorHire(true), absent.deps)).code, 'UNSUPPORTED');
  assert.equal(absent.state.spawned.length, 0);
  const broken = fixture({ spawnHire: async () => ({ ok: false, error: 'PTY failed' }) });
  const failure = await dispatchParamount(orchestratorHire(true), broken.deps);
  assert.equal(failure.code, 'INTERNAL');
  assert.match(failure.message, /PTY failed/);
});

test('ordinary hires remain workers with their selected provider', async () => {
  const { state, deps } = fixture({ orchestratorProvider: () => 'codex' });
  const result = await dispatchParamount({ type: 'agent.hire', confirm: true,
    manifest: { spec: 'munder-difflin/hire@1', name: 'Reviewer', provider: 'claude' } }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.hire.engine, 'claude');
  assert.equal(state.spawned[0].isGod, undefined);
  assert.notEqual(result.hire.agentId, 'god');
});

test('concurrent orchestrator confirmations cannot start two main agents', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { state, deps } = fixture({ spawnHire: async (spawn) => {
    state.spawned.push(spawn);
    await pending;
    return { ok: true };
  } });
  const first = dispatchParamount(orchestratorHire(true), deps);
  // Main creates a fresh adapter per IPC call; the guard must span adapters.
  const second = dispatchParamount(orchestratorHire(true), { ...deps, team: { ...deps.team } });
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((r) => r.ok ? 'OK' : r.code), ['OK', 'CONFLICT']);
  assert.equal(state.spawned.length, 1);
});

test('failed orchestrator launches release the reservation so the user can retry', async () => {
  for (const spawnHire of [() => { throw new Error('sync failure'); }, async () => { throw new Error('async failure'); }, async () => ({ ok: false, error: 'failed' })]) {
    const { deps } = fixture({ spawnHire });
    assert.equal((await dispatchParamount(orchestratorHire(true), deps)).ok, false);
    deps.team.spawnHire = async () => ({ ok: true });
    assert.equal((await dispatchParamount(orchestratorHire(true), deps)).ok, true);
  }
});

test('an orchestrator cannot start without an enabled hive', async () => {
  const { state, deps } = fixture({ hiveRoot: () => null });
  assert.equal((await dispatchParamount(orchestratorHire(true), deps)).code, 'UNSUPPORTED');
  assert.equal(state.spawned.length, 0);
});

test('a stopped orchestrator can restart under its durable identity with resume requested', async () => {
  const { deps, state } = fixture();
  state.agents.main = { isGod: true, archived: true, live: false };
  const result = await dispatchParamount(orchestratorHire(true), deps);
  assert.equal(result.ok, true);
  assert.equal(result.hire.agentId, 'main');
  assert.equal(state.spawned[0].resume, true);
});

test('orchestrator requests its workspace fallback; workers still require a selected project', () => {
  let requestedFallback;
  const { deps, work } = fixture();
  deps.team.defaultCwd = (orchestrator) => { requestedFallback = orchestrator; return orchestrator ? work : null; };
  assert.equal(dispatchParamount(orchestratorHire(), deps).ok, true);
  assert.equal(requestedFallback, true);
  const worker = dispatchParamount({ type: 'agent.hire', manifest: { spec: 'munder-difflin/hire@1', name: 'Worker' } }, deps);
  assert.equal(worker.code, 'INVALID_INPUT');
  assert.equal(requestedFallback, false);
});

// Execute the real Council hook with a deterministic effect scheduler. This
// exercises the setup snapshot -> effect -> IPC dispatch boundary without an app.
function startupEffect(setup, dispatch) {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../ui/src/app/use-orchestrator-startup.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  const effects = [];
  new Function('module', 'exports', 'require', js)(mod, mod.exports, (id) => {
    if (id === 'react') return { useEffect: (effect) => effects.push(effect) };
    if (id === '@/data/store') return { useDispatch: () => dispatch };
    throw new Error(`Unexpected import ${id}`);
  });
  mod.exports.useOrchestratorStartup(setup);
  effects.forEach((effect) => effect());
}

test('Council setup snapshot requests automatic launch once across duplicate effects/windows', async () => {
  const { dispatchFloorSetup, floorSetupState } = loadTs('src/main/paramount-floor-setup.ts');
  const config = { onboardingComplete: false, harnessHome: null };
  const f = fixture({ setupComplete: () => config.onboardingComplete && !!config.harnessHome });
  const setup = {
    config: () => config, suggestedHome: () => f.work,
    engines: () => [{ id: 'claude', label: 'Claude', orchestrator: true, installed: true, models: ['claude-opus-4-8'] }],
    ensureHome: () => ({ ok: true }), complete: (patch) => Object.assign(config, patch),
    appendEvent() {}, publish() {}
  };
  const requests = [];
  const send = (cmd) => { const request = dispatchParamount(cmd, f.deps); requests.push(request); return request; };
  startupEffect(floorSetupState(setup), send);
  assert.equal(requests.length, 0);
  assert.equal((await dispatchParamount({ type: 'orchestrator.ensure' }, f.deps)).ok, false);
  assert.equal(f.state.spawned.length, 0);
  assert.equal(dispatchFloorSetup({ type: 'setup.complete', home: f.work, engine: 'claude', model: 'claude-opus-4-8' }, setup,
    { cid: 'setup', fail: (code, message) => ({ ok: false, code, message }) }).ok, true);
  assert.equal(floorSetupState(setup).complete, true);
  for (let i = 0; i < 4; i++) startupEffect(floorSetupState(setup), send);
  const results = await Promise.all(requests);
  assert.ok(results.every((r) => r.ok));
  assert.equal(f.state.spawned.length, 1);
  assert.equal(f.state.spawned[0].isGod, true);
  assert.equal(f.state.spawned[0].provider, 'claude');
  assert.ok(f.state.spawned[0].args.includes('claude-opus-4-8'));
  assert.equal((await dispatchParamount({ type: 'orchestrator.ensure' }, f.deps)).ok, true);
  assert.equal(f.state.spawned.length, 1);
});

test('Council mounts automatic startup after setup and uses the configured floor as its cwd', () => {
  const app = fs.readFileSync(path.join(__dirname, '../ui/src/App.tsx'), 'utf8');
  assert.match(app, /useOrchestratorStartup\(setup\)/);
  const hook = fs.readFileSync(path.join(__dirname, '../ui/src/app/use-orchestrator-startup.ts'), 'utf8');
  assert.match(hook, /setup\?\.complete/);
  assert.match(hook, /orchestrator.ensure/);
  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  // Every hire with an empty folder uses the open floor's root (hire-folder fix, E-mwdspis5-11325983).
  assert.match(main, /defaultCwd: \(\) => floorHome\(\),/);
});

test('automatic startup resumes the existing identity/name with configured Codex model', async () => {
  const f = fixture({ setupComplete: () => true, orchestratorProvider: () => 'codex', orchestratorModel: () => 'gpt-x' });
  f.state.agents.leader = { name: 'Saved leader', provider: 'codex', isGod: true, archived: true };
  assert.equal((await dispatchParamount({ type: 'orchestrator.ensure' }, f.deps)).ok, true);
  assert.equal(f.state.spawned[0].plan.agentId, 'leader');
  assert.equal(f.state.spawned[0].plan.name, 'Saved leader');
  assert.equal(f.state.spawned[0].resume, true);
  assert.equal(f.state.spawned[0].provider, 'codex');
  assert.ok(f.state.spawned[0].args.includes('gpt-x'));
  assert.deepEqual(f.state.steps.filter((e) => e.kind === 'paramount-orchestrator').map((e) => e.step),
    ['setup-ready', 'readiness-check', 'launch-requested', 'launch-accepted']);
  assert.ok(f.state.steps.every((e) => typeof e.cid === 'string'));
});

test('automatic startup recognizes an already live god without another spawn', async () => {
  const f = fixture({ setupComplete: () => true });
  f.state.agents.god = { isGod: true, name: 'Saved' };
  assert.equal((await dispatchParamount({ type: 'orchestrator.ensure' }, f.deps)).ok, true);
  assert.equal(f.state.spawned.length, 0);
});

for (const [label, overrides, code] of [
  ['unknown provider', { orchestratorProvider: () => 'unknown' }, 'INVALID_INPUT'],
  ['missing executable', { commandAvailable: () => false }, 'UNSUPPORTED'],
  ['failed allocation', { spawnHire: async () => ({ ok: false, error: 'PTY unavailable sk-abcdefghijklmnopqrstuv' }) }, 'INTERNAL'],
]) {
  test(`automatic ${label} is actionable, redacted and latched without render retries`, async () => {
    const f = fixture({ setupComplete: () => true, ...overrides });
    const first = await dispatchParamount({ type: 'orchestrator.ensure' }, f.deps);
    assert.equal(first.ok, false);
    assert.equal(first.code, code);
    assert.ok(first.errorId);
    assert.ok(first.correlationId);
    assert.doesNotMatch(JSON.stringify(first) + JSON.stringify(f.state.steps), /sk-abcdefghijklmnopqrstuv/);
    const steps = f.state.steps.length;
    // Latched: no new attempt. Owner run of ceeb4aaf: each failure now has its own error id.
    const again = await dispatchParamount({ type: 'orchestrator.ensure' }, f.deps);
    assert.equal(again.ok, false); assert.equal(again.code, first.code); assert.equal(again.message, first.message);
    assert.notEqual(again.errorId, first.errorId, 'a repeated failure is its own diagnostic, not a stale id');
    assert.equal(f.state.steps.length, steps);
    // Failure latching applies only to automatic startup; explicit recovery works.
    f.deps.team.commandAvailable = () => true;
    f.deps.team.spawnHire = async () => ({ ok: true });
    assert.equal((await dispatchParamount(orchestratorHire(true), f.deps)).ok, true);
  });
}

test('automatic startup without an explicit model uses the provider default', async () => {
  const f = fixture({ setupComplete: () => true, orchestratorProvider: () => 'codex', orchestratorModel: () => undefined });
  assert.equal((await dispatchParamount({ type: 'orchestrator.ensure' }, f.deps)).ok, true);
  assert.equal(f.state.spawned[0].args.includes('--model'), false);
});

test('Council diagnostics failure cannot block the reused baseline launch path', async () => {
  const f = fixture({ setupComplete: () => true });
  f.deps.logStep = () => { throw new Error('diagnostic sink offline'); };
  assert.equal((await dispatchParamount({ type: 'orchestrator.ensure' }, f.deps)).ok, true);
  assert.equal(f.state.spawned.length, 1);
});
