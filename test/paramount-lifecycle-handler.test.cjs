'use strict';
// Run from the product checkout. Executes the production callback bodies,
// with real PTYs and synthetic provisioning/storage boundaries; no Electron GUI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const { createRequire } = require('node:module');
const fromRepo = createRequire(path.join(process.cwd(), 'package.json'));
const ts = fromRepo('typescript');
const loadTs = fromRepo('./test/load-ts.cjs');
const { PtyManager } = loadTs('src/main/pty.ts');
const lifecycle = loadTs('src/main/paramount-engine-switch.ts');
const source = process.env.PARAMOUNT_REVIEW_REV
  ? cp.execFileSync('git', ['show', `${process.env.PARAMOUNT_REVIEW_REV}:src/main/index.ts`], { encoding: 'utf8' })
  : fs.readFileSync('src/main/index.ts', 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'paramountTeamDeps');
assert.ok(fn, 'production dependency factory exists');
const returned = fn.body.statements.find(ts.isReturnStatement).expression;
const names = ['switchAgent', 'restartAgent'];
const callbacks = names.map((name) => {
  const prop = returned.properties.find((p) => p.name?.getText(ast) === name);
  assert.ok(prop && ts.isPropertyAssignment(prop), `${name} callback exists`);
  return `${name}: ${prop.initializer.getText(ast)}`;
});
const js = ts.transpileModule(`({${callbacks.join(',')}})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

async function scenario(firstKind, secondKind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-handler-review-'));
  const agentId = `fixture-${firstKind}-${secondKind}`;
  const manager = new PtyManager();
  const ptyToAgent = new Map([[agentId, agentId]]);
  const row = { id: agentId, name: 'Fixture', provider: 'claude', role: 'worker', cwd: root, archived: false };
  let model = { engine: 'claude', model: 'old-model' };
  let launcher = null;
  let session = 'old-claude-session';
  let spawnCalls = 0;
  let killed = 0;
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  const originalKill = manager.kill.bind(manager);
  manager.kill = (id) => { killed++; return originalKill(id); };
  const startShell = () => manager.spawn({ id: agentId, cwd: root, command: '/bin/sh', args: ['-c', 'read line'] });
  assert.equal(startShell().ok, true, 'fixture old shell starts');
  const ctx = {
    ...lifecycle,
    hive: {
      root: () => root,
      enabled: () => true,
      registry: () => ({ agents: { [agentId]: { ...row } } }),
      lastSession: () => session,
      setAgentProvider: (_id, provider) => { row.provider = provider; return { ok: true }; },
      ensureAgent: async (meta, options) => { Object.assign(row, meta); session = options.sessionId ?? session; },
      send: () => {}
    },
    claimFloor: () => true,
    ptyManager: manager,
    ptyToAgent,
    ptyLaunchIdentity: new Map([[agentId, {provider: 'claude', model: 'old-model', launcher: null}]]),
    engineSignIn: {refresh: async () => ({state: 'signed-in'})},
    worktreePaths: new Map(),
    statSync: fs.statSync,
    join: path.join,
    readConfig: () => ({}),
    readAgentModels: () => ({ [agentId]: { ...model } }),
    agentModelPick: () => model.model,
    readLauncherState: () => ({ agents: { [agentId]: launcher } }),
    launcherDiscovery: { current: () => ({ launchers: [] }) },
    buildWorkerLaunch: () => ({ bin: '/bin/sh', args: [] }),
    teardownPty: (id) => { ptyToAgent.delete(id); },
    restoreArchived: (_id, value) => { row.archived = value; },
    saveAgentModelPick: (_root, _id, engine, value) => { model = { engine, model: value }; },
    saveLauncherPick: (_root, _scope, pick) => { launcher = pick; },
    sender: { send: () => {} },
    spawnAgentCore: async (opts) => {
      spawnCalls++;
      if (spawnCalls === 1) { entered(); await gate; }
      const result = startShell();
      if (result.ok) {
        row.provider = opts.provider;
        session = opts.resume ? 'old-claude-session' : null;
        ptyToAgent.set(agentId, agentId);
        if (opts.provider === 'codex') assert.equal(opts.resume, false, 'target receives no old-provider session');
      }
      return { ...result, resumed: opts.resume === true };
    }
  };
  const handlers = vm.runInNewContext(js, ctx);
  const invoke = (kind) => kind === 'switch'
    ? handlers.switchAgent(agentId, { provider: 'codex', model: 'new-model', launcher: null })
    : handlers.restartAgent(agentId, 'fresh');
  let first;
  try {
    first = invoke(firstKind);
    await ready;
    const contender = await invoke(secondKind);
    assert.equal(contender.ok, false, 'concurrent contender rejected');
    assert.match(contender.error ?? '', /already running/, 'contender rejected before provisioning');
    assert.equal(spawnCalls, 1, 'contender never enters target provisioning');
    assert.equal(killed, 1, 'only the original session was stopped');
    release();
    assert.equal((await first).ok, true, 'first operation succeeds');
    assert.equal(manager.list().length, 1, 'exactly one process survives');
    assert.equal(row.provider, firstKind === 'switch' ? 'codex' : 'claude');
    assert.equal(model.engine, firstKind === 'switch' ? 'codex' : 'claude');
    assert.equal(await lifecycle.withAgentLifecycleLock(agentId, async () => 'released'), 'released');
    console.log(JSON.stringify({ first: firstKind, contender: secondKind, rejectedBeforeSpawn: true, liveProcesses: 1, provider: row.provider }));
  } finally {
    release();
    if (first) await first.catch(() => {});
    for (const pty of manager.list()) originalKill(pty.id);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

require('node:test')('production lifecycle handlers reject all four overlapping switch/restart combinations', { skip: process.platform === 'win32' }, async () => {
  for (const pair of [['switch', 'switch'], ['switch', 'restart'], ['restart', 'switch'], ['restart', 'restart']]) await scenario(...pair);
});
