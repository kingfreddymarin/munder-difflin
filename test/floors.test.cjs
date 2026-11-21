'use strict';
// Owner requests 2026-11-12 (NSC-193): Council on several floors at once (Munder 0.5.7 parity,
// VERIFY-2026-11-12-multi-floor.md rows 1-4, 7, 8), the floor picked on every launch, and never the
// app's own data folder as a floor.
//  - A floor process is started with --floor-data/--floor-shared/--floor-home; its data folder is
//    <shared>/floors/<sha1(home)[:12]>; its first config is the shared one minus FLOOR_CONFIG_STRIP.
//  - The main process claims nothing at boot; the picker probes each recent floor (free, held,
//    missing, current, data folder) and opens one; New Floor… starts the chosen floor as its own
//    detached process; a held floor is refused with nothing on it written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const floors = loadTs('src/main/floors.ts');
const { createFloorGate, FLOOR_LOCK_FILE } = loadTs('src/main/floor-lock.ts');
const { dispatchFloorSetup, floorSetupState } = loadTs('src/main/paramount-floor-setup.ts');
const INDEX = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
const SHELL = fs.readFileSync(path.join(__dirname, '../src/main/paramountShell.ts'), 'utf8');

const tmp = (t, prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
// Values made inside a vm context have that context's prototypes: compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));
const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
// A live process that is not this one (the probe checks the real pid): the test runner's parent.
const MUNDER_PID = process.ppid;
const foreignLock = JSON.stringify({ pid: MUNDER_PID, userData: '/foreign/munder-difflin/floors/abc', since: '2026-11-12T14:14:41.949Z', version: '0.5.7' }, null, 2);
const isAlive = (pid) => pid === MUNDER_PID || pid === process.pid;
const span = { cid: 'cid-1', fail: (code, message) => ({ ok: false, error: { code, message } }) };

function world(t) {
  const root = tmp(t, 'council-floors-');
  const userData = path.join(root, 'Paramount');
  const a = path.join(root, 'floor-a'), b = path.join(root, 'floor-b'), held = path.join(root, 'held');
  for (const d of [a, b, held]) fs.mkdirSync(path.join(d, 'hive'), { recursive: true });
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(a, 'hive', 'registry.json'), '{"floor":"A"}');
  fs.writeFileSync(path.join(held, 'hive', 'registry.json'), '{"floor":"held by Munder"}');
  fs.writeFileSync(path.join(held, 'hive', FLOOR_LOCK_FILE), foreignLock);
  return { root, userData, a, b, held, gone: path.join(root, 'gone') };
}
const me = (userData) => ({ pid: process.pid, userData, version: 'Paramount test' });

// ─── floors.ts (Munder's floor process model) ────────────────────────────────
test('floor flags: both folders absolute and different, home optional', () => {
  const ok = floors.parseFloorArgs(['/App', '--floor-data=/u/P/floors/abc', '--floor-shared=/u/P', '--floor-home=/w/B']);
  assert.deepEqual(plain(ok), { dataDir: '/u/P/floors/abc', sharedDir: '/u/P', home: '/w/B' });
  assert.equal(floors.parseFloorArgs(['/App']), null, 'the main process');
  assert.equal(floors.parseFloorArgs(['--floor-data=rel', '--floor-shared=/u/P']), null);
  assert.equal(floors.parseFloorArgs(['--floor-data=/u/P', '--floor-shared=/u/P']), null, 'a floor never shares the main data folder');
  assert.equal(floors.parseFloorArgs(['--floor-data=/u/P/f', '--floor-shared=/u/P', '--floor-home=rel']).home, null);
});

test('each floor has its own data folder <shared>/floors/<sha1(home)[:12]>, and the spawn plan carries the flags', () => {
  const id = crypto.createHash('sha1').update('/w/B').digest('hex').slice(0, 12);
  assert.equal(floors.floorDataDirFor('/u/P', '/w/B'), `/u/P/floors/${id}`);
  assert.notEqual(floors.floorDataDirFor('/u/P', '/w/A'), floors.floorDataDirFor('/u/P', '/w/B'));
  const o = { execPath: '/App/Paramount', appPath: '/App/app.asar', dataDir: '/u/P/floors/x', sharedDir: '/u/P', home: '/w/B' };
  const flags = ['--floor-data=/u/P/floors/x', '--floor-shared=/u/P', '--floor-home=/w/B'];
  assert.deepEqual(plain(floors.floorSpawnPlan({ ...o, packaged: true })), { command: '/App/Paramount', args: flags });
  assert.deepEqual(plain(floors.floorSpawnPlan({ ...o, packaged: false })), { command: '/App/Paramount', args: ['/App/app.asar', ...flags] });
});

test('moving a floor carries its closed SQLite database and WAL into the new keyed data folder', (t) => {
  const root = tmp(t, 'council-floor-state-');
  const source = path.join(root, 'old');
  const target = path.join(root, 'new');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'harness.db'), 'database fixture');
  fs.writeFileSync(path.join(source, 'harness.db-wal'), 'wal fixture');
  fs.writeFileSync(path.join(source, 'unrelated-cache'), 'not floor state');
  floors.copyFloorPersistedState(source, target);
  assert.equal(fs.readFileSync(path.join(target, 'harness.db'), 'utf8'), 'database fixture');
  assert.equal(fs.readFileSync(path.join(target, 'harness.db-wal'), 'utf8'), 'wal fixture');
  assert.equal(fs.existsSync(path.join(target, 'unrelated-cache')), false);
});

test('moving a closed database removes stale destination sidecars when source has none', (t) => {
  const root = tmp(t, 'council-floor-state-stale-');
  const source = path.join(root, 'old'); const target = path.join(root, 'new');
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'harness.db'), 'closed source database');
  fs.writeFileSync(path.join(target, 'harness.db'), 'old target database');
  fs.writeFileSync(path.join(target, 'harness.db-wal'), 'old target WAL');
  fs.writeFileSync(path.join(target, 'harness.db-shm'), 'old target shared memory');
  floors.copyFloorPersistedState(source, target);
  assert.equal(fs.readFileSync(path.join(target, 'harness.db'), 'utf8'), 'closed source database');
  assert.equal(fs.existsSync(path.join(target, 'harness.db-wal')), false);
  assert.equal(fs.existsSync(path.join(target, 'harness.db-shm')), false);
});

test('database copy failures preserve the complete prior destination state', (t) => {
  const root = tmp(t, 'council-floor-state-failure-');
  const source = path.join(root, 'old'); const target = path.join(root, 'new');
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'harness.db'), 'new source database');
  fs.writeFileSync(path.join(source, 'harness.db-wal'), 'new source WAL');
  fs.writeFileSync(path.join(target, 'harness.db'), 'old target database');
  fs.writeFileSync(path.join(target, 'harness.db-wal'), 'old target WAL');
  fs.writeFileSync(path.join(target, 'harness.db-shm'), 'old target shared memory');
  const before = Object.fromEntries(['harness.db', 'harness.db-wal', 'harness.db-shm'].map((f) => [f, fs.readFileSync(path.join(target, f), 'utf8')]));
  assert.throws(() => floors.copyFloorPersistedState(source, target, { cpSync: () => { throw new Error('injected source copy failure'); } }), /injected source copy failure/);
  assert.deepEqual(Object.fromEntries(fs.readdirSync(target).filter((f) => f.startsWith('harness.db')).map((f) => [f, fs.readFileSync(path.join(target, f), 'utf8')])), before);

  let failed = false;
  assert.throws(() => floors.copyFloorPersistedState(source, target, { renameSync: (from, to) => {
    if (!failed && from.endsWith(`${path.sep}harness.db` ) && to === path.join(target, 'harness.db')) { failed = true; throw new Error('injected install failure'); }
    fs.renameSync(from, to);
  } }), /injected install failure/);
  assert.deepEqual(Object.fromEntries(fs.readdirSync(target).filter((f) => f.startsWith('harness.db')).map((f) => [f, fs.readFileSync(path.join(target, f), 'utf8')])), before);
});

test('a failed replacement and failed restore retain the exact old database backup and report its path', (t) => {
  const root = tmp(t, 'council-floor-retained-backup-');
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'harness.db'), 'new database bytes');
  fs.writeFileSync(path.join(target, 'harness.db'), 'old database bytes');
  fs.writeFileSync(path.join(target, 'harness.db-wal'), 'old wal bytes');
  let error;
  try {
    floors.copyFloorPersistedState(source, target, { renameSync(from, to) {
      if (from.includes(`${path.sep}staged${path.sep}`) || from.includes(`${path.sep}backup${path.sep}`)) throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
      fs.renameSync(from, to);
    } });
  } catch (caught) { error = caught; }
  assert.ok(error instanceof floors.FloorPersistedStateCopyError);
  assert.equal(error.recoveryState, 'recovery-backup-retained');
  assert.ok(error.message.includes(error.recoveryPath));
  assert.equal(fs.readFileSync(path.join(error.recoveryPath, 'harness.db'), 'utf8'), 'old database bytes');
  assert.equal(fs.readFileSync(path.join(error.recoveryPath, 'harness.db-wal'), 'utf8'), 'old wal bytes');
  assert.equal(fs.existsSync(path.join(target, 'harness.db')), false);
});

test('cleanup failure reports that replacement is installed and keeps the old target backup', (t) => {
  const root = tmp(t, 'council-floor-cleanup-failure-');
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'harness.db'), 'new database bytes');
  fs.writeFileSync(path.join(target, 'harness.db'), 'old database bytes');
  let error;
  try {
    floors.copyFloorPersistedState(source, target, { rmSync(pathname, options) {
      if (options?.recursive) throw new Error('synthetic cleanup EIO');
      fs.rmSync(pathname, options);
    } });
  } catch (caught) { error = caught; }
  assert.ok(error instanceof floors.FloorPersistedStateCopyError);
  assert.equal(error.recoveryState, 'new-target-installed');
  assert.match(error.message, /copied and verified.*cleanup failed/);
  assert.equal(fs.readFileSync(path.join(target, 'harness.db'), 'utf8'), 'new database bytes');
  assert.equal(fs.readFileSync(path.join(error.recoveryPath, 'harness.db'), 'utf8'), 'old database bytes');
});

test("a new floor's config: the shared one without per-floor settings, Slack and webhooks off", () => {
  const main = { harnessHome: '/w/A', recentHives: ['/w/A'], registeredRepos: ['/r'], missions: [1], slackEnabled: true, slackPort: 3999, slackBotToken: 'x', webhookEnabled: true, webhookPort: 4000,
    tokenLimits: {}, avatars: {}, agentMcp: {}, onboardingComplete: true, godProvider: 'claude', godModel: 'claude-opus-5-5', autoMode: true };
  const seeded = floors.seedFloorConfig(main, '/w/B');
  for (const k of floors.FLOOR_CONFIG_STRIP) if (!['harnessHome', 'recentHives', 'slackEnabled', 'webhookEnabled'].includes(k)) assert.equal(k in seeded, false, k);
  assert.equal(seeded.harnessHome, '/w/B');
  assert.deepEqual(plain(seeded.recentHives), ['/w/B']);
  assert.equal(seeded.slackEnabled, false);
  assert.equal(seeded.webhookEnabled, false);
  assert.equal(seeded.onboardingComplete, true, 'no setup in a floor process');
  assert.equal(seeded.godModel, 'claude-opus-5-5', 'app-wide settings are kept');
  assert.deepEqual([...floors.FLOOR_CONFIG_STRIP].sort(), ['agentCustomMcp', 'agentMcp', 'agentSkillsOff', 'autoDeliveryPausedAgents', 'avatars', 'compactMaintenanceSeeded', 'harnessHome', 'heartbeatSeeded', 'missions', 'opsStandupSeeded', 'recentHives', 'registeredRepos', 'slackBotToken', 'slackChannelId', 'slackEnabled', 'slackMode', 'slackPort', 'slackProactivePosting', 'slackSigningSecret', 'tokenLimits', 'webhookEnabled', 'webhookPort', 'webhookSecret', 'webhookTriggers'], "Munder 0.5.7's list");
});

test("the app's own data folder (or a folder inside or around it) is never a floor", () => {
  const msg = "A floor cannot use this floor's own data folder.";
  assert.equal(floors.dataFolderRefusal('/u/Library/Application Support/Paramount', ['/u/Library/Application Support/Paramount']), msg);
  assert.equal(floors.dataFolderRefusal('/u/Library/Application Support/Paramount/floor', ['/u/Library/Application Support/Paramount']), msg);
  assert.equal(floors.dataFolderRefusal('/u/Library/Application Support', ['/u/Library/Application Support/Paramount']), msg);
  assert.equal(floors.dataFolderRefusal('/u/Library/Application Support/Paramount Floors', ['/u/Library/Application Support/Paramount']), null, 'a sibling with a longer name is fine');
  assert.equal(floors.dataFolderRefusal('/u/Paramount', ['/u/Library/Application Support/Paramount']), null);
});

test('data-folder refusal follows symlink aliases and nonexistent descendants without writing paths', (t) => {
  const root = tmp(t, 'floor-path-equivalence-');
  const data = path.join(root, 'app-data');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(data);
  fs.symlinkSync(data, alias, 'dir');
  assert.ok(floors.dataFolderRefusal(path.join(alias, 'not-created', 'floor'), [data]));
  assert.ok(floors.dataFolderRefusal(alias, [data]));
  assert.equal(fs.existsSync(path.join(data, 'not-created')), false, 'checking missing descendants does not create them');
  if (process.platform === 'darwin' || process.platform === 'win32') {
    assert.ok(floors.dataFolderRefusal(path.join(root, 'APP-DATA', 'floor'), [data]), 'case aliases are refused on default case-insensitive platforms');
  }
});

test('probe: free, held (with owner), missing, current, data folder; read-only', (t) => {
  const w = world(t);
  const ctx = { currentHome: w.a, me: me(w.userData), dataDirs: [w.userData], isAlive };
  const before = snapshot(path.join(w.held, 'hive'));
  assert.equal(floors.probeFloor(w.b, ctx).state, 'free');
  const h = floors.probeFloor(w.held, ctx);
  assert.equal(h.state, 'held'); assert.equal(h.lock.pid, MUNDER_PID);
  assert.equal(floors.probeFloor(w.gone, ctx).state, 'missing');
  assert.equal(floors.probeFloor(w.a, ctx).state, 'current');
  assert.equal(floors.probeFloor(w.userData, ctx).state, 'data-folder');
  assert.deepEqual(snapshot(path.join(w.held, 'hive')), before);
  assert.equal(fs.existsSync(path.join(w.b, 'hive', FLOOR_LOCK_FILE)), false);
  const v = floors.validateFloorRequest(w.held, ctx);
  assert.equal(v.refusal, 'held');
  assert.equal(floors.validateFloorRequest(w.a, ctx).refusal, 'current');
  assert.equal(floors.validateFloorRequest(w.userData, ctx).refusal, 'data-folder');
  assert.equal(floors.validateFloorRequest('relative', ctx).refusal, 'invalid');
  assert.deepEqual(plain(floors.validateFloorRequest(w.b, ctx)), { ok: true, home: w.b });
});

test('paramountShell: floor flags pick the data folder before anything reads it; the suggested floor is not the data folder', () => {
  const parse = SHELL.indexOf('const floorArgs = parseFloorArgs(process.argv);');
  assert.ok(parse > 0 && parse < SHELL.indexOf("app.setPath('userData', userDataDir);"));
  assert.match(SHELL, /const userDataDir = floorArgs \? floorArgs\.dataDir :/);
  assert.match(SHELL, /seedFloorConfig\(readSharedConfig\(floorArgs\.sharedDir\), floorArgs\.home\)/);
  assert.doesNotMatch(SHELL, /export function paramountHome\(\): string \{\s*return app\.getPath\('userData'\);/);
  assert.match(SHELL, /export function paramountHome\(\): string \{\s*return join\(app\.getPath\('home'\), PARAMOUNT_NAME\);/);
});

// ─── index.ts: picker, open here, New Floor process ─────────────────────────
function floorsBlock(gate, config, userData, spawnImpl, proc = {}) {
  const src = INDEX.slice(INDEX.indexOf('// ─── Floors (owner requests 2026-11-12'), INDEX.indexOf('/** First-run floor setup (paramount-floor-setup.ts)'));
  assert.ok(src.includes('function openFloorProcess('), 'index.ts has the floor process model');
  const calls = [];
  const ctx = { console, process, randomBytes: crypto.randomBytes, statSync: fs.statSync, mkdirSync: fs.mkdirSync, basename: path.basename, floorGate: gate,
    ...floors, floorOwnerName: loadTs('src/main/floor-lock.ts').floorOwnerName, spawn: spawnImpl ?? spawn,
    sharedDataDir: () => userData, TEST_LABEL: null, setTimeout: proc.setTimeout ?? setTimeout, clearTimeout: proc.clearTimeout ?? clearTimeout,
    isFloorProcess: () => !!proc.home, floorProcessHome: () => proc.home ?? null, allowQuit: false,
    app: { getPath: () => userData, getVersion: () => 'test', getAppPath: () => path.join(__dirname, 'fixtures', 'floor-child.cjs'), isPackaged: false, quit: () => calls.push(['app.quit']) },
    readConfig: () => config,
    writeConfig: (patch) => { calls.push(['writeConfig', patch]); if (patch.harnessHome) config.recentHives = [patch.harnessHome, ...(config.recentHives ?? []).filter((h) => h !== patch.harnessHome)]; Object.assign(config, patch); },
    ensureHarnessHome: (h) => { calls.push(['ensureHarnessHome', h]); fs.mkdirSync(path.join(h, 'hive'), { recursive: true }); return { ok: true }; },
    bootstrapHiveServices: () => { calls.push(['bootstrapHiveServices']); gate.claim(config.harnessHome); },
    newFloorPicker: proc.newFloorPicker ?? false, broadcastParamountInvalidation: proc.broadcastParamountInvalidation ?? (() => {}),
    closingTime: { cancel: () => calls.push(['closingTime.cancel']) }, teardownAndQuit: (o) => calls.push(['teardownAndQuit', o]), dialog: {},
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null }, ipcMain: { handle: () => {} } };
  const js = ts.transpileModule(src + '\nif (__initialNewFloorPicker) newFloorPicker = true; Object.assign(globalThis, { floorChoice, openChosenFloor, openFloorProcess, requestFloorPicker, floorWindowTitle, switchFloor, readNewFloorPicker: () => newFloorPicker });', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  ctx.__initialNewFloorPicker = !!proc.newFloorPicker;
  vm.runInNewContext(js, ctx);
  ctx.calls = calls; // the live context, so flags the code sets (allowQuit) are visible
  return ctx;
}

test('boot: the main process claims no floor; a floor process opens its own; a location change reopens directly', () => {
  const boot = INDEX.slice(INDEX.indexOf('registerParamountProtocol();'), INDEX.indexOf('registerParamountRuntime({'));
  assert.match(boot, /if \(floorProcessHome\(\) && boot\.open\) \{[\s\S]*?bootstrapHiveServices\(\);[\s\S]*?PARAMOUNT_FLOOR_OPENED/,
    'a floor process opens the home bootFloorPlan names before acknowledging readiness');
  assert.match(boot, /const boot = bootFloorPlan\(process\.argv, readConfig\(\)\.harnessHome \?\? null\);/);
  assert.doesNotMatch(boot.replace(/if \(floorProcessHome\(\) && boot\.open\) \{[\s\S]*?\n    \}/, ''), /bootstrapHiveServices\(\);/);
  assert.match(boot, /!dataFolderRefusal\(cfg\.harnessHome, appDataDirs\(\)\)\) writeConfig\(\{ onboardingComplete: true \}\)/, 'a data-folder home is not re-marked as set up');
  assert.match(INDEX, /app\.relaunch\(\{ args: moveRelaunchArgs\(process\.argv\.slice\(1\), moveTo\) \}\);/);
});

test('launch picker: recents with their state, last preselectable, nothing locked before a choice', (t) => {
  const w = world(t);
  const config = { onboardingComplete: true, harnessHome: w.a, recentHives: [w.a, w.b, w.held, w.gone, w.userData] };
  const gate = createFloorGate(me(w.userData), isAlive);
  const c = floorsBlock(gate, config, w.userData);
  const choice = plain(c.floorChoice());
  assert.equal(choice.pending, true); assert.equal(choice.newFloor, false); assert.equal(choice.last, w.a);
  assert.deepEqual(choice.recents.map((r) => [r.path, r.state]), [[w.a, 'free'], [w.b, 'free'], [w.held, 'held'], [w.gone, 'missing'], [w.userData, 'data-folder']]);
  assert.equal(choice.recents[2].heldBy, `Munder Difflin 0.5.7 (pid ${MUNDER_PID})`);
  assert.equal(gate.state().state, 'none');
  for (const d of [w.a, w.b]) assert.equal(fs.existsSync(path.join(d, 'hive', FLOOR_LOCK_FILE)), false);
  const deps = { config: () => config, suggestedHome: () => '/tmp/P', engines: () => [], floor: { state: () => gate.state(), choice: c.floorChoice } };
  assert.deepEqual(plain(floorSetupState(deps).choice), choice);
});

test('launch-choose opens A here; a Munder-held floor and the data folder are refused with nothing written', (t) => {
  const w = world(t);
  const config = { onboardingComplete: true, harnessHome: w.a, recentHives: [w.a, w.held] };
  const gate = createFloorGate(me(w.userData), isAlive);
  const c = floorsBlock(gate, config, w.userData);
  const before = snapshot(path.join(w.held, 'hive'));
  assert.equal(c.openChosenFloor(w.held).state, 'refused');
  assert.equal(c.openChosenFloor(w.userData).state, 'error');
  assert.deepEqual(snapshot(path.join(w.held, 'hive')), before, 'held floor byte-identical, no claim file');
  assert.deepEqual(fs.readdirSync(w.userData), [], 'nothing made in the data folder');
  assert.deepEqual(plain(c.calls), [], 'no folder, config or service work');
  assert.equal(c.floorChoice().pending, true);
  assert.equal(c.openChosenFloor(w.a).state, 'open');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.a, 'hive', FLOOR_LOCK_FILE), 'utf8')).pid, process.pid);
  assert.equal(c.floorWindowTitle(), 'Paramount — floor-a', 'the window says which floor');
  assert.equal(c.floorChoice().pending, false);
  gate.release();
});

/** A stand-in "floor process": holds its floor's lock (kernel claim) the way a floor process does. */
function holdFloor(t, home, userData) {
  const script = `const loadTs=require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))});const {acquireFloorLock}=loadTs('src/main/floor-lock.ts');
const r=acquireFloorLock(${JSON.stringify(path.join(home, 'hive'))},{pid:process.pid,userData:${JSON.stringify(userData)},version:'Paramount test'});process.stdout.write(r.ok?'held\\n':'refused\\n');process.stdin.resume();`;
  const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  return new Promise((res) => child.stdout.once('data', (d) => res({ child, said: String(d).trim() })));
}

test('New Floor…: B starts as its own detached process with its own data folder; two floors run at once; a third claim on B is refused', async (t) => {
  const w = world(t);
  const config = { onboardingComplete: true, harnessHome: w.a, recentHives: [w.a, w.b] };
  const gate = createFloorGate(me(w.userData), isAlive);
  const plans = [];
  const recordSpawn = (command, args, opts) => { plans.push({ command, args, opts }); return spawn(process.execPath, ['-e', 'process.stdout.write(`PARAMOUNT_FLOOR_OPENED:${process.env.PARAMOUNT_FLOOR_OPEN_ACK}\\n`)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: opts.env }); };
  const c = floorsBlock(gate, config, w.userData, recordSpawn);
  assert.equal(c.openChosenFloor(w.a).state, 'open');
  c.requestFloorPicker();
  assert.equal(c.floorChoice().newFloor, true);
  assert.deepEqual(plain(c.floorChoice().recents.map((r) => r.state)), ['current', 'free']);
  const r = await c.openFloorProcess(w.b);
  assert.deepEqual(plain(r), { ok: true, home: w.b });
  const dataDir = path.join(w.userData, 'floors', crypto.createHash('sha1').update(w.b).digest('hex').slice(0, 12));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].opts.detached, true);
  assert.deepEqual(plans[0].args.slice(-3), [`--floor-data=${dataDir}`, `--floor-shared=${w.userData}`, `--floor-home=${w.b}`]);
  assert.ok(fs.statSync(dataDir).isDirectory());
  assert.equal(c.floorChoice().newFloor, false, 'the picker closes');
  assert.equal(gate.state().state, 'open', 'A stays open in this process');
  // The floor process holds B (stand-in with B's data folder as its profile): A and B at once.
  const b = await holdFloor(t, w.b, dataDir);
  assert.equal(b.said, 'held');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.a, 'hive', FLOOR_LOCK_FILE), 'utf8')).pid, process.pid);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.b, 'hive', FLOOR_LOCK_FILE), 'utf8')).pid, b.child.pid);
  // A third launch on B: the probe shows it held, New Floor refuses it, a gate claim is refused.
  assert.equal(plain(c.floorChoice()).recents.find((x) => x.path === w.b), undefined, 'picker closed');
  c.requestFloorPicker();
  assert.equal(plain(c.floorChoice()).recents.find((x) => x.path === w.b).state, 'held');
  const third = await c.openFloorProcess(w.b);
  assert.equal(third.ok, false); assert.equal(third.refusal, 'held');
  assert.equal(plans.length, 1, 'no process started for a held floor');
  const other = createFloorGate(me(path.join(w.root, 'third-profile')), () => true);
  assert.equal(other.claim(w.b).state, 'refused');
  gate.release();
});

test('New Floor acknowledgement is exact-once, bounded, and ignored after failure', async (t) => {
  const w = world(t);
  const config = { onboardingComplete: true, harnessHome: w.a, recentHives: [] };
  const gate = createFloorGate(me(w.userData), isAlive);
  const timers = [];
  const proc = { setTimeout: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; }, clearTimeout: (timer) => { timer.cleared = true; } };
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.unref = () => {}; child.kill = () => true; child.pid = 123;
  const c = floorsBlock(gate, config, w.userData, (_cmd, _args, opts) => { child.token = opts.env.PARAMOUNT_FLOOR_OPEN_ACK; return child; }, proc);
  const result = c.openFloorProcess(w.b);
  const ack = `PARAMOUNT_FLOOR_OPENED:${child.token}`;
  const startup = timers.find((timer) => timer.ms === 15000);
  child.stdout.emit('data', `noise\n${ack.slice(0, 20)}`);
  child.stdout.emit('data', `${ack.slice(20)}\r\n${'x'.repeat(300)}\n`);
  assert.equal(plain(await result).ok, true);
  child.stdout.emit('data', `${ack}\nnoise\n`);
  assert.equal(c.calls.filter(([name]) => name === 'writeConfig').length, 1);
  assert.equal(timers.filter((timer) => timer.ms === 250).length, 0);
  assert.equal(startup.cleared, true);

  const lateChild = new EventEmitter(); lateChild.stdout = new EventEmitter(); lateChild.kill = () => true;
  const lateTimers = [];
  const late = floorsBlock(gate, config, w.userData, (_cmd, _args, opts) => { lateChild.token = opts.env.PARAMOUNT_FLOOR_OPEN_ACK; return lateChild; }, {
    ...proc, newFloorPicker: true, setTimeout: (callback, ms) => { const timer = { callback, ms, cleared: false }; lateTimers.push(timer); return timer; }
  });
  const failed = late.openFloorProcess(w.b);
  lateTimers.find((timer) => timer.ms === 15000).callback();
  assert.equal(plain(await failed).ok, false);
  lateChild.stdout.emit('data', `PARAMOUNT_FLOOR_OPENED:${lateChild.token}\n`);
  assert.equal(late.calls.some(([name]) => name === 'writeConfig'), false);
  assert.equal(late.readNewFloorPicker(), true);
  assert.equal(lateTimers.some((timer) => timer.ms === 250), false);

  const wrongChild = new EventEmitter(); wrongChild.stdout = new EventEmitter(); wrongChild.kill = () => true;
  const wrongTimers = [];
  const wrong = floorsBlock(gate, config, w.userData, () => wrongChild, { ...proc, setTimeout: (callback, ms) => { const timer = { callback, ms }; wrongTimers.push(timer); return timer; } });
  const wrongResult = wrong.openFloorProcess(w.b);
  wrongChild.stdout.emit('data', 'PARAMOUNT_FLOOR_OPENED:wrong\n');
  wrongTimers.find((timer) => timer.ms === 15000).callback();
  assert.equal(plain(await wrongResult).ok, false);

  for (const terminal of ['error', 'exit']) {
    const failedChild = new EventEmitter(); failedChild.stdout = new EventEmitter(); failedChild.kill = () => true;
    const failure = floorsBlock(gate, config, w.userData, () => failedChild, proc);
    const failureResult = failure.openFloorProcess(w.b);
    failedChild.emit(terminal, ...(terminal === 'error' ? [new Error('spawn failed')] : [2, null]));
    assert.equal(plain(await failureResult).ok, false);
    failedChild.stdout.emit('data', `PARAMOUNT_FLOOR_OPENED:ignored\n`);
    assert.equal(failure.calls.some(([name]) => name === 'writeConfig'), false);
  }

  const sideEffectChild = new EventEmitter(); sideEffectChild.stdout = new EventEmitter(); sideEffectChild.unref = () => {};
  const sideEffect = floorsBlock(gate, config, w.userData, (_cmd, _args, opts) => { sideEffectChild.token = opts.env.PARAMOUNT_FLOOR_OPEN_ACK; return sideEffectChild; }, {
    ...proc, newFloorPicker: true, broadcastParamountInvalidation: () => { throw new Error('broadcast failed'); }
  });
  const sideEffectResult = sideEffect.openFloorProcess(w.b);
  sideEffectChild.stdout.emit('data', `PARAMOUNT_FLOOR_OPENED:${sideEffectChild.token}\n`);
  assert.equal(plain(await sideEffectResult).ok, false);
  assert.equal(sideEffect.calls.filter(([name]) => name === 'writeConfig').length, 1);
  assert.equal(sideEffect.readNewFloorPicker(), true, 'failed success-side effects leave the picker open');
});

test('the app menu (always installed, not behind multiWindow) has New Floor… (Cmd+Shift+N) and Switch floor…', () => {
  assert.match(INDEX, /label: 'New Floor…',\s*accelerator: 'CmdOrCtrl\+Shift\+N',\s*click: \(\) => \{ requestFloorPicker\(\); \}/);
  assert.match(INDEX, /const switchFloorItem = \{ label: 'Switch floor…', click: \(\) => \{ void confirmSwitchFloor\(\); \} \};/);
  assert.match(INDEX, /\n  installAppMenu\(\);/);
  assert.doesNotMatch(INDEX, /if \(readConfig\(\)\.multiWindow\) installAppMenu\(\);/);
  const confirm = INDEX.slice(INDEX.indexOf('async function confirmSwitchFloor('));
  assert.ok(confirm.indexOf('dialog.showMessageBox') < confirm.indexOf('if (r.response === 0) switchFloor();'), 'asks first');
  assert.match(INDEX, /title: floorWindowTitle\(\),/);
});

test('Switch floor: stops agents through the quit path and relaunches at the picker; with no floor open it only shows the picker', (t) => {
  const w = world(t);
  const config = { onboardingComplete: true, harnessHome: w.a, recentHives: [w.a, w.b] };
  let gate = createFloorGate(me(w.userData), isAlive);
  let c = floorsBlock(gate, config, w.userData);
  c.switchFloor();
  assert.deepEqual(plain(c.calls), [], 'nothing open: nothing to stop');
  assert.equal(c.openChosenFloor(w.a).state, 'open');
  c.switchFloor();
  assert.deepEqual(plain(c.calls.slice(-2)), [['closingTime.cancel'], ['teardownAndQuit', { relaunch: true }]]);
  gate.release(); // will-quit in the real app
  // The relaunched process: picker, then B.
  gate = createFloorGate(me(w.userData), isAlive);
  c = floorsBlock(gate, config, w.userData);
  assert.equal(c.floorChoice().pending, true);
  assert.equal(c.openChosenFloor(w.b).state, 'open');
  assert.equal(fs.existsSync(path.join(w.a, 'hive', FLOOR_LOCK_FILE)), false);
  assert.equal(fs.readFileSync(path.join(w.a, 'hive', 'registry.json'), 'utf8'), '{"floor":"A"}', "A's agent records are untouched");
  gate.release();
  const body = INDEX.slice(INDEX.indexOf('function teardownAndQuit('), INDEX.indexOf("ipcMain.handle('app:confirmClose'"));
  const order = ['for (const fn of beforeTeardown)', 'ptyManager.killAll()', 'if (opts.relaunch) app.relaunch({ args: switchRelaunchArgs(process.argv.slice(1)) });', 'app.quit();'].map((x) => body.indexOf(x));
  assert.ok(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), 'live agents recorded, terminals stopped, then relaunch and quit');
});

// Review F1, F2 (52051eda): Switch floor reopened the same floor in a floor process or after a Floor
// location change, and a floor process opened whatever home its config named, not its --floor-home.
const floorArgv = (data, shared, home) => ['/App/Paramount', `--floor-data=${data}`, `--floor-shared=${shared}`, `--floor-home=${home}`];

test('boot plan: a floor process opens its own --floor-home even when its config names another home; after Switch, the picker', () => {
  const argv = floorArgv('/S/floors/b', '/S', '/w/B');
  assert.deepEqual(plain(floors.bootFloorPlan(argv, '/w/C')), { open: '/w/B', rewriteConfig: true });
  assert.deepEqual(plain(floors.bootFloorPlan(argv, '/w/B')), { open: '/w/B', rewriteConfig: false });
  assert.deepEqual(plain(floors.bootFloorPlan([...argv, floors.FLOOR_PICKER_FLAG], '/w/B')), { open: null, rewriteConfig: false });
  assert.deepEqual(plain(floors.bootFloorPlan(['/App/Paramount'], '/w/A')), { open: null, rewriteConfig: false }, 'main: the picker');
  assert.deepEqual(plain(floors.bootFloorPlan(['/App/Paramount', floors.OPEN_LAST_FLOOR_FLAG], '/w/A')), { open: '/w/A', rewriteConfig: false }, 'main after a location change');
});

test('Switch floor relaunch args: never the Floor location flag; a floor process keeps its floor and starts at its picker', () => {
  const args = floorArgv('/S/floors/b', '/S', '/w/B').slice(1);
  const sw = floors.switchRelaunchArgs(args);
  assert.deepEqual(sw, [...args, floors.FLOOR_PICKER_FLAG]);
  assert.deepEqual(floors.switchRelaunchArgs(sw), sw, 'a second Switch adds no second flag');
  assert.equal(floors.bootFloorPlan(['/App/Paramount', ...sw], '/w/B').open, null, 'the relaunched floor process shows the picker');
  assert.deepEqual(floors.switchRelaunchArgs(['--user-data-dir=/P', floors.OPEN_LAST_FLOOR_FLAG]), ['--user-data-dir=/P'], 'main after a location change: the picker');
  assert.equal(floors.bootFloorPlan(['/App/Paramount', '--user-data-dir=/P'], '/w/A').open, null);
});

test('Floor location in a floor process restarts it as the new home\'s floor, on that home\'s data folder', () => {
  const args = floorArgv('/S/floors/b', '/S', '/w/B').slice(1);
  const moved = floors.moveRelaunchArgs([...args, floors.FLOOR_PICKER_FLAG], { home: '/w/C', dataDir: '/S/floors/c' });
  assert.deepEqual(moved, ['--floor-data=/S/floors/c', '--floor-shared=/S', '--floor-home=/w/C']);
  assert.deepEqual(plain(floors.bootFloorPlan(['/App/Paramount', ...moved], '/w/C')), { open: '/w/C', rewriteConfig: false });
  assert.deepEqual(floors.moveRelaunchArgs(['--user-data-dir=/P', floors.OPEN_LAST_FLOOR_FLAG], { home: '/w/C', dataDir: 'x' }), ['--user-data-dir=/P', floors.OPEN_LAST_FLOOR_FLAG], 'main: reopen the configured floor once');
  // The config write and state copy run through the real handler in floor-lock-services.test.cjs.
});

test('a floor process at its picker opens another floor as that floor\'s own process, then closes', async (t) => {
  const w = world(t);
  const config = { onboardingComplete: true, harnessHome: w.a, recentHives: [w.a, w.b] };
  const gate = createFloorGate(me(w.userData), isAlive);
  const plans = [];
  const recordSpawn = (command, args, opts) => { plans.push({ command, args, opts }); return spawn(process.execPath, ['-e', 'process.stdout.write(`PARAMOUNT_FLOOR_OPENED:${process.env.PARAMOUNT_FLOOR_OPEN_ACK}\\n`)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: opts.env }); };
  const c = floorsBlock(gate, config, w.userData, recordSpawn, { home: w.a });
  assert.equal(c.floorChoice().pending, true, 'relaunched after Switch: nothing open');
  const r = await c.openFloorProcess(w.b);
  assert.equal(r.ok, true);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].args.at(-1), `--floor-home=${w.b}`);
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(c.allowQuit, true);
  assert.deepEqual(plain(c.calls.filter((x) => x[0] === 'app.quit')), [['app.quit']], 'this floor process closes');
  assert.equal(config.harnessHome, w.a, "this process's config still names its own home");
});

// ─── commands ───────────────────────────────────────────────────────────────
function commandFixture({ pending = true, openState = { state: 'open', floor: '/f/a' }, processResult = { ok: true, home: '/f/b' }, complete = true } = {}) {
  const calls = [];
  const deps = { config: () => ({ onboardingComplete: complete, harnessHome: complete ? '/f/a' : null }), suggestedHome: () => '/tmp/P', engines: () => [], publish: (e) => calls.push(['publish', e.command.type]),
    floor: { state: () => ({ state: 'none' }), claim() {}, retry() {}, chooseAnother() {}, choice: () => ({ pending, newFloor: !pending, last: '/f/a', recents: [] }),
      open: (home) => { calls.push(['open', home]); return openState; }, openProcess: async (home) => { calls.push(['openProcess', home]); return processResult; },
      picker: (open) => calls.push(['picker', open]), switchFloor: () => calls.push(['switchFloor']), dataFolderRefusal: () => null } };
  return { calls, run: (cmd) => dispatchFloorSetup(cmd, deps, span) };
}

test('floor.open in a floor process at its picker: its own home opens here, any other home as its own process', async () => {
  const calls = [];
  const deps = { config: () => ({ onboardingComplete: true, harnessHome: '/f/a' }), suggestedHome: () => '/tmp/P', engines: () => [], publish: () => {},
    floor: { state: () => ({ state: 'none' }), claim() {}, retry() {}, chooseAnother() {}, choice: () => ({ pending: true, newFloor: false, last: '/f/a', recents: [] }),
      open: (home) => { calls.push(['open', home]); return { state: 'open', floor: home }; }, openProcess: async (home) => { calls.push(['openProcess', home]); return { ok: true, home }; },
      ownHome: () => '/f/a', picker() {}, switchFloor() {}, dataFolderRefusal: () => null } };
  assert.equal(dispatchFloorSetup({ type: 'floor.open', home: '/f/a' }, deps, span).ok, true);
  assert.equal((await dispatchFloorSetup({ type: 'floor.open', home: '/f/b' }, deps, span)).ok, true);
  assert.deepEqual(calls, [['open', '/f/a'], ['openProcess', '/f/b']]);
});

test('floor.open opens here at launch and starts a process with a floor open; floor.picker; refusals', async () => {
  let f = commandFixture();
  assert.equal(f.run({ type: 'floor.open', home: '/f/b' }).ok, true);
  assert.deepEqual(f.calls, [['open', '/f/b'], ['publish', 'floor.open']]);
  f = commandFixture({ pending: false });
  assert.equal((await f.run({ type: 'floor.open', home: '/f/b' })).ok, true);
  assert.deepEqual(f.calls, [['openProcess', '/f/b'], ['publish', 'floor.open']]);
  f = commandFixture({ pending: false, processResult: { ok: false, refusal: 'held', error: 'That folder is open in another floor (pid 9).' } });
  const held = await f.run({ type: 'floor.open', home: '/f/b' });
  assert.equal(held.error.code, 'CONFLICT');
  const refused = commandFixture({ openState: { state: 'refused', refusal: { floor: '/f/m', owner: 'Munder Difflin 0.5.7', pid: MUNDER_PID, since: '', userData: '' } } }).run({ type: 'floor.open', home: '/f/m' });
  assert.match(refused.error.message, new RegExp(`Munder Difflin 0\\.5\\.7 \\(pid ${MUNDER_PID}\\) has this floor open`));
  assert.equal(commandFixture().run({ type: 'floor.open', home: 'relative' }).error.code, 'INVALID_INPUT');
  assert.equal(commandFixture({ complete: false }).run({ type: 'floor.open', home: '/f/b' }).error.code, 'CONFLICT', 'setup comes first');
  f = commandFixture({ pending: false });
  assert.equal(f.run({ type: 'floor.picker', open: true }).ok, true);
  assert.deepEqual(f.calls, [['picker', true], ['publish', 'floor.picker']]);
  assert.equal(f.run({ type: 'floor.picker' }).error.code, 'INVALID_INPUT');
  f = commandFixture({ pending: false });
  assert.equal(f.run({ type: 'floor.switch' }).ok, true);
  assert.deepEqual(f.calls, [['switchFloor'], ['publish', 'floor.switch']]);
  assert.equal(f.run({ type: 'floor.switch', x: 1 }).error.code, 'INVALID_INPUT');
});

test("setup refuses the app's own data folder before any lock or write", () => {
  const calls = [];
  const deps = { config: () => ({ onboardingComplete: false, harnessHome: null }), suggestedHome: () => '/u/Paramount', ensureHome: (p) => { calls.push(['ensure', p]); return { ok: true }; },
    engines: () => [{ id: 'claude', label: 'Claude Code', orchestrator: true, installed: true, models: [] }], complete: () => calls.push(['complete']), appendEvent() {}, publish() {},
    floor: { state: () => ({ state: 'none' }), claim: (h) => { calls.push(['claim', h]); return { state: 'open', floor: h }; }, retry() {}, chooseAnother() {},
      dataFolderRefusal: (h) => floors.dataFolderRefusal(h, ['/u/Library/Application Support/Paramount']) } };
  const r = dispatchFloorSetup({ type: 'setup.complete', home: '/u/Library/Application Support/Paramount', engine: 'claude' }, deps, span);
  assert.equal(r.error.code, 'INVALID_INPUT');
  assert.equal(r.error.message, "A floor cannot use this floor's own data folder.");
  assert.deepEqual(calls, []);
});

// NSC-222 / review N5 (2f745936): Floor location in a floor process gave the new data folder only
// config.json (and, since, harness.db). Integration secrets, trigger history, Slack state and the
// knowledge store stayed in the old data folder, so integrations lost their saved secret after a Move.
test('Floor location in a floor process carries the floor\'s own state files to the new data folder', (t) => {
  const root = tmp(t, 'council-move-state-');
  const from = path.join(root, 'floors', 'b'), to = path.join(root, 'floors', 'c');
  fs.mkdirSync(path.join(from, 'knowledge'), { recursive: true });
  fs.mkdirSync(path.join(from, 'slack-files'), { recursive: true });
  fs.writeFileSync(path.join(from, 'integration-secrets.json'), '{"sealed":"x"}', { mode: 0o600 });
  fs.writeFileSync(path.join(from, 'trigger-history.json'), '[1]');
  fs.writeFileSync(path.join(from, 'slack-reply.json'), '{}');
  fs.writeFileSync(path.join(from, 'knowledge', 'store.json'), '{"docs":1}');
  fs.writeFileSync(path.join(from, 'slack-files', 'a.bin'), 'file');
  fs.writeFileSync(path.join(from, 'model-catalog.json'), 'cache');
  fs.mkdirSync(path.join(from, 'Cache'));
  const copied = floors.copyFloorMovedState(from, to);
  assert.deepEqual([...copied].sort(), ['integration-secrets.json', 'knowledge', 'slack-files', 'slack-reply.json', 'trigger-history.json']);
  assert.equal(fs.readFileSync(path.join(to, 'integration-secrets.json'), 'utf8'), '{"sealed":"x"}');
  assert.equal(fs.statSync(path.join(to, 'integration-secrets.json')).mode & 0o777, 0o600, 'secrets keep owner-only mode');
  assert.equal(fs.readFileSync(path.join(to, 'knowledge', 'store.json'), 'utf8'), '{"docs":1}');
  assert.equal(fs.readFileSync(path.join(to, 'slack-files', 'a.bin'), 'utf8'), 'file');
  assert.equal(fs.existsSync(path.join(to, 'model-catalog.json')), false, 'caches are rebuilt, not copied');
  assert.equal(fs.existsSync(path.join(to, 'Cache')), false, 'Chromium profile data is not copied');
  assert.equal(fs.readFileSync(path.join(from, 'integration-secrets.json'), 'utf8'), '{"sealed":"x"}', 'the old data folder is kept');
  assert.deepEqual(floors.copyFloorMovedState(path.join(root, 'none'), path.join(root, 'none-to')), [], 'nothing to carry');
});
