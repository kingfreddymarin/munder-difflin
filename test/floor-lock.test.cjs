'use strict';
// Munder's floor lock (<hive>/.floor-lock) in Council: a floor another live app holds is never
// opened or written; a dead holder's lock is taken over; Council's own lock is in Munder's format
// so Munder refuses Council's floor. Incident 2026-11-12T1457: Council opened a floor Munder 0.5.7
// held and archived four of its agents.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { acquireFloorLock, checkFloorLock, releaseFloorLock, createFloorGate, floorOwnerName, FLOOR_LOCK_FILE } = loadTs('src/main/floor-lock.ts');
const { dispatchFloorSetup } = loadTs('src/main/paramount-floor-setup.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'council-floor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = path.join(home, 'hive');
  fs.mkdirSync(hive);
  fs.writeFileSync(path.join(hive, 'registry.json'), JSON.stringify({ godId: 'god', agents: { dwight: { archived: false } } }));
  return { home, hive, lockFile: path.join(hive, FLOOR_LOCK_FILE) };
}
// The lock Munder 0.5.7 wrote in the incident (shape and formatting as on disk).
const munderLock = (pid) => JSON.stringify({ pid, userData: '/Users/someone/Library/Application Support/munder-difflin/floors/4d00974a1c86', since: '2026-11-12T14:14:41.949Z', version: '0.5.7' }, null, 2);
const council = { pid: 2002, userData: '/Users/someone/Library/Application Support/Paramount-Council', version: 'Paramount 0.4.6' };
const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

test('Council writes the lock in Munder\'s format: 2-space JSON, no trailing newline, mode 0600', (t) => {
  const f = floor(t);
  const r = acquireFloorLock(f.hive, council, () => true, () => new Date('2026-11-12T16:00:00Z'));
  assert.equal(r.ok, true);
  const text = fs.readFileSync(f.lockFile, 'utf8');
  assert.equal(text, JSON.stringify({ pid: 2002, userData: council.userData, since: '2026-11-12T16:00:00.000Z', version: 'Paramount 0.4.6' }, null, 2));
  assert.equal(fs.statSync(f.lockFile).mode & 0o777, 0o600);
  // What Munder sees from its own profile: held by a live process that is not it.
  const munder = { pid: 71506, userData: '/Users/someone/Library/Application Support/munder-difflin/floors/4d00974a1c86', version: '0.5.7' };
  assert.equal(checkFloorLock(f.hive, munder, () => true).state, 'held');
});

test('a live foreign lock: the floor is refused, the hive gets no home and nothing on it changes', (t) => {
  const f = floor(t);
  fs.writeFileSync(f.lockFile, munderLock(71506), { mode: 0o600 });
  const before = snapshot(f.hive);
  const gate = createFloorGate(council, (pid) => pid === 71506);
  const state = gate.claim(f.home);
  assert.equal(state.state, 'refused');
  assert.equal(state.refusal.owner, 'Munder Difflin 0.5.7');
  assert.equal(state.refusal.pid, 71506);
  assert.equal(gate.homeFor(f.home), null, 'hive.root() stays null: no migration, archive, socket, commit or spawn');
  gate.release();
  assert.deepEqual(snapshot(f.hive), before, 'lock and registry untouched, even after release');
});

test('a dead holder\'s lock is taken over; a relaunch of the same profile is ours', (t) => {
  const f = floor(t);
  fs.writeFileSync(f.lockFile, munderLock(71506));
  const gate = createFloorGate(council, () => false);
  assert.equal(gate.claim(f.home).state, 'open');
  assert.equal(gate.homeFor(f.home), f.home);
  assert.equal(JSON.parse(fs.readFileSync(f.lockFile, 'utf8')).pid, 2002);
  // Council crashed and relaunched with the same profile (new pid, old pid still recorded).
  const again = createFloorGate({ ...council, pid: 3003 }, () => true);
  assert.equal(again.claim(f.home).state, 'open');
  assert.equal(JSON.parse(fs.readFileSync(f.lockFile, 'utf8')).pid, 3003);
  // An unreadable lock is replaced.
  fs.writeFileSync(f.lockFile, '{ not json');
  assert.equal(createFloorGate(council, () => true).claim(f.home).state, 'open');
});

test('release removes only our own lock', (t) => {
  const f = floor(t);
  fs.writeFileSync(f.lockFile, munderLock(71506));
  assert.equal(releaseFloorLock(f.hive, council), false);
  assert.ok(fs.existsSync(f.lockFile));
  fs.unlinkSync(f.lockFile);
  const gate = createFloorGate(council, () => true);
  gate.claim(f.home);
  gate.release();
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('owner names: Munder by its data folder, Paramount by its version string', () => {
  assert.equal(floorOwnerName({ pid: 1, userData: '/x/munder-difflin/floors/a', since: '', version: '0.5.7' }), 'Munder Difflin 0.5.7');
  assert.equal(floorOwnerName({ pid: 1, userData: '/x/Paramount-Council', since: '', version: 'Paramount 0.4.6' }), 'Paramount 0.4.6');
});

test('setup refuses a floor another app holds before writing anything there', (t) => {
  const f = floor(t);
  fs.writeFileSync(f.lockFile, munderLock(71506));
  const before = snapshot(f.hive);
  const gate = createFloorGate(council, () => true);
  const calls = { ensure: 0, complete: 0 };
  const deps = { config: () => ({ onboardingComplete: false, harnessHome: null }), suggestedHome: () => f.home,
    engines: () => [{ id: 'claude', label: 'Claude Code', orchestrator: true, installed: true, models: [] }],
    ensureHome: () => { calls.ensure++; return { ok: true }; }, complete: () => { calls.complete++; }, appendEvent() {}, publish() {},
    floor: { state: () => gate.state(), claim: (home) => gate.claim(home), retry: () => gate.state(), chooseAnother() {} } };
  const span = { cid: 'c', fail: (code, message) => ({ ok: false, error: { code, message } }) };
  const r = dispatchFloorSetup({ type: 'setup.complete', home: f.home, engine: 'claude', launcherDefaults: { claude: null } }, deps, span);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CONFLICT');
  assert.match(r.error.message, /Munder Difflin 0\.5\.7 \(pid 71506\) has this floor open/);
  assert.deepEqual(calls, { ensure: 0, complete: 0 });
  assert.deepEqual(snapshot(f.hive), before);
  // floor.retry while still held says so; it never writes either.
  const retry = dispatchFloorSetup({ type: 'floor.retry' }, { ...deps, floor: { ...deps.floor, retry: () => gate.claim(f.home) } }, span);
  assert.equal(retry.error.code, 'CONFLICT');
  assert.deepEqual(snapshot(f.hive), before);
});

test('index.ts: the hive gets its home through the floor gate, and the lock comes before every floor service', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.match(code, /new HiveManager\(\s*\(\) => floorGate\.homeFor\(readConfig\(\)\.harnessHome\)/);
  const boot = code.slice(code.indexOf('function bootstrapHiveServices(): void {'));
  const claim = boot.indexOf('floorGate.claim(');
  assert.ok(claim > 0);
  for (const service of ['hive.ensureHive()', 'archiveOrphanedAgents()', 'hive.startRouter()', 'hookServer.start()', 'startEphemeralWorkerWatcher()']) {
    assert.ok(boot.indexOf(service) > claim, `${service} runs after the floor lock is held`);
  }
  assert.match(code, /app\.on\('will-quit', \(\) => \{ floorGate\.release\(\); \}\)/);
});
