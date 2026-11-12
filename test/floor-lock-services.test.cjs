'use strict';
// Review 2026-11-12 (REVIEW-2026-11-12-floorlock.md) F2 and F3:
//  F2: RosterStore, MemoryManager, MemoryReflector, worktrees and agent spawns used the raw
//      configured home, so a refused floor could still be written (roster.json, memory, backups).
//  F3: config:changeHome copied the old hive over the destination (force) before any lock check,
//      overwriting a live foreign registry and copying .floor-lock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const floorLock = loadTs('src/main/floor-lock.ts');
const { createFloorGate, FLOOR_LOCK_FILE } = floorLock;
const { RosterStore } = loadTs('src/main/roster.ts');
const INDEX = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');

const tmp = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const foreignLock = (pid) => JSON.stringify({ pid, userData: '/foreign/munder-difflin/floors/abc', since: '2026-11-12T14:14:41.949Z', version: '0.5.7' }, null, 2);
const council = { pid: process.pid, userData: '/tmp/profile-council', version: 'Paramount test' };

test('F2: on a refused floor the roster (as wired in index.ts) writes nothing', (t) => {
  const home = tmp(t, 'council-svc-');
  fs.mkdirSync(path.join(home, 'hive'));
  fs.writeFileSync(path.join(home, 'hive', FLOOR_LOCK_FILE), foreignLock(71506));
  const floorGate = createFloorGate(council, (pid) => pid === 71506);
  assert.equal(floorGate.claim(home).state, 'refused');
  const floorHome = () => floorGate.homeFor(home); // index.ts: floorGate.homeFor(readConfig().harnessHome)
  const roster = new RosterStore(floorHome);
  const r = roster.write({ version: 1, savedAt: '', agents: [{ id: 'foreign' }], archived: [], restorable: [], queues: {}, selectedId: null });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(home, 'roster.json')), false);
  roster.archive();
  assert.deepEqual(fs.readdirSync(home), ['hive']);
});

test('F2: index.ts gives every floor-bound service the gated home and refuses floor agent spawns', () => {
  assert.match(INDEX, /const floorHome = \(\): string \| null => floorGate\.homeFor\(readConfig\(\)\.harnessHome\);/);
  assert.match(INDEX, /new RosterStore\(floorHome\)/);
  assert.match(INDEX, /new MemoryManager\(\s*floorHome,/);
  assert.match(INDEX, /new MemoryReflector\(\s*floorHome,/);
  assert.match(INDEX, /const wtRoot = join\(floorHome\(\) \?\? origCwd, 'worktrees'\);/);
  assert.doesNotMatch(INDEX, /new (RosterStore|MemoryManager|MemoryReflector)\(\s*\(\) => readConfig\(\)\.harnessHome/);
  // The spawn core refuses a floor agent before any cwd, worktree or hive work.
  const core = INDEX.slice(INDEX.indexOf('async function spawnAgentCore('));
  const guard = core.indexOf('const refused = floorSpawnRefusal(opts);');
  assert.ok(guard > 0 && guard < core.indexOf('opts.cwd = expandTilde(opts.cwd);'));
  assert.match(INDEX, /if \(!opts\.hive \|\| !readConfig\(\)\.harnessHome \|\| floorHome\(\)\) return null;/, 'a plain terminal stays available');
});

// The real config:changeHome handler from index.ts, with app teardown stubbed and real files in
// temporary folders (the review's command B, with the real floor gate).
function changeHome(oldHome, gate) {
  const filterSrc = INDEX.slice(INDEX.indexOf('function isNotFloorLockPath('), INDEX.indexOf('// Change the harnessHome folder.'));
  const handlerSrc = INDEX.slice(INDEX.indexOf("ipcMain.handle('config:changeHome'"), INDEX.indexOf('// ─── IPC: filesystem'));
  let handler; const calls = [];
  const noop = () => {};
  const ctx = { ...fs, ...path, console, FLOOR_LOCK_FILE, floorGate: gate,
    ipcMain: { handle: (_, fn) => { handler = fn; } },
    readConfig: () => ({ harnessHome: oldHome }), expandTilde: (x) => x,
    ensureHarnessHome: (h) => { fs.mkdirSync(path.join(h, 'hive'), { recursive: true }); return { ok: true }; },
    clearMissionTimers: noop, clearContextTimers: noop, stopWebhookDoneObserver: noop, stopEphemeralWorkerWatcher: noop,
    integrationBroker: { stop: noop }, hive: { stopRouter: noop }, hookServer: { stop: noop }, stopSlackServer: noop,
    stopWebhookServer: noop, memory: { stop: noop, drain: async () => {} }, reflector: { stop: noop, drain: async () => {} }, bootstrapHiveServices: noop,
    startSlackServer: noop, reconcileWebhookServer: noop,
    writeConfig: (c) => calls.push(['writeConfig', c]), ptyManager: { killAll: () => calls.push(['killAll']) },
    app: { relaunch: () => calls.push(['relaunch']), exit: () => calls.push(['exit']) }, allowQuit: false };
  vm.runInNewContext(ts.transpileModule(filterSrc + handlerSrc, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, ctx);
  return { run: (payload) => handler({}, payload), calls };
}

function homes(t) {
  const root = tmp(t, 'council-move-');
  const old = path.join(root, 'old'), dest = path.join(root, 'dest');
  for (const d of [old, dest]) fs.mkdirSync(path.join(d, 'hive'), { recursive: true });
  fs.writeFileSync(path.join(old, 'hive', 'registry.json'), 'OLD REGISTRY');
  return { old, dest };
}

test('F3: moving onto a floor another live app holds is refused and nothing there changes', async (t) => {
  const { old, dest } = homes(t);
  fs.writeFileSync(path.join(dest, 'hive', 'registry.json'), 'FOREIGN REGISTRY');
  fs.writeFileSync(path.join(dest, 'hive', FLOOR_LOCK_FILE), foreignLock(71506));
  const gate = createFloorGate(council, (pid) => pid === 71506 || pid === process.pid);
  assert.equal(gate.claim(old).state, 'open');
  const before = Object.fromEntries(fs.readdirSync(path.join(dest, 'hive')).map((f) => [f, fs.readFileSync(path.join(dest, 'hive', f), 'utf8')]));
  const h = changeHome(old, gate);
  const r = await h.run({ newHome: dest, mode: 'move' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Munder Difflin 0\.5\.7 \(pid 71506\) has that folder's floor open/);
  const after = Object.fromEntries(fs.readdirSync(path.join(dest, 'hive')).map((f) => [f, fs.readFileSync(path.join(dest, 'hive', f), 'utf8')]));
  assert.deepEqual(after, before);
  assert.deepEqual(h.calls, [], 'no config change, no kill, no relaunch');
  assert.equal(gate.homeFor(old), old, 'the current floor is still held');
});

test('F3: a move claims the destination first, never copies lock files, then releases the old floor', async (t) => {
  const { old, dest } = homes(t);
  const gate = createFloorGate(council, () => true);
  assert.equal(gate.claim(old).state, 'open');
  fs.writeFileSync(path.join(old, 'hive', '.floor-lock.999.deadbeef.tmp'), '{}'); // a claim temp file at copy time
  const h = changeHome(old, gate);
  const r = await h.run({ newHome: dest, mode: 'move' });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dest, 'hive', 'registry.json'), 'utf8'), 'OLD REGISTRY');
  assert.equal(fs.existsSync(path.join(dest, 'hive', '.floor-lock.999.deadbeef.tmp')), false, 'claim files are not copied');
  const destLock = JSON.parse(fs.readFileSync(path.join(dest, 'hive', FLOOR_LOCK_FILE), 'utf8'));
  assert.equal(destLock.pid, process.pid);
  assert.equal(destLock.userData, council.userData, 'the reserved destination lock, not a copy of the old one');
  assert.equal(fs.existsSync(path.join(old, 'hive', FLOOR_LOCK_FILE)), false, 'old floor released after its agents stopped');
  assert.deepEqual(h.calls.map((c) => c[0]), ['writeConfig', 'killAll', 'relaunch', 'exit']);
});

test('F3: the old claim is released only after agents are killed', () => {
  const handler = INDEX.slice(INDEX.indexOf("ipcMain.handle('config:changeHome'"));
  const reserve = handler.indexOf('floorGate.reserve(newHome)');
  assert.ok(reserve > 0 && reserve < handler.indexOf('ensureHarnessHome(newHome)'));
  assert.ok(handler.indexOf('ptyManager.killAll()') < handler.indexOf('floorGate.release();'));
});
