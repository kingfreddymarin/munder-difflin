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
function changeHome(oldHome, gate) { return changeHomeWith(oldHome, gate, () => null); }
function changeHomeWith(oldHome, gate, refusal, proc = {}) {
  const filterSrc = INDEX.slice(INDEX.indexOf('function isNotFloorLockPath('), INDEX.indexOf('// Change the harnessHome folder.'));
  const handlerSrc = INDEX.slice(INDEX.indexOf("ipcMain.handle('config:changeHome'"), INDEX.indexOf('// ─── IPC: filesystem'));
  let handler; const calls = [];
  const noop = () => {};
  const floorsTs = loadTs('src/main/floors.ts');
  const cfg = { harnessHome: oldHome };
  const runtimeTs = loadTs('src/main/paramount-runtime.ts');
  const ctx = { ...fs, ...path, console, process: proc.argv ? { ...process, argv: proc.argv } : process, FLOOR_LOCK_FILE, floorGate: gate,
    remapMovedCwds: runtimeTs.remapMovedCwds,
    floorDataDirFor: floorsTs.floorDataDirFor, moveRelaunchArgs: floorsTs.moveRelaunchArgs,
    copyFloorPersistedState: floorsTs.copyFloorPersistedState, copyFloorMovedState: floorsTs.copyFloorMovedState,
    FloorPersistedStateCopyError: floorsTs.FloorPersistedStateCopyError,
    persist: { close: () => calls.push(['persist.close']), open: () => calls.push(['persist.open']) },
    isFloorProcess: () => !!proc.argv, sharedDataDir: () => proc.shared ?? '/S',
    dataFolderRefusal: (home) => refusal(home), appDataDirs: () => [],
    ipcMain: { handle: (_, fn) => { handler = fn; } },
    readConfig: () => (proc.argv ? { ...cfg } : { harnessHome: oldHome }), expandTilde: (x) => x,
    ensureHarnessHome: (h) => { fs.mkdirSync(path.join(h, 'hive'), { recursive: true }); return { ok: true }; },
    clearMissionTimers: noop, clearContextTimers: noop, stopWebhookDoneObserver: noop, stopEphemeralWorkerWatcher: noop,
    integrationBroker: { stop: noop }, hive: { stopRouter: noop }, hookServer: { stop: noop }, stopSlackServer: noop,
    stopWebhookServer: noop, memory: { stop: noop, drain: async () => {} }, reflector: { stop: noop, drain: async () => {} }, bootstrapHiveServices: noop,
    startSlackServer: noop, reconcileWebhookServer: noop,
    writeConfig: (c) => { calls.push(['writeConfig', c]); Object.assign(cfg, c); }, ptyManager: { killAll: () => calls.push(['killAll']) },
    app: { relaunch: (o) => calls.push(['relaunch', o]), exit: () => calls.push(['exit']), getPath: () => proc.userData }, allowQuit: false };
  vm.runInNewContext(ts.transpileModule(filterSrc + handlerSrc, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, ctx);
  return { run: (payload) => handler({}, payload), calls };
}

test('a move rebases only cwd paths in copied metadata across registry, runtime record and roster', async (t) => {
  const { old, dest } = homes(t);
  const project = path.join(old, 'project');
  const copiedProject = path.join(old, 'hive', 'agents', 'a');
  fs.mkdirSync(project); fs.mkdirSync(copiedProject, { recursive: true });
  fs.mkdirSync(path.join(old, 'palace'));
  fs.writeFileSync(path.join(old, 'hive', 'registry.json'), JSON.stringify({ agents: {
    external: { id: 'external', cwd: project }, copied: { id: 'copied', cwd: copiedProject }, outside: { id: 'outside', cwd: '/tmp/external-project' }
  } }));
  fs.writeFileSync(path.join(old, 'hive', 'paramount-runtime.json'), JSON.stringify({ schema: 'paramount-runtime-v1', agents: [
    { id: 'external', cwd: project }, { id: 'copied', cwd: copiedProject }
  ] }));
  fs.writeFileSync(path.join(old, 'roster.json'), JSON.stringify({ agents: [
    { id: 'external', cwd: project }, { id: 'copied', cwd: copiedProject }
  ] }));
  const gate = createFloorGate(council, () => true); gate.claim(old);
  assert.equal((await changeHome(old, gate).run({ newHome: dest, mode: 'move' })).ok, true);
  const registry = JSON.parse(fs.readFileSync(path.join(dest, 'hive', 'registry.json'), 'utf8'));
  const runtime = JSON.parse(fs.readFileSync(path.join(dest, 'hive', 'paramount-runtime.json'), 'utf8'));
  const roster = JSON.parse(fs.readFileSync(path.join(dest, 'roster.json'), 'utf8'));
  for (const state of [registry.agents, Object.fromEntries(runtime.agents.map((a) => [a.id, a])), Object.fromEntries(roster.agents.map((a) => [a.id, a]))]) {
    assert.equal(state.external.cwd, project, 'uncopied project path remains available');
    assert.equal(state.copied.cwd, path.join(dest, 'hive', 'agents', 'a'));
  }
  assert.equal(registry.agents.outside.cwd, '/tmp/external-project');
  gate.release();
});

function homes(t) {
  const root = tmp(t, 'council-move-');
  const old = path.join(root, 'old'), dest = path.join(root, 'dest');
  for (const d of [old, dest]) fs.mkdirSync(path.join(d, 'hive'), { recursive: true });
  fs.writeFileSync(path.join(old, 'hive', 'registry.json'), '{"floor":"OLD REGISTRY"}');
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
  assert.equal(r.ok, true, r.error);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'hive', 'registry.json'), 'utf8')).floor, 'OLD REGISTRY');
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

test("owner 2026-11-12: Settings' floor location cannot move to the app's own data folder", async (t) => {
  const { old } = homes(t);
  const data = path.join(path.dirname(old), 'Paramount');
  fs.mkdirSync(data);
  const gate = createFloorGate(council, () => true);
  assert.equal(gate.claim(old).state, 'open');
  const { dataFolderRefusal } = loadTs('src/main/floors.ts');
  // The real refusal, with this test's data folder.
  const ctxHandler = changeHomeWith(old, gate, (home) => dataFolderRefusal(home, [data]));
  for (const target of [data, path.join(data, 'floor')]) {
    const r = await ctxHandler.run({ newHome: target, mode: 'fresh' });
    assert.equal(r.ok, false);
    assert.equal(r.error, "A floor cannot use this floor's own data folder.");
  }
  assert.deepEqual(ctxHandler.calls, []);
  assert.deepEqual(fs.readdirSync(data), [], 'nothing made there');
  assert.equal(gate.homeFor(old), old);
  gate.release();
});

test('a location change relaunches straight onto the new floor', async (t) => {
  const { old, dest } = homes(t);
  const gate = createFloorGate(council, () => true);
  gate.claim(old);
  const h = changeHomeWith(old, gate, () => null);
  assert.equal((await h.run({ newHome: dest, mode: 'fresh' })).ok, true);
  const relaunch = h.calls.find((c) => c[0] === 'relaunch');
  assert.ok(relaunch[1].args.includes('--council-open-floor'));
});

test('review F2: a location change in a floor process restarts it as the new home\'s floor, with its config in that data folder', async (t) => {
  const { old, dest } = homes(t);
  const shared = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'council-shared-'));
  t.after(() => fs.rmSync(shared, { recursive: true, force: true }));
  const gate = createFloorGate(council, () => true);
  gate.claim(old);
  const floorsTs = loadTs('src/main/floors.ts');
  const argv = ['/App/Paramount', `--floor-data=${floorsTs.floorDataDirFor(shared, old)}`, `--floor-shared=${shared}`, `--floor-home=${old}`];
  const h = changeHomeWith(old, gate, () => null, { argv, shared });
  assert.equal((await h.run({ newHome: dest, mode: 'fresh' })).ok, true);
  const newData = floorsTs.floorDataDirFor(shared, dest);
  const relaunch = h.calls.find((c) => c[0] === 'relaunch');
  assert.deepEqual(relaunch[1].args, [`--floor-data=${newData}`, `--floor-shared=${shared}`, `--floor-home=${dest}`]);
  const written = JSON.parse(fs.readFileSync(path.join(newData, 'config.json'), 'utf8'));
  assert.equal(written.harnessHome, dest);
  assert.equal(fs.statSync(path.join(newData, 'config.json')).mode & 0o777, 0o600);
  assert.equal(floorsTs.bootFloorPlan(['/App/Paramount', ...relaunch[1].args], written.harnessHome).open, dest);
  gate.release();
});

// NSC-222 / review N5, driven through the real handler (NSC-212: replaces a source regex in floors.test.cjs).
test('a Move in a floor process carries config, database and the floor\'s state files to the new data folder', async (t) => {
  const { old, dest } = homes(t);
  const shared = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'council-shared-'));
  t.after(() => fs.rmSync(shared, { recursive: true, force: true }));
  const floorsTs = loadTs('src/main/floors.ts');
  const userData = floorsTs.floorDataDirFor(shared, old);
  fs.mkdirSync(path.join(userData, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'harness.db'), 'history');
  fs.writeFileSync(path.join(userData, 'integration-secrets.json'), '{"sealed":"x"}', { mode: 0o600 });
  fs.writeFileSync(path.join(userData, 'trigger-history.json'), '[1]');
  fs.writeFileSync(path.join(userData, 'knowledge', 'store.json'), '{}');
  const gate = createFloorGate(council, () => true);
  gate.claim(old);
  const argv = ['/App/Paramount', `--floor-data=${userData}`, `--floor-shared=${shared}`, `--floor-home=${old}`];
  const h = changeHomeWith(old, gate, () => null, { argv, shared, userData });
  assert.equal((await h.run({ newHome: dest, mode: 'move' })).ok, true);
  const newData = floorsTs.floorDataDirFor(shared, dest);
  assert.deepEqual(fs.readdirSync(newData).sort(), ['config.json', 'harness.db', 'integration-secrets.json', 'knowledge', 'trigger-history.json']);
  assert.equal(fs.readFileSync(path.join(newData, 'integration-secrets.json'), 'utf8'), '{"sealed":"x"}');
  assert.equal(fs.readFileSync(path.join(newData, 'harness.db'), 'utf8'), 'history');
  assert.equal(JSON.parse(fs.readFileSync(path.join(newData, 'config.json'), 'utf8')).harnessHome, dest);
  assert.ok(h.calls.some((c) => c[0] === 'persist.close'), 'the database is flushed before it is copied');
  gate.release();
});
