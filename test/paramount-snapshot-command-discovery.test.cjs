'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

function loadProduction() {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'node-pty') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const loadTs = require('./load-ts.cjs');
    return {
      PtyManager: loadTs('src/main/pty.ts').PtyManager,
      discovery: loadTs('src/main/snapshotCommandDiscovery.ts'),
      createSignInMonitor: loadTs('src/main/engine-signin.ts').createSignInMonitor
    };
  } finally { Module._load = originalLoad; }
}

test('snapshot tool checks and sign-in monitor path stay nonblocking while cold discovery is pending', async () => {
  const { discovery: api, createSignInMonitor } = loadProduction();
  const originalSpawnSync = cp.spawnSync;
  let syncCalls = 0;
  cp.spawnSync = (...args) => { syncCalls++; return originalSpawnSync(...args); };
  const releaseProbes = [];
  const updates = [];
  let probes = 0;
  const cache = api.createSnapshotCommandDiscovery({
    probe: () => { probes++; return new Promise((resolve) => { releaseProbes.push(resolve); }); },
    fallback: () => null,
    onChange: (command, result) => updates.push([command, result.state])
  });
  const monitor = createSignInMonitor({ path: (engine) => cache.get(engine).path, run: async () => ({ code: 0 }) });
  try {
    const tools = api.snapshotCommandTools(cache, false);
    const overlapping = api.snapshotCommandTools(cache, false);
    const signInPath = api.snapshotSignInPath(cache, 'claude');
    const signIn = monitor.status('claude');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual([tools.claude.state, tools.codex.state, tools.mempalace.state], ['checking', 'checking', 'checking']);
    assert.deepEqual([overlapping.claude.state, overlapping.codex.state, overlapping.mempalace.state], ['checking', 'checking', 'checking']);
    assert.equal(signInPath, null);
    assert.equal(signIn.state, 'unknown');
    assert.equal(syncCalls, 0, 'snapshot and sign-in callback make no synchronous subprocess call');
    assert.equal(probes, 3, 'the monitor reuses the pending Claude probe');
    let sentinelRan = false;
    setTimeout(() => { sentinelRan = true; }, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(sentinelRan, true, 'event-loop sentinel runs while discovery is still unresolved');
    for (const release of releaseProbes) release({ path: null, reliable: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cache.peek('claude').state, 'missing');
    assert.equal(cache.peek('codex').state, 'missing');
    assert.equal(cache.peek('mempalace').state, 'missing');
    assert.deepEqual(updates.sort(), [['claude', 'missing'], ['codex', 'missing'], ['mempalace', 'missing']]);
    assert.equal(syncCalls, 0);
  } finally { cp.spawnSync = originalSpawnSync; }
});

test('concurrent snapshots dedupe discovery and rejected probes use bounded backoff with unknown state', async () => {
  const { discovery: api } = loadProduction();
  let calls = 0;
  let now = 1000;
  const cache = api.createSnapshotCommandDiscovery({
    probe: async () => { calls++; throw new Error('synthetic probe failure'); }, fallback: () => null, now: () => now
  });
  assert.equal(cache.get('claude').state, 'checking');
  assert.equal(cache.get('claude').state, 'checking');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(cache.peek('claude').state, 'unknown');
  assert.equal(cache.get('claude').state, 'unknown');
  assert.equal(calls, 1, 'snapshot polls respect retry backoff');
  now += 1000;
  assert.equal(cache.get('claude').state, 'checking');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  assert.equal(cache.peek('claude').state, 'unknown');
});

test('unsafe command names are rejected before background probing', () => {
  const { discovery: api } = loadProduction();
  let calls = 0;
  const cache = api.createSnapshotCommandDiscovery({
    probe: async () => { calls++; return { path: null, reliable: true }; }, fallback: () => null
  });
  assert.deepEqual(cache.get('claude;touch x'), { path: null, state: 'missing' });
  assert.equal(calls, 0);
});

test('explicit commandPath retry sees a CLI installed after an earlier miss', () => {
  const { PtyManager } = loadProduction();
  const root = fs.mkdtempSync('/private/tmp/paramount-command-retry-');
  const bin = path.join(root, 'fresh-cli');
  const previousShell = process.env.SHELL;
  const originalExistsSync = fs.existsSync;
  const originalSpawnSync = cp.spawnSync;
  let installed = false;
  process.env.SHELL = '/synthetic/retry-shell-never-executed';
  fs.existsSync = (candidate) => typeof candidate === 'string' && candidate.startsWith(`${root}${path.sep}`) && installed ? originalExistsSync(candidate) : false;
  cp.spawnSync = (_exe, args, options) => {
    assert.equal(options.timeout, 3000);
    return installed
      ? { stdout: `__MD_SHELL_FENCE__${bin}__MD_SHELL_FENCE__`, status: 0 }
      : { stdout: '', status: null, error: Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' }) };
  };
  try {
    const manager = new PtyManager();
    assert.equal(manager.commandPath('fresh-cli'), null);
    fs.writeFileSync(bin, '# synthetic fixture\n');
    installed = true;
    assert.equal(manager.commandPath('fresh-cli'), bin, 'explicit retry sees the newly installed command');
  } finally {
    fs.existsSync = originalExistsSync;
    cp.spawnSync = originalSpawnSync;
    if (previousShell === undefined) delete process.env.SHELL; else process.env.SHELL = previousShell;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('confirmed missing command can be force-refreshed after install and become ready', async () => {
  const { discovery: api } = loadProduction();
  const root = fs.mkdtempSync('/private/tmp/paramount-command-discovery-');
  const bin = path.join(root, 'claude');
  let installed = false;
  let calls = 0;
  const cache = api.createSnapshotCommandDiscovery({
    probe: async () => { calls++; return installed ? { path: bin, reliable: true } : { path: null, reliable: true }; },
    fallback: () => null
  });
  try {
    assert.equal(cache.get('claude').state, 'checking');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cache.peek('claude').state, 'missing');
    installed = true;
    fs.writeFileSync(bin, '# synthetic executable\n');
    const resolutionPromise = cache.resolve('claude', true);
    assert.equal(cache.peek('claude').state, 'checking');
    assert.deepEqual(await resolutionPromise, { path: bin, state: 'ready' });
    assert.equal(calls, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('production login-shell probe uses asynchronous spawn and accepts only fenced output', async (t) => {
  if (process.platform === 'win32') return t.skip('login-shell probe is the non-Windows path');
  const { discovery: api } = loadProduction();
  const originalSpawn = cp.spawn;
  const originalSpawnSync = cp.spawnSync;
  let syncCalls = 0;
  let spawnArgs;
  cp.spawnSync = (...args) => { syncCalls++; return originalSpawnSync(...args); };
  cp.spawn = (exe, args, options) => {
    spawnArgs = { exe, args, options };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.emit('data', 'login startup noise\n__MD_SHELL_FENCE__/synthetic/bin/claude\n__MD_SHELL_FENCE__');
      child.emit('close', 0);
    });
    return child;
  };
  try {
    const result = await api.probeLoginShellCommand('claude');
    assert.deepEqual(result, { path: '/synthetic/bin/claude', reliable: true });
    assert.match(spawnArgs.exe, /zsh/);
    assert.equal(spawnArgs.args[0], '-ilc');
    assert.match(spawnArgs.args[1], /which claude/);
    assert.equal(spawnArgs.options.stdio[0], 'ignore');
    assert.equal(syncCalls, 0);
  } finally { cp.spawn = originalSpawn; cp.spawnSync = originalSpawnSync; }
});

test('production login-shell probe times out and kills the child without a synchronous subprocess', async (t) => {
  if (process.platform === 'win32') return t.skip('login-shell probe is the non-Windows path');
  const { discovery: api } = loadProduction();
  const originalSpawn = cp.spawn;
  const originalSpawnSync = cp.spawnSync;
  let killed = false;
  let syncCalls = 0;
  cp.spawnSync = (...args) => { syncCalls++; return originalSpawnSync(...args); };
  cp.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => { killed = true; return true; };
    return child;
  };
  try {
    const result = await api.probeLoginShellCommand('claude');
    assert.deepEqual(result, { path: null, reliable: false });
    assert.equal(killed, true);
    assert.equal(syncCalls, 0);
  } finally { cp.spawn = originalSpawn; cp.spawnSync = originalSpawnSync; }
});

test('production login-shell probe abort kills its child during memory shutdown', async (t) => {
  if (process.platform === 'win32') return t.skip('login-shell probe is the non-Windows path');
  const { discovery: api } = loadProduction();
  const originalSpawn = cp.spawn;
  let killed = false;
  let child;
  cp.spawn = () => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => { killed = true; return true; };
    return child;
  };
  const controller = new AbortController();
  try {
    const resultPromise = api.probeLoginShellCommand('mempalace', controller.signal);
    controller.abort();
    assert.deepEqual(await resultPromise, { path: null, reliable: false });
    assert.equal(killed, true);
  } finally { cp.spawn = originalSpawn; }
});

test('snapshot tools preserve unknown separately from confirmed missing', () => {
  const { discovery: api } = loadProduction();
  const ts = require('typescript');
  const source = fs.readFileSync('ui/src/data/external-tools.ts', 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} }; new Function('module', 'exports', 'require', js)(mod, mod.exports, () => ({}));
  const pending = mod.exports.externalTools({ claude: { path: null, state: 'checking' }, mempalace: { path: null, state: 'missing' } });
  assert.equal(pending.find((item) => item.id === 'claude-cli').state, 'unknown');
  assert.equal(pending.find((item) => item.id === 'mempalace').state, 'missing');
  assert.equal(api.createSnapshotCommandDiscovery !== undefined, true);
});

test('the actual IPC snapshot uses the nonblocking projection and never commandPath for these tools', () => {
  const source = fs.readFileSync('src/main/index.ts', 'utf8');
  const start = source.indexOf("ipcMain.handle('paramount:snapshot'");
  const end = source.indexOf("}, { rethrow: true, quiet: true }));", start);
  assert.ok(start >= 0 && end > start);
  const snapshot = source.slice(start, end);
  assert.match(snapshot, /snapshotCommandTools\(snapshotCommandDiscovery/);
  assert.match(snapshot, /installedSnapshotEngines\(snapshotCommandDiscovery\)/);
  assert.doesNotMatch(snapshot, /ptyManager\.commandPath\('(claude|codex|mempalace)'\)/);
  const monitor = source.slice(source.indexOf('const engineSignIn ='), source.indexOf('function paramountCheckEngineSignIn'));
  assert.match(monitor, /snapshotSignInPath\(snapshotCommandDiscovery, engine\)/);
});
