'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function productionHelpers() {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'node-pty') return {}; // no PTY is spawned in this fixture
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('./load-ts.cjs')];
    const loadTs = require('./load-ts.cjs');
    return {
      PtyManager: loadTs('src/main/pty.ts').PtyManager,
      createSnapshotStageTimer: loadTs('src/main/paramountSnapshotTiming.ts').createSnapshotStageTimer,
      createSignInMonitor: loadTs('src/main/engine-signin.ts').createSignInMonitor,
      traced: loadTs('src/main/paramountObservability.ts').traced,
      startLagProbe: loadTs('src/main/lag-probe.ts').startLagProbe
    };
  } finally { Module._load = originalLoad; }
}

async function runSnapshotScenario(mode) {
  const { PtyManager, createSnapshotStageTimer, createSignInMonitor, traced, startLagProbe } = productionHelpers();
  const root = fs.mkdtempSync('/private/tmp/paramount-command-resolution-');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  for (const name of ['claude', 'codex', 'mempalace']) fs.writeFileSync(path.join(binDir, name), '# synthetic fixture\n');
  const previousShell = process.env.SHELL;
  process.env.SHELL = '/synthetic/fake-login-shell-never-executed';

  const originalExistsSync = fs.existsSync;
  const originalSpawnSync = cp.spawnSync;
  let calls = 0;
  let statusCalls = 0;
  const fakeByName = Object.fromEntries(['claude', 'codex', 'mempalace'].map((name) => [name, path.join(binDir, name)]));
  fs.existsSync = (candidate) => typeof candidate === 'string' && candidate.startsWith(`${binDir}${path.sep}`) ? originalExistsSync(candidate) : false;
  cp.spawnSync = (_exe, args, options) => {
    calls++;
    assert.equal(options.timeout, 3000, 'fixture observes the production 3-second shell-probe timeout');
    const script = String(args.at(-1) ?? '');
    const match = /which ([A-Za-z0-9._+-]+)/.exec(script);
    assert.ok(match, `expected production which script, got ${script}`);
    if (mode === 'failed') {
      // Wait inside the injected spawnSync boundary to model a slow failed shell
      // capture. No shell executable or user startup file runs.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 125);
      return { stdout: '', status: null, error: Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' }) };
    }
    if (mode === 'empty') return { stdout: '__MD_SHELL_FENCE____MD_SHELL_FENCE__', status: 0 };
    const command = match[1];
    return { stdout: `__MD_SHELL_FENCE__${fakeByName[command]}__MD_SHELL_FENCE__`, status: 0 };
  };

  const manager = new PtyManager();
  const stageEvents = [];
  const lagEvents = [];
  const stageTimer = createSnapshotStageTimer({ now: () => performance.now(), log: (event) => stageEvents.push(event), thresholdMs: 100 });
  const stopLag = startLagProbe({ now: () => Date.now(), log: (event) => lagEvents.push(event), intervalMs: 10, thresholdMs: 30 });
  const signIn = createSignInMonitor({
    path: (engine) => manager.commandPath(engine),
    run: () => { statusCalls++; return new Promise((resolve) => setTimeout(() => resolve({ code: 0 }), 80)); }
  });
  const request = async () => traced('paramount.snapshot', () => {}, {}, async (span) => {
    const engineStarted = performance.now();
    const enginePaths = stageTimer.measure(span.cid, 'enginePaths', () => ({
      claude: manager.commandPath('claude'),
      codex: manager.commandPath('codex'),
      // Production checks requiredness between codex and mempalace lookup.
      codexRequired: false,
      mempalace: manager.commandPath('mempalace')
    }));
    const enginePathsMs = performance.now() - engineStarted;
    const statusStarted = performance.now();
    const signInState = stageTimer.measure(span.cid, 'signIn', () => Object.fromEntries(
      (['claude', 'codex']).filter((engine) => manager.commandPath(engine)).map((engine) => [engine, signIn.status(engine)])
    ));
    return { enginePaths, enginePathsMs, signInState, signInMs: performance.now() - statusStarted };
  }, { quiet: true });

  let first; let warm; let firstCalls; let firstStageEvents; let failedElapsedMs;
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const started = performance.now();
    first = await request();
    failedElapsedMs = performance.now() - started;
    firstCalls = calls;
    firstStageEvents = [...stageEvents];
    await new Promise((resolve) => setTimeout(resolve, 15));
    warm = await request();
  } finally {
    fs.existsSync = originalExistsSync;
    cp.spawnSync = originalSpawnSync;
    if (previousShell === undefined) delete process.env.SHELL; else process.env.SHELL = previousShell;
  }
  try { await new Promise((resolve) => setTimeout(resolve, 100)); }
  finally { stopLag(); fs.rmSync(root, { recursive: true, force: true }); }
  return {
    firstCalls, warmCalls: calls, paths: first.enginePaths, enginePathsMs: first.enginePathsMs,
    signInCalls: statusCalls, signInState: Object.values(first.signInState)[0]?.state ?? 'no installed command',
    signInMs: first.signInMs, failedElapsedMs, stageEvents: firstStageEvents,
    lagEvents: lagEvents.filter((event) => /paramount\.snapshot/.test(String(event.op))),
    warmEnginePathsMs: warm.enginePathsMs,
    warmStatusState: Object.values(warm.signInState)[0]?.state ?? 'no installed command'
  };
}

function printResult(mode, result) {
  if (process.env.REPRO_SNAPSHOT_COMMAND_RESOLUTION !== '1') return;
  console.log(`[fixture:${mode}] ${JSON.stringify({
    firstSnapshotShellCalls: result.firstCalls,
    warmSnapshotTotalShellCalls: result.warmCalls,
    firstSnapshotEnginePathSyncMs: Number(result.enginePathsMs.toFixed(1)),
    firstSnapshotSignInPathSyncMs: Number(result.signInMs.toFixed(1)),
    failedSnapshotSyncMs: Number(result.failedElapsedMs.toFixed(1)),
    found: Object.fromEntries(Object.entries(result.paths).map(([name, value]) => [name, Boolean(value)])),
    signInStatus: result.signInState,
    stageEvents: result.stageEvents,
    lagEvents: result.lagEvents
  })}`);
}

test('cold successful discovery is reused for warm snapshots; sign-in status does not block', async () => {
  const result = await runSnapshotScenario('success');
  printResult('success', result);
  assert.equal(result.firstCalls, 3, 'one successful capture per unique binary');
  assert.equal(result.warmCalls, 3, 'warm snapshot launches no more shells');
  assert.ok(result.paths.claude.endsWith('/bin/claude'));
  assert.ok(result.paths.codex.endsWith('/bin/codex'));
  assert.ok(result.paths.mempalace.endsWith('/bin/mempalace'));
  assert.equal(result.signInCalls, 2, 'status probes use only the injected asynchronous runner');
  assert.equal(result.signInState, 'unknown', 'status returns before its pending checks finish');
  assert.ok(result.signInMs < 50, `status path blocked ${result.signInMs} ms`);
});

test('successful empty shell captures are cached for repeated missing commands', async () => {
  const result = await runSnapshotScenario('empty');
  printResult('empty', result);
  assert.equal(result.firstCalls, 3);
  assert.equal(result.warmCalls, 3);
  assert.deepEqual(result.paths, { claude: null, codex: null, codexRequired: false, mempalace: null });
  assert.deepEqual(result.stageEvents, [], 'fast empty captures stay quiet');
});

test('failed shell captures retry synchronously at every snapshot commandPath boundary', async () => {
  const result = await runSnapshotScenario('failed');
  printResult('failed', result);
  assert.equal(result.firstCalls, 5, 'three engine-path checks plus Claude/Codex sign-in path checks');
  assert.equal(result.warmCalls, 10, 'failed captures repeat on a later snapshot');
  assert.ok(result.stageEvents.some((event) => event.stage === 'enginePaths' && event.syncMs >= 300 && event.waitMs === 0));
  assert.ok(result.stageEvents.some((event) => event.stage === 'signIn' && event.syncMs >= 200 && event.waitMs === 0));
  assert.ok(result.lagEvents.some((event) => event.kind === 'paramount-lag' && event.ms >= 400 && /paramount\.snapshot/.test(event.op)));
  assert.ok(result.failedElapsedMs >= 500, `expected repeated synchronous stalls; got ${result.failedElapsedMs} ms`);
  assert.equal(result.signInCalls, 0, 'missing paths never start provider status checks');
});
