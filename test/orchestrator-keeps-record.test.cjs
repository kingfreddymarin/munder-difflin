'use strict';
// Incident 2026-11-12T1457 (addendum 15:10): Council restarted a floor's god on the floor's
// setup engine (gemini) while its registry entry said claude. The resume failed (exit 42 "No
// previous sessions found"), the exit archived the entry and the respawn had rewritten its
// provider to gemini and its role to "Paramount orchestrator". On a floor Council owns:
//   1. a registered orchestrator restarts on its recorded provider, model, name and role, and
//      its session id stays, so it resumes the same session;
//   2. a failed start (abnormal exit inside the start window) is reported and the entry is kept;
//   3. automatic startup does not retry a failed start.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { dispatchParamount } = loadTs('src/main/paramount.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { createOrchestratorStartWatch, ORCHESTRATOR_START_WINDOW_MS } = loadTs('src/main/orchestrator-start.ts');

const CATALOG = { version: 1, providers: {
  claude: [{ id: 'claude-opus-4-8', label: 'Opus 4.8' }],
  gemini: [{ id: 'gemini-pro', label: 'Gemini Pro' }],
} };

// A real HiveManager whose `god` is Munder's claude orchestrator with a recorded session; the
// floor setting (godProvider) says gemini, as on varium.
async function floor(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'council-god-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', role: 'Floor lead', isGod: true, cwd: home });
  hive.recordSession('god', '80f823ff-session');
  hive.setArchived('god', true); // not running: Council is about to start it
  const spawned = [];
  const team = {
    launcherDiscovery: () => ({ status: 'ok', choices: [], profiles: [] }),
    hiveRoot: () => path.join(home, 'hive'), modelCatalog: () => CATALOG, appVersion: '0.5.7',
    setupComplete: () => true, defaultModel: () => undefined,
    orchestratorProvider: () => 'gemini', orchestratorModel: () => 'gemini-pro',
    orchestratorId: () => hive.registry().godId ?? undefined,
    hasLivePty: () => false, defaultCommand: () => 'claude', autoMode: () => false,
    defaultCwd: () => home, isDirectory: (p) => fs.existsSync(p), commandAvailable: () => true,
    // As index.ts spawnHire: the plan becomes the registry meta for the spawn.
    spawnHire: async ({ plan, provider, isGod, resume }) => {
      spawned.push({ plan, provider, resume });
      await hive.ensureAgent({ id: plan.agentId, name: plan.name, provider, ...(plan.role ? { role: plan.role } : {}), ...(isGod ? { isGod: true } : {}), cwd: plan.cwd });
      return { ok: true };
    },
    ...overrides,
  };
  const deps = { tasks: () => ({ tasks: [] }), agents: () => hive.registry().agents, appendEvent() {}, publish() {}, logStep() {}, team };
  return { home, hive, team, deps, spawned };
}

test('ensure restarts a registered god on its recorded provider, name and role; the session id stays', async (t) => {
  const f = await floor(t);
  const r = await dispatchParamount({ type: 'orchestrator.ensure' }, f.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].provider, 'claude', 'not the floor setting (gemini)');
  assert.equal(f.spawned[0].resume, true);
  assert.equal(f.spawned[0].plan.engine, 'claude');
  assert.doesNotMatch(f.spawned[0].plan.command, /gemini/);
  assert.doesNotMatch(f.spawned[0].plan.command, /gemini-pro/, 'the gemini floor model is not applied to a claude god');
  const god = f.hive.registry().agents.god;
  assert.equal(god.provider, 'claude');
  assert.equal(god.role, 'Floor lead');
  assert.equal(god.name, 'Michael');
  assert.equal(god.sessionId, '80f823ff-session');
  assert.equal(f.hive.lastSession('god'), '80f823ff-session');
});

test('an explicit orchestrator start from Team also keeps the recorded engine and role', async (t) => {
  const f = await floor(t);
  const r = await dispatchParamount({ type: 'agent.hire', orchestrator: true, confirm: true, manifest: { spec: 'munder-difflin/hire@1', name: 'Paramount' } }, f.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(f.spawned[0].provider, 'claude');
  assert.equal(f.spawned[0].plan.role, 'Floor lead');
  assert.equal(f.spawned[0].plan.name, 'Michael');
  assert.deepEqual(
    (({ provider, role, name, sessionId }) => ({ provider, role, name, sessionId }))(f.hive.registry().agents.god),
    { provider: 'claude', role: 'Floor lead', name: 'Michael', sessionId: '80f823ff-session' });
});

test('a new orchestrator (none registered) still uses the floor setting and the Paramount role', async (t) => {
  const f = await floor(t);
  const reg = path.join(f.home, 'hive', 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ godId: null, agents: {} }));
  const r = await dispatchParamount({ type: 'orchestrator.ensure' }, { ...f.deps, team: { ...f.team, commandAvailable: () => true } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(f.spawned[0].provider, 'gemini');
  assert.equal(f.spawned[0].plan.role, 'Paramount orchestrator');
});

test('a registered god on an engine this app cannot start is refused and left unchanged', async (t) => {
  const f = await floor(t);
  const reg = path.join(f.home, 'hive', 'registry.json');
  const data = JSON.parse(fs.readFileSync(reg, 'utf8'));
  data.agents.god.provider = 'someday-cli';
  fs.writeFileSync(reg, JSON.stringify(data));
  const before = fs.readFileSync(reg, 'utf8');
  const r = await dispatchParamount({ type: 'agent.hire', orchestrator: true, confirm: true, manifest: { spec: 'munder-difflin/hire@1', name: 'Paramount' } }, f.deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_INPUT');
  assert.equal(f.spawned.length, 0);
  assert.equal(fs.readFileSync(reg, 'utf8'), before);
});

test('a failed resume is a reported start failure; a clean or late exit is not', () => {
  let clock = 1_000_000;
  const watch = createOrchestratorStartWatch(() => clock);
  watch.started('god', 'gemini', true);
  clock += 1200;
  const failure = watch.exited('god', 42, undefined);
  assert.ok(failure, 'exit 42 one second after start is a failed start');
  assert.equal(failure.exitCode, 42);
  assert.match(failure.message, /could not resume its session on gemini \(exit code 42\)/);
  assert.match(failure.message, /registry entry was left unchanged/);
  assert.deepEqual(watch.failure(), failure, 'kept for the snapshot banner');
  // A later successful start clears it.
  watch.started('god', 'claude', true);
  assert.equal(watch.failure(), null);
  // A clean exit, an exit after the start window and an agent Council did not start are normal exits.
  clock += 10; assert.equal(watch.exited('god', 0, undefined), null);
  watch.started('god', 'claude', true); clock += ORCHESTRATOR_START_WINDOW_MS + 1;
  assert.equal(watch.exited('god', 1, undefined), null);
  assert.equal(watch.exited('jim', 1, undefined), null);
  // A signal death inside the window counts (node-pty reports exit code 0 with a signal).
  watch.started('god', 'claude', false); clock += 5;
  assert.match(watch.exited('god', 0, 9).message, /stopped while starting on claude \(signal 9\)/);
});

test('automatic startup does not retry a failed start; it reports it', async (t) => {
  const f = await floor(t, { orchestratorStartFailure: () => ({ message: 'The orchestrator could not resume its session on claude (exit code 42).' }) });
  const r = await dispatchParamount({ type: 'orchestrator.ensure' }, f.deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONFLICT');
  assert.match(r.message, /could not resume/);
  assert.equal(f.spawned.length, 0);
});

test('index.ts: a failed orchestrator start is logged and its entry is not archived', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const syntax = require('typescript');
  const tree = syntax.createSourceFile('index.ts', code, syntax.ScriptTarget.Latest, true);
  const teardown = tree.statements.find((node) => syntax.isFunctionDeclaration(node) && node.name?.text === 'teardownPty');
  const options = teardown?.parameters.find((parameter) => parameter.name.getText(tree) === 'opts');
  assert.ok(options && syntax.isTypeLiteralNode(options.type), 'teardown has explicit lifecycle options');
  assert.ok(options.type.members.some((member) => member.name?.getText(tree) === 'keepEntry' && member.questionToken && member.type?.kind === syntax.SyntaxKind.BooleanKeyword), 'keepEntry remains an optional boolean regardless of additional lifecycle options');
  assert.match(code, /if \(hive\.enabled\(\) && !opts\.keepEntry\) \{\s*try \{ hive\.setArchived\(agentId, true\);/);
  const exit = code.slice(code.indexOf('ptyManager.setExitHandler('));
  const watched = exit.indexOf('orchestratorStart.exited(');
  assert.ok(watched > 0 && watched < exit.indexOf('teardownPty(id, { keepEntry: !!failedStart || allowQuit });'), 'the exit is checked before teardown');
  assert.match(exit, /kind: 'paramount-error', errorId: newErrorId\(\), op: 'orchestrator\.start'/);
  assert.match(code, /orchestratorStart\.started\(plan\.agentId, provider, res\.resumed === true, priorArchived\)/);
  assert.match(exit, /if \(failedStart\?\.priorArchived !== undefined\) restoreArchived\(failedStart\.agentId, failedStart\.priorArchived\);/);
  // Found in the isolated real-app check of 2c450de6: without this the banner never appeared.
  assert.match(exit, /if \(failedStart\) broadcastParamountInvalidation\('orchestrator-start-failed'\);/);
  const project = require('./snapshot-failure-fixture.cjs');
  const failure = { message: 'synthetic startup failure', agentId: 'god' };
  const present = project(failure);
  assert.equal(present.result.orchestratorFailure, failure);
  assert.equal(present.reads, 1);
  const absent = project(null);
  assert.equal(Object.hasOwn(absent.result, 'orchestratorFailure'), false);
  assert.equal(absent.reads, 1);
  assert.match(code, /orchestratorStartFailure: \(\) => orchestratorStart\.failure\(\)/);
});

// Re-review R4: a failed PTY allocation (spawnHire's !res.ok branch) still archived an existing god.
// Runs the real spawnHire callback, restoreArchived and teardownPty from index.ts with a real
// HiveManager; only the spawn core is stubbed (it provisions the entry, then fails to allocate).
function indexPieces(hive, spawnCore) {
  const code = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const cut = (from, to) => { const a = code.indexOf(from); const b = code.indexOf(to, a); return code.slice(a, b + to.length); };
  const restore = cut('function restoreArchived(', '\n}\n');
  const teardown = cut('function teardownPty(', '\n}\n');
  const hire = cut('spawnHire: async (', '      return { ok: true };\n    }');
  const src = `${restore}\n${teardown}\nconst deps = { ${hire} };\nmodule.exports = deps;`;
  const ts = require('typescript');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const ptyToAgent = new Map();
  const noop = () => {};
  const ctx = { module: { exports: {} }, console, hive, ptyToAgent, ptySignInAccount: new Map(), ptyLaunchIdentity: new Map(), liveWorkers: new Map(), worktreePaths: new Map(), worktreeOrigins: new Map(),
    paramountOrchestrators: new Set(), integrationBroker: { revoke: noop }, workerWake: { forget: noop }, breaker: { forget: noop },
    telemetry: { forgetAgent: noop }, grokLedgerGate: { forget: noop }, orchestratorStart: createOrchestratorStartWatch(),
    saveLauncherPick: noop, paramountLog: noop, broadcastParamountInvalidation: noop, syncKeepAwake: noop, liveWebContents: () => null, finalizeWorkerWorktree: noop, removeWorktree: async () => ({}), newErrorId: () => 'E-test', setAgentTokenCap: noop, sender: null,
    spawnAgentCore: async (o) => { await hive.ensureAgent(o.hive); ptyToAgent.set(o.id, o.id); return spawnCore(o); } };
  require('node:vm').runInNewContext(js, ctx);
  return ctx.module.exports;
}

for (const [label, priorArchived] of [['a live shared god (Munder\'s)', false], ['a stopped god', true]]) {
  test(`R4: a failed PTY allocation leaves ${label} exactly as it was`, async (t) => {
    const f = await floor(t);
    f.hive.setArchived('god', priorArchived);
    const before = f.hive.registry().agents.god;
    const deps = indexPieces(f.hive, async () => ({ ok: false, error: 'PTY allocation failed' }));
    const plan = { agentId: 'god', name: 'Michael', role: 'Floor lead', engine: 'claude', cwd: f.home, isolate: false };
    const r = await deps.spawnHire({ plan, bin: 'claude', args: [], provider: 'claude', isGod: true, resume: true, launcher: undefined }, 'cid');
    assert.equal(r.ok, false);
    const god = f.hive.registry().agents.god;
    assert.equal(god.archived, priorArchived, 'archived flag as before the start');
    for (const k of ['provider', 'role', 'name', 'sessionId', 'isGod']) assert.equal(god[k], before[k], k);
  });
}

test('R4: a NEW orchestrator whose allocation fails is still rolled back to stopped', async (t) => {
  const f = await floor(t);
  const reg = path.join(f.home, 'hive', 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ godId: null, agents: {} }));
  const deps = indexPieces(f.hive, async () => ({ ok: false, error: 'PTY allocation failed' }));
  const plan = { agentId: 'god', name: 'Paramount', role: 'Paramount orchestrator', engine: 'claude', cwd: f.home, isolate: false };
  assert.equal((await deps.spawnHire({ plan, bin: 'claude', args: [], provider: 'claude', isGod: true, resume: true }, 'cid')).ok, false);
  assert.equal(f.hive.registry().agents.god.archived, true);
});
