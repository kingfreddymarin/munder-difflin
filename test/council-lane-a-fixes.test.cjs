'use strict';
// Fixes for REVIEW-2026-11-12-laneA.md. Each test fails on the lane A commit
// (876f6c0c) and passes after: no shell discovery outside an explicit refresh,
// one floor runtime per orchestrator, one discovery per spawn, and a bad launcher
// entry stops only the spawns that use it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

// Count every child process the modules start (installed before they load).
const realSpawnSync = cp.spawnSync;
let shells = 0;
cp.spawnSync = (...args) => { shells++; return realSpawnSync(...args); };
test.after(() => { cp.spawnSync = realSpawnSync; });

const load = require('./load-ts.cjs');
const account = load('src/main/council-account-launchers.ts');
const { floorSetupState, dispatchFloorSetup } = load('src/main/paramount-floor-setup.ts');
const { dispatchParamount } = load('src/main/paramount.ts');
const { claimFloor, LOCK_FILE } = load('src/main/paramount-runtime.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'council-lane-a-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'hive');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(home, '.claude-minion'));
  // A fake login-shell probe: dcm is a Claude alias with its own account home.
  const rec = (id, type, def) => `\0COUNCIL_LAUNCHER_V1\0${id}\0${type}\0${def}\0${home}\0\0\0`;
  const stdout = rec('dc', 'absent', '') + rec('dcm', 'alias', `CLAUDE_CONFIG_DIR=${home}/.claude-minion claude`) + rec('dcx', 'absent', '') + rec('dcxm', 'absent', '');
  let discoveries = 0;
  const discover = () => { discoveries++; return account.discoverShellLaunchers(() => ({ stdout, status: 0 }), 2000, home, '/bin/zsh'); };
  const dcm = () => { const c = account.discoverShellLaunchers(() => ({ stdout, status: 0 }), 2000, home, '/bin/zsh').choices.find((x) => x.id === 'dcm'); return { id: c.id, fingerprint: c.fingerprint }; };
  const file = path.join(root, 'council', 'extensions', 'account-launchers.json');
  const writeState = (text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  return { home, root, discover, dcm, file, writeState, discoveries: () => discoveries };
}

function team(f, overrides = {}) {
  const agents = overrides.agents ?? {};
  const launches = [];
  const deps = { tasks: () => ({ tasks: [] }), agents: () => agents, appendEvent() {}, publish() {}, team: {
    hiveRoot: () => f.root, launcherDiscovery: f.discover, setupComplete: () => true,
    modelCatalog: () => ({ version: 1, providers: { claude: [{ id: 'claude-fixture', label: 'Fixture' }] } }), appVersion: '0.5.5',
    defaultModel: () => undefined, orchestratorProvider: () => 'claude', orchestratorModel: () => undefined,
    orchestratorId: () => Object.keys(agents).find((id) => agents[id].isGod), hasLivePty: (id) => agents[id]?.live === true,
    defaultCommand: () => 'claude', autoMode: () => false, defaultCwd: () => f.home, isDirectory: () => true, commandAvailable: () => true,
    spawnHire: async (spawn) => { launches.push(spawn); agents[spawn.plan.agentId] = { isGod: spawn.isGod === true, name: spawn.plan.name, provider: spawn.provider, live: true }; return { ok: true }; },
    ...overrides.team
  } };
  return { deps, agents, launches, run: (cmd) => dispatchParamount(cmd, deps) };
}

test('P1: a set-up floor\'s snapshot state never runs launcher discovery', (t) => {
  const f = floor(t);
  let calls = 0;
  const deps = { launcherDiscovery: () => { calls++; return f.discover(); }, config: () => ({ onboardingComplete: true, harnessHome: f.home }), suggestedHome: () => f.home, engines: () => [] };
  for (let i = 0; i < 3; i++) assert.equal('launchers' in floorSetupState(deps), false);
  assert.equal(calls, 0);
  // While the setup screen shows, the injected discovery is read.
  const setup = floorSetupState({ ...deps, config: () => ({ onboardingComplete: false, harnessHome: null }) });
  assert.equal(setup.launchers.choices.map((c) => c.id).join(), 'dcm');
});

test('P1: launchers.refresh is the command that reruns discovery', async (t) => {
  const f = floor(t);
  let refreshed = 0;
  const tm = team(f, { team: { refreshLaunchers: () => { refreshed++; } } });
  assert.equal((await tm.run({ type: 'launchers.refresh' })).ok, true);
  assert.equal(refreshed, 1);
  assert.equal((await tm.run({ type: 'launchers.refresh', extra: 1 })).ok, false);
});

test('P1: one cached discovery; only a refresh reruns it', async (t) => {
  const f = floor(t);
  const cache = account.createLauncherDiscoveryCache(f.discover);
  let refreshed = 0;
  const tm = team(f, { team: { launcherDiscovery: () => cache.current(), refreshLaunchers: () => { refreshed++; cache.refresh(); } } });
  assert.equal((await tm.run({ type: 'team.models' })).ok, true);
  assert.equal((await tm.run({ type: 'team.models' })).ok, true);
  assert.equal(f.discoveries(), 1, 'screens read the cached result');
  assert.equal((await tm.run({ type: 'launchers.refresh' })).ok, true);
  assert.equal(refreshed, 1);
  assert.equal(f.discoveries(), 2);
  assert.equal((await tm.run({ type: 'launchers.refresh', extra: 1 })).ok, false);
});

test('P3: without an injected discovery, setup state and validation start no shell', () => {
  shells = 0;
  const deps = { config: () => ({ onboardingComplete: false, harnessHome: null }), suggestedHome: () => '/tmp/P', engines: () => [],
    ensureHome: () => ({ ok: true }), complete() {}, appendEvent() {}, publish() {} };
  floorSetupState(deps);
  floorSetupState({ ...deps, config: () => ({ onboardingComplete: true, harnessHome: '/tmp/x' }) });
  assert.equal(account.publicDiscovery().status, 'failed');
  assert.throws(() => account.validateLauncher({ id: 'dcm', fingerprint: 'a'.repeat(64) }, 'claude'), /discovered|Refresh/);
  const span = { cid: 'c', fail: (code, message) => ({ ok: false, error: { code, message } }) };
  const engines = () => [{ id: 'claude', label: 'Claude', orchestrator: true, installed: true, models: [] }];
  const temp = dispatchFloorSetup({ type: 'setup.complete', home: '/tmp/floor', engine: 'claude', tempLauncher: { id: 'dcm', fingerprint: 'a'.repeat(64) } }, { ...deps, engines }, span);
  assert.equal(temp.ok, false);
  assert.equal(shells, 0);
});

test('P2: claimFloor uses the runtime lock: a live holder keeps the floor', (t) => {
  const f = floor(t);
  // pid 1001 holds it and is alive, so pid 2002 cannot claim the floor.
  assert.equal(claimFloor(f.root, 1001, () => true), true);
  assert.equal(claimFloor(f.root, 2002, (pid) => pid === 1001), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, LOCK_FILE), 'utf8')).pid, 1001);
  // Once the holder is gone, the stale lock is taken over.
  assert.equal(claimFloor(f.root, 2002, () => false), true);
});

test('P2: a second live process on the floor keeps the orchestrator; ensure and hire refuse', async (t) => {
  const f = floor(t);
  let mine = false;
  const tm = team(f, { team: { claimFloor: () => mine } });
  const refused = await tm.run({ type: 'orchestrator.ensure' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code ?? refused.error?.code, 'CONFLICT');
  const hire = await tm.run({ type: 'agent.hire', orchestrator: true, confirm: true, manifest: { spec: 'munder-difflin/hire@1', name: 'Paramount' } });
  assert.equal(hire.ok, false);
  assert.equal(tm.launches.length, 0);
  // Not latched: once this process owns the floor, the next ensure starts it.
  mine = true;
  assert.equal((await tm.run({ type: 'orchestrator.ensure' })).ok, true);
  assert.equal(tm.launches.length, 1);
});

test('P2: a spawn discovers at most once, and not at all without a launcher', (t) => {
  const f = floor(t);
  const ordinary = { root: f.root, agentId: 'jim', provider: 'claude', isGod: false, isTemp: false };
  assert.equal(account.resolveLauncherForSpawn(ordinary, f.discover), undefined);
  assert.equal(f.discoveries(), 0);
  assert.equal(account.resolveLauncherForSpawn({ ...ordinary, explicit: f.dcm() }, f.discover).id, 'dcm');
  assert.equal(f.discoveries(), 1);
  // Spawns read the shared cache: one screen read plus two launcher spawns is one probe.
  const g = floor(t);
  const cache = account.createLauncherDiscoveryCache(g.discover);
  cache.current();
  for (let i = 0; i < 2; i++) assert.equal(account.resolveLauncherForSpawn({ ...ordinary, root: g.root, explicit: g.dcm() }, () => cache.current()).id, 'dcm');
  assert.equal(g.discoveries(), 1);
  // index.ts: spawnAgentCore hands the resolver the cache, never a fresh discovery, and never validates again.
  const code = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const syntax = require('typescript');
  const tree = syntax.createSourceFile('index.ts', code, syntax.ScriptTarget.Latest, true);
  const declaration = tree.statements.find((node) => syntax.isFunctionDeclaration(node) && node.name?.text === 'spawnAgentCore');
  assert.ok(declaration, 'the production spawn function exists');
  const core = declaration.getText(tree);
  assert.equal(core.includes('validateLauncher('), false);
  assert.doesNotMatch(core, /discoverLaunchers(Async)?\(/, 'no direct discovery call (the cache is built with the functions, not their results)');
  assert.match(core, /resolveLauncherForSpawn\([\s\S]*?\}, \(\) => launcherDiscovery\.current\(\)\);/);
});

test('P3: a bad launcher entry stops only the spawns that use it', async (t) => {
  const f = floor(t);
  const good = f.dcm();
  f.writeState(JSON.stringify({ version: 1, agents: { broken: { id: 'dcm', fingerprint: 'not-a-hash' }, kept: good } }));
  const spawn = (agentId, provider = 'claude') => account.resolveLauncherForSpawn({ root: f.root, agentId, provider, isGod: false, isTemp: false }, f.discover);
  assert.equal(spawn('plain'), undefined, 'an agent with no saved launcher starts');
  assert.equal(spawn('kept').id, 'dcm');
  assert.throws(() => spawn('broken'), /repair/);
  assert.equal(account.resolveLauncherForSpawn({ root: f.root, agentId: 'god', provider: 'claude', isGod: true, isTemp: false }, f.discover), undefined, 'the orchestrator has no saved launcher');
  // A later save keeps the bad entry as written, for the human to repair.
  account.saveLauncherPick(f.root, 'agent', good, 'plain');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).agents.broken, { id: 'dcm', fingerprint: 'not-a-hash' });
  // Screens get the readable picks only.
  const models = await team(f).run({ type: 'team.models' });
  assert.equal(models.ok, true);
  assert.deepEqual(Object.keys(models.models.launcherState.agents).sort(), ['kept', 'plain']);
  // An unreadable file cannot say who uses an account: Claude/Codex spawns stop, other engines start.
  f.writeState('{ not json');
  assert.equal(spawn('plain', 'gemini'), undefined);
  assert.throws(() => spawn('plain', 'claude'), /repair/);
});
