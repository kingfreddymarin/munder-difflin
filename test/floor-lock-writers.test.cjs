'use strict';
// Re-review 2026-11-12 (REVIEW-2026-11-12-floorlock-rereview.md) R2 and R3:
//  R2: reset deleted the whole hive (and the lock) before archiving the roster, so a successor
//      could claim the floor mid-reset and lose its roster to this reset.
//  R3: stopping services did not stop asynchronous writers: an in-flight reflection rewrote
//      memory after the floor was released and claimed by a successor; the miner child kept running.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');
const floors = loadTs('src/main/floors.ts');

const floorLock = loadTs('src/main/floor-lock.ts');
const { createFloorGate, acquireFloorLock, removeFloorContents, FLOOR_LOCK_FILE } = floorLock;
const { RosterStore } = loadTs('src/main/roster.ts');
const { MemoryReflector } = loadTs('src/main/reflect.ts');
const { MemoryManager } = loadTs('src/main/memory.ts');
const INDEX = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');

const tmp = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const council = { pid: process.pid, userData: '/tmp/profile-council', version: 'Paramount test' };
const successor = { pid: process.pid, userData: '/tmp/profile-successor', version: 'Paramount test' };
const rosterSnap = (id) => ({ version: 1, savedAt: '', agents: [{ id }], archived: [], restorable: [], queues: {}, selectedId: null });

test('R2: reset keeps the floor until its last write; a successor cannot claim it mid-reset', async (t) => {
  const home = tmp(t, 'council-reset-');
  fs.mkdirSync(path.join(home, 'hive', 'agents', 'god'), { recursive: true });
  fs.writeFileSync(path.join(home, 'hive', 'registry.json'), '{}');
  const floorGate = createFloorGate(council, () => true);
  assert.equal(floorGate.claim(home).state, 'open');
  const floorHome = () => floorGate.homeFor(home);
  const roster = new RosterStore(floorHome);
  assert.equal(roster.write(rosterSnap('ours')).ok, true);
  const order = [];
  let relaunched;
  let successorClaim;
  // The real reset handler from index.ts; teardown stubbed.
  const handlerSrc = INDEX.slice(INDEX.indexOf("ipcMain.handle('app:resetAll'"), INDEX.indexOf('// ─── IPC: token telemetry'));
  let handler;
  const noop = () => {};
  const stub = { stop: noop };
  const ctx = { console, rmSync: fs.rmSync, process: { argv: ['Paramount', '--floor-data=/shared/floors/old', '--floor-shared=/shared', '--floor-home=/old/home'] }, switchRelaunchArgs: floors.switchRelaunchArgs,
    ipcMain: { handle: (_, fn) => { handler = fn; } }, allowQuit: false,
    clearMissionTimers: noop, clearContextTimers: noop, stopWebhookDoneObserver: noop, stopEphemeralWorkerWatcher: noop,
    integrationBroker: stub, hookServer: stub, telemetry: stub, stopSlackServer: noop, reflector: stub, persist: { close: noop },
    ptyManager: { killAll: noop },
    hive: { stopRouter: noop, removeExposedCodexData: noop, root: () => floorHome() && path.join(home, 'hive') },
    memory: { stop: noop, palacePath: () => floorHome() && path.join(home, 'palace') },
    roster: { archive: () => { order.push('roster.archive'); roster.archive(); } },
    removeFloorContents: (dir) => {
      order.push('remove hive contents'); removeFloorContents(dir);
      // A successor tries right after the hive is emptied (the review's moment).
      successorClaim = acquireFloorLock(path.join(home, 'hive'), successor, () => true, { waitMs: 100 });
    },
    floorGate: { release: () => { order.push('release'); floorGate.release(); } },
    resetConfig: () => order.push('resetConfig'), app: { relaunch: (opts) => { relaunched = opts; }, exit: () => order.push('exit') } };
  vm.runInNewContext(ts.transpileModule(handlerSrc, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, ctx);
  await handler();
  assert.deepEqual(order, ['roster.archive', 'remove hive contents', 'release', 'resetConfig', 'exit']);
  assert.deepEqual(relaunched.args, ['--floor-data=/shared/floors/old', '--floor-shared=/shared', '--floor-home=/old/home', '--council-floor-picker']);
  assert.equal(successorClaim.ok, false, 'the floor was still held when the hive was emptied');
  assert.equal(successorClaim.error, 'held');
  assert.equal(fs.existsSync(path.join(home, 'roster.json')), false, 'our roster was archived');
  assert.ok(fs.readdirSync(path.join(home, 'roster-backups')).length > 0);
  assert.deepEqual(fs.readdirSync(path.join(home, 'hive')).filter((n) => !n.startsWith('.floor-lock.')), [], 'hive emptied, lock released');
  // Now a successor can claim, and nothing from the reset touches its roster.
  const next = createFloorGate(successor, () => true);
  assert.equal(next.claim(home).state, 'open');
  assert.equal(new RosterStore(() => next.homeFor(home)).write(rosterSnap('successor')).ok, true);
  assert.match(fs.readFileSync(path.join(home, 'roster.json'), 'utf8'), /successor/);
  next.release();
});

test('R2: removeFloorContents keeps the lock and the kernel claim', (t) => {
  const hive = path.join(tmp(t, 'council-rm-'), 'hive');
  fs.mkdirSync(path.join(hive, 'agents'), { recursive: true });
  for (const n of ['registry.json', FLOOR_LOCK_FILE, '.floor-lock.flock', 'log.jsonl']) fs.writeFileSync(path.join(hive, n), 'x');
  removeFloorContents(hive);
  assert.deepEqual(fs.readdirSync(hive).sort(), ['.floor-lock', '.floor-lock.flock']);
});

function memoryWithHistory(home) {
  const dir = path.join(home, 'hive', 'agents', 'god');
  fs.mkdirSync(dir, { recursive: true });
  const sections = Array.from({ length: 12 }, (_, i) => `## Note ${i}\n${'Old detail. '.repeat(25)}`).join('\n\n');
  const text = `# Memory — god\n\n${sections}\n\n## Latest\nkeep this\n`;
  fs.writeFileSync(path.join(dir, 'memory.md'), text);
  return { file: path.join(dir, 'memory.md'), text };
}
const SETTINGS = { enabled: true, intervalMs: 3_600_000, byteTriggerPct: 50, sectionTrigger: 4, recentKeep: 1, minBytes: 1 };

test('R3: a reflection in flight when the floor is released writes nothing afterwards', async (t) => {
  const home = tmp(t, 'council-reflect-');
  const mem = memoryWithHistory(home);
  const gate = createFloorGate(council, () => true);
  assert.equal(gate.claim(home).state, 'open');
  const r = new MemoryReflector(() => gate.homeFor(home), () => 'claude', () => ({}), () => SETTINGS, () => {});
  let resolveSummary;
  r.summarize = () => new Promise((res) => { resolveSummary = res; });
  const pass = r.reflectNow('god');
  await new Promise((res) => setImmediate(res));
  r.stop();
  gate.release();
  const next = createFloorGate(successor, () => true);
  assert.equal(next.claim(home).state, 'open', 'successor holds the floor');
  resolveSummary({ condensed: 'Earlier notes, condensed: the old details were about setup and routing. '.repeat(5), hoist: [] });
  const [result] = await pass;
  assert.equal(result.condensed, false);
  assert.equal(result.reason, 'stopped');
  assert.equal(fs.readFileSync(mem.file, 'utf8'), mem.text, 'memory untouched after the release');
  await r.drain();
  next.release();
});

test('R3: a released floor alone (no stop) also stops the write', async (t) => {
  const home = tmp(t, 'council-reflect2-');
  const mem = memoryWithHistory(home);
  const gate = createFloorGate(council, () => true);
  gate.claim(home);
  const r = new MemoryReflector(() => gate.homeFor(home), () => 'claude', () => ({}), () => SETTINGS, () => {});
  let resolveSummary;
  r.summarize = () => new Promise((res) => { resolveSummary = res; });
  const pass = r.reflectNow('god');
  await new Promise((res) => setImmediate(res));
  gate.release();
  resolveSummary({ condensed: 'Earlier notes, condensed: the old details were about setup and routing. '.repeat(5), hoist: [] });
  const [result] = await pass;
  assert.equal(result.reason, 'stopped');
  assert.equal(fs.readFileSync(mem.file, 'utf8'), mem.text);
});

test('R3: memory stop() kills the running miner and drain() resolves', async (t) => {
  const home = tmp(t, 'council-mine-');
  const m = new MemoryManager(() => home, () => ({ enabled: true }));
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  const exited = new Promise((res) => child.on('exit', (code, signal) => res(signal)));
  m.miner = child;
  m.stop();
  assert.equal(await exited, 'SIGTERM');
  await m.drain();
});

test('R3: quit stops floor writers before releasing; a move drains them before copying', () => {
  assert.match(INDEX, /function releaseFloorOnQuit\(\): void \{\s*try \{ memory\.stop\(\); \}[^\n]*\n\s*try \{ reflector\.stop\(\); \}[^\n]*\n\s*floorGate\.release\(\);/);
  const move = INDEX.slice(INDEX.indexOf("ipcMain.handle('config:changeHome'"));
  const drain = move.indexOf('await Promise.all([memory.drain(), reflector.drain()])');
  assert.ok(drain > 0 && drain < move.indexOf('cpSync('));
});

test('R3 control: with the floor still held, the same reflection does condense (the fixture is valid)', async (t) => {
  const home = tmp(t, 'council-reflect3-');
  const mem = memoryWithHistory(home);
  const gate = createFloorGate(council, () => true);
  gate.claim(home);
  const r = new MemoryReflector(() => gate.homeFor(home), () => 'claude', () => ({}), () => SETTINGS, () => {});
  r.summarize = async () => ({ condensed: 'Earlier notes, condensed: the old details were about setup and routing. '.repeat(5), hoist: [] });
  const [result] = await r.reflectNow('god');
  assert.equal(result.condensed, true, JSON.stringify(result));
  assert.notEqual(fs.readFileSync(mem.file, 'utf8'), mem.text);
  gate.release();
});
