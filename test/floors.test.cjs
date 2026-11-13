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
  const ctx = { console, process, statSync: fs.statSync, mkdirSync: fs.mkdirSync, basename: path.basename, floorGate: gate,
    ...floors, floorOwnerName: loadTs('src/main/floor-lock.ts').floorOwnerName, spawn: spawnImpl ?? spawn,
    sharedDataDir: () => userData, TEST_LABEL: null, setTimeout,
    isFloorProcess: () => !!proc.home, floorProcessHome: () => proc.home ?? null, allowQuit: false,
    app: { getPath: () => userData, getVersion: () => 'test', getAppPath: () => path.join(__dirname, 'fixtures', 'floor-child.cjs'), isPackaged: false, quit: () => calls.push(['app.quit']) },
    readConfig: () => config,
    writeConfig: (patch) => { calls.push(['writeConfig', patch]); if (patch.harnessHome) config.recentHives = [patch.harnessHome, ...(config.recentHives ?? []).filter((h) => h !== patch.harnessHome)]; Object.assign(config, patch); },
    ensureHarnessHome: (h) => { calls.push(['ensureHarnessHome', h]); fs.mkdirSync(path.join(h, 'hive'), { recursive: true }); return { ok: true }; },
    bootstrapHiveServices: () => { calls.push(['bootstrapHiveServices']); gate.claim(config.harnessHome); },
    broadcastParamountInvalidation: () => {},
    closingTime: { cancel: () => calls.push(['closingTime.cancel']) }, teardownAndQuit: (o) => calls.push(['teardownAndQuit', o]), dialog: {},
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null }, ipcMain: { handle: () => {} } };
  const js = ts.transpileModule(src + '\nObject.assign(globalThis, { floorChoice, openChosenFloor, openFloorProcess, requestFloorPicker, floorWindowTitle, switchFloor });', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js, ctx);
  ctx.calls = calls; // the live context, so flags the code sets (allowQuit) are visible
  return ctx;
}

test('boot: the main process claims no floor; a floor process opens its own; a location change reopens directly', () => {
  const boot = INDEX.slice(INDEX.indexOf('registerParamountProtocol();'), INDEX.indexOf('registerParamountRuntime({'));
  const floorBoot = 'if (floorProcessHome() && boot.open) { if (boot.rewriteConfig) writeConfig({ harnessHome: boot.open }); floorChosen = true; bootstrapHiveServices(); }';
  assert.ok(boot.includes(floorBoot), 'a floor process opens the home bootFloorPlan names');
  assert.match(boot, /const boot = bootFloorPlan\(process\.argv, readConfig\(\)\.harnessHome \?\? null\);/);
  assert.doesNotMatch(boot.replace(floorBoot, ''), /bootstrapHiveServices\(\);/);
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
  const recordSpawn = (command, args, opts) => { plans.push({ command, args, opts }); return spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' }); };
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
  assert.match(INDEX, /if \(isFloorProcess\(\)\) \{\s*try \{\s*mkdirSync\(moveTo\.dataDir, \{ recursive: true \}\);\s*writeFileSync\(join\(moveTo\.dataDir, 'config\.json'\), JSON\.stringify\(readConfig\(\), null, 2\), \{ encoding: 'utf8', mode: 0o600 \}\);/);
});

test('a floor process at its picker opens another floor as that floor\'s own process, then closes', async (t) => {
  const w = world(t);
  const config = { onboardingComplete: true, harnessHome: w.a, recentHives: [w.a, w.b] };
  const gate = createFloorGate(me(w.userData), isAlive);
  const plans = [];
  const recordSpawn = (command, args, opts) => { plans.push({ command, args, opts }); return spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' }); };
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
