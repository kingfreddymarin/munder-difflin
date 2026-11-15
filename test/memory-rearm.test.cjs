'use strict';

/**
 * Semantic memory must not be stuck on "getting ready" until the app restarts.
 *
 * start() runs once at boot and bails when mempalace isn't on PATH. Installing
 * it afterwards — the usual order, since the settings panel is where you learn
 * you need it — left nothing to re-invoke start(), so the mine loop never ran,
 * the palace (created by the first mine) never appeared, and the pill read
 * "On — getting ready…" forever while `available` correctly read true.
 *
 * The status poll notices the install, so the poll is what arms the loop.
 * The startup resolver is injected so these lifecycle checks do not depend on
 * whether the developer happens to have mempalace installed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const cp = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');

/** A manager over an empty temp home whose CLI resolution we control. */
function managerWithCli(t, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-'));
  const state = { bin: opts.bin ?? null, enabled: opts.enabled !== false };
  const memory = new MemoryManager(() => home, () => ({ enabled: state.enabled, model: 'minilm' }), async () => state.bin);
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return { memory, state, home };
}

/** The mine loop is armed exactly when its interval handle exists. */
const armed = (memory) => memory.mineTimer !== null;

test('a poll before mempalace is installed reports "not available" and arms nothing', async (t) => {
  const { memory } = managerWithCli(t);

  const status = await memory.refresh();

  assert.equal(status.available, false);
  assert.equal(status.active, false);
  assert.equal(armed(memory), false);
});

test('a poll AFTER mempalace appears arms the mine loop that boot had to skip', async (t) => {
  const { memory, state } = managerWithCli(t);

  memory.start();                    // boot: mempalace not installed yet
  assert.equal(armed(memory), false, 'nothing to start');

  state.bin = '/fake/bin/mempalace'; // the user installs it while the app runs
  const status = await memory.refresh();

  assert.equal(status.available, true);
  assert.equal(status.active, true);
  assert.equal(armed(memory), true, 'this is what left the pill on "getting ready" forever');
});

test('polling again never starts a second mine loop', async (t) => {
  const { memory } = managerWithCli(t, { bin: '/fake/bin/mempalace' });

  await memory.refresh();
  const first = memory.mineTimer;
  await memory.refresh();
  await memory.refresh();

  assert.equal(memory.mineTimer, first, 'the palace permits a single writer — one loop only');
});

test('memory turned off in settings stays off however often it is polled', async (t) => {
  const { memory } = managerWithCli(t, { bin: '/fake/bin/mempalace', enabled: false });

  const status = await memory.refresh();

  assert.equal(status.available, true, 'the CLI is there…');
  assert.equal(status.enabled, false, '…but the user said no');
  assert.equal(armed(memory), false);
});

test('start returns without sync resolution, dedupes cold probes, and allows event-loop progress', async (t) => {
  let resolveProbe;
  let probes = 0;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-async-'));
  const memory = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm' }), () => {
    probes++;
    return new Promise((resolve) => { resolveProbe = resolve; });
  });
  memory.bin = () => { throw new Error('startup invoked synchronous bin lookup'); };
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });

  memory.start();
  memory.start();
  const refresh = memory.refresh();
  assert.equal(probes, 0, 'resolver is deferred off the synchronous startup stack');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1, 'repeated starts share one in-flight probe');
  let eventLoopProgress = false;
  setImmediate(() => { eventLoopProgress = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventLoopProgress, true, 'event loop runs while command discovery remains pending');
  resolveProbe('/fake/bin/mempalace');
  await memory.binProbe;
  const status = await refresh;
  assert.equal(status.available, true);
  assert.equal(armed(memory), true);
});

test('production MemoryManager.start uses async login-shell discovery without spawnSync', async (t) => {
  if (process.platform === 'win32') return t.skip('production test uses the POSIX login-shell resolver');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-production-'));
  const memory = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm' }));
  const originalSpawn = cp.spawn;
  const originalSpawnSync = cp.spawnSync;
  let syncCalls = 0;
  let spawnCalls = 0;
  cp.spawnSync = (...args) => { syncCalls++; return originalSpawnSync(...args); };
  cp.spawn = (_exe, _args, options) => {
    spawnCalls++;
    assert.equal(options.stdio[0], 'ignore');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.emit('data', `__MD_SHELL_FENCE__${process.execPath}\n__MD_SHELL_FENCE__`);
      child.emit('close', 0);
    });
    return child;
  };
  t.after(() => {
    memory.stop();
    cp.spawn = originalSpawn;
    cp.spawnSync = originalSpawnSync;
    fs.rmSync(home, { recursive: true, force: true });
  });

  memory.start();
  assert.equal(syncCalls, 0);
  assert.equal(spawnCalls, 0, 'subprocess construction is deferred out of start()');
  let eventLoopRan = false;
  setImmediate(() => { eventLoopRan = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventLoopRan, true);
  await memory.binProbe;
  assert.equal(spawnCalls, 1);
  assert.equal(syncCalls, 0, 'startup discovery never calls spawnSync');
  assert.equal(memory.binCache, process.execPath);
  assert.equal(armed(memory), true);
});

test('failed resolution is cached until explicit refresh retries after installation', async (t) => {
  let probes = 0;
  let installed = false;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-retry-'));
  const memory = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm' }), async () => {
    probes++;
    if (!installed) throw new Error('synthetic probe failure');
    return '/fake/bin/mempalace';
  });
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });

  memory.start();
  await memory.binProbe;
  memory.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1, 'failed startup probe is not retried on every start');
  assert.equal(armed(memory), false);
  installed = true;
  const status = await memory.refresh();
  assert.equal(status.available, true);
  assert.equal(status.active, true);
  assert.equal(probes, 2, 'explicit refresh retries so a post-launch install is noticed');
  assert.equal(armed(memory), true);
});

test('stop aborts cold discovery and prevents a late result from arming mining', async (t) => {
  let signal;
  let resolveProbe;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-stop-'));
  const memory = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm' }), (s) => {
    signal = s;
    return new Promise((resolve) => { resolveProbe = resolve; });
  });
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });

  memory.start();
  await new Promise((resolve) => setImmediate(resolve));
  memory.stop();
  assert.equal(signal.aborted, true);
  resolveProbe('/fake/bin/mempalace');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(armed(memory), false);
  assert.equal(memory.initStarted, false);
});
