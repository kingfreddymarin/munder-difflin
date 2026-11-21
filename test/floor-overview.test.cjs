'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const vm = require('node:vm');
const ts = require('typescript');
const load = require('./load-ts.cjs');

const { createFloorOverview, projectFloorRows } = load('src/main/floor-overview.ts');
const { createFloorGate, readFloorLock } = load('src/main/floor-lock.ts');
const { floorDataDirFor } = load('src/main/floors.ts');

const rowsFor = (label, status = 'doing') => projectFloorRows(
  { agents: { god: { name: label, sessionId: 'private' }, archived: { archived: true } } },
  { tasks: [{ id: 'NSC-1', title: label + ' task', status, description: 'private', webhook: { tokenHash: 'private' } }] },
  () => ({ status: 'working' }), []
);

async function until(read) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for floor overview fixture');
}

test('projection exposes only labelled active agents and task rows', () => {
  assert.deepEqual(rowsFor('Alpha'), {
    agents: [{ id: 'god', label: 'Alpha', status: 'working' }],
    tasks: [{ id: 'NSC-1', label: 'Alpha task', status: 'doing' }]
  });
  assert.deepEqual(projectFloorRows(null, { tasks: [null, { id: 1 }] }, () => ({ status: 'offline' }), []), { agents: [], tasks: [] });
});

const mainSource = fs.readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8');
const preloadSource = fs.readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8');
const uiUrl = 'http://localhost:5173/';
const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

function overviewHandlers(overrides = {}) {
  const start = mainSource.indexOf('const floorOverview = createFloorOverview(');
  const end = mainSource.indexOf('// ─── Floors (owner requests', start);
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  let options;
  const context = vm.createContext({
    createFloorOverview: value => { options = value; },
    URL, ipcMain, sharedDataDir: () => '/profile', app: { getPath: () => '/profile' },
    floorHome: () => '/floor', paramountUiUrl: () => uiUrl, projectFloorRows,
    ...overrides
  });
  vm.runInContext(compile(mainSource.slice(start, end)), context);
  return { options, ipcMain, context };
}

test('overview preserves regular-floor status precedence with and without a live terminal', () => {
  const { options } = overviewHandlers({
    hive: {
      registry: () => ({ agents: {
        'blocked-live': { status: 'blocked' }, 'blocked-offline': { status: 'blocked' },
        'crashed-live': { status: 'crashed' }, 'crashed-offline': {},
        'constrained-live': { status: 'blocked' }, 'stopped-offline': { status: 'crashed' },
        busy: { status: 'idle' }, quiet: { status: 'working' }, absent: { status: 'idle' }
      } }),
      tasks: () => ({ tasks: [] })
    },
    roster: { read: () => ({ agents: [{ id: 'crashed-offline', status: 'error' }] }) },
    breaker: { levelFor: id => ({ 'constrained-live': 'constrained', 'stopped-offline': 'stopped' })[id] ?? 'healthy' },
    ptyForAgent: id => id.endsWith('-live') || id === 'busy' || id === 'quiet' ? id : undefined,
    ptyManager: { lastOutputAt: id => id === 'quiet' ? 0 : Date.now() },
    WORKER_WAKE_IDLE_MS: 10_000
  });
  assert.deepEqual(Object.fromEntries(options.rows().agents.map(({ id, status }) => [id, status])), {
    'blocked-live': 'waiting', 'blocked-offline': 'waiting', 'crashed-live': 'crashed', 'crashed-offline': 'crashed',
    'constrained-live': 'constrained', 'stopped-offline': 'constrained', busy: 'working', quiet: 'idle', absent: 'offline'
  });
});

function floorControlsFixture() {
  let renderer;
  let frameId = 0;
  const queuedIpc = [];
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (channel, ...args) => {
      const target = renderer;
      queuedIpc.push(() => target.emit(channel, {}, ...args));
    }
  });
  const win = { webContents: wc, isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {} };
  const { options, ipcMain, context } = overviewHandlers({ mainWindow: win });
  const navStart = mainSource.indexOf("win.webContents.on('did-start-navigation'");
  const navEnd = mainSource.indexOf('  // Paramount: the UI', navStart);
  context.win = win;
  context.wc = wc;
  vm.runInContext(compile(mainSource.slice(navStart, navEnd)), context);
  const preloadStart = preloadSource.indexOf('  onFloorViewControls:');
  const preloadEnd = preloadSource.indexOf('  paramountSnapshot:', preloadStart);
  const bridge = compile('({' + preloadSource.slice(preloadStart, preloadEnd) + '})');
  return {
    focus: options.focus,
    navigate: (isSameDocument = false) => wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument }),
    flush: () => {
      while (queuedIpc.length) queuedIpc.shift()();
    },
    commit: () => {
      const ipcRenderer = new EventEmitter();
      const frame = { url: uiUrl, parent: null, processId: 1, routingId: ++frameId };
      renderer = ipcRenderer;
      wc.mainFrame = frame;
      wc.emit('did-frame-navigate', {}, uiUrl, 200, 'OK', true, frame.processId, frame.routingId);
      ipcRenderer.send = (channel, ...args) => queuedIpc.push(() => ipcMain.emit(channel, {
        sender: wc, senderFrame: frame, processId: frame.processId, frameId: frame.routingId
      }, ...args));
      const api = vm.runInNewContext(bridge, { ipcRenderer });
      return {
        finishLoad: () => wc.emit('did-finish-load'),
        subscribe: () => {
          let visible = true;
          api.onFloorViewControls(() => { visible = false; });
          return () => visible;
        }
      };
    }
  };
}

test('Open floor reaches a renderer subscribing after initial load and reload', () => {
  const f = floorControlsFixture();
  f.navigate();
  assert.equal(f.focus(), true);
  const first = f.commit();
  first.finishLoad();
  const initial = first.subscribe();
  f.flush();
  const oldDocument = first.subscribe();
  f.flush();

  // Begin a full reload while the old renderer still exists, then finish the
  // document load before the new FloorProvider resolves its first snapshot.
  f.navigate();
  assert.equal(f.focus(), true);
  const next = f.commit();
  next.finishLoad();
  const reloaded = next.subscribe();
  f.flush();
  const subsequent = next.subscribe();
  f.flush();
  assert.deepEqual([initial(), oldDocument(), reloaded(), subsequent()], [false, true, false, true]);
  f.navigate(true);
  assert.equal(f.focus(), true);
  f.flush();
  assert.equal(subsequent(), false, 'same-document navigation keeps the mounted target ready');
});

test('queued outgoing readiness cannot consume Open floor controls before reload commits', () => {
  const f = floorControlsFixture();
  f.navigate();
  const outgoing = f.commit();
  outgoing.finishLoad();
  const outgoingVisible = outgoing.subscribe();

  f.navigate();
  assert.equal(f.focus(), true);
  f.flush();

  const incoming = f.commit();
  const incomingVisible = incoming.subscribe();
  f.flush();
  assert.equal(incomingVisible(), false, 'the incoming document handles the request after commit');
  assert.equal(outgoingVisible(), true, 'the outgoing document receives no controls request');
  incoming.finishLoad();
  const subsequent = incoming.subscribe();
  f.flush();
  assert.equal(subsequent(), true, 'acknowledgment clears the pending request');
});

test('separate processes share views and route focus, with no foreign or stale floor access', { timeout: 20_000 }, async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'council-overview-'));
  const shared = join(root, 'profile');
  const a = join(root, 'one', 'floor');
  const b = join(root, 'two', 'floor');
  const foreign = join(root, 'foreign');
  const profileB = floorDataDirFor(shared, b);
  const markerDir = join(shared, 'floor-overview-v1');
  for (const dir of [a, b, foreign]) fs.mkdirSync(join(dir, 'hive'), { recursive: true });
  const foreignProfile = join(root, 'other-application');
  const gate = createFloorGate({ pid: process.pid, userData: shared, version: 'Paramount test' });
  const foreignGate = createFloorGate({ pid: process.pid, userData: foreignProfile, version: 'Munder test' });
  assert.equal(gate.claim(a).state, 'open');
  assert.equal(foreignGate.claim(foreign).state, 'open');
  const lock = readFloorLock(join(foreign, 'hive'));
  const own = createFloorOverview({ shared, profile: shared, home: () => gate.homeFor(a), rows: () => rowsFor('Alpha'), focus: () => true });
  const other = createFloorOverview({ shared, profile: foreignProfile, home: () => foreignGate.homeFor(foreign), rows: () => { throw new Error('must not project'); }, focus: () => false });
  own.start();
  other.start();
  const code = `
    const load = require(process.argv[1]);
    const { createFloorGate } = load('src/main/floor-lock.ts');
    const { createFloorOverview } = load('src/main/floor-overview.ts');
    const [shared, profile, home] = process.argv.slice(2);
    const gate = createFloorGate({ pid: process.pid, userData: profile, version: 'Paramount test' });
    if (gate.claim(home).state !== 'open') throw new Error('fixture could not claim');
    let label = 'Beta';
    const peer = createFloorOverview({ shared, profile, home: () => gate.homeFor(home),
      rows: () => ({ agents: [{ id: 'god', label, status: 'idle' }], tasks: [{ id: 'NSC-1', label: 'Beta task', status: 'todo' }] }),
      focus: () => { process.send('focused'); return true; } });
    peer.start();
    process.on('message', (message) => {
      if (message === 'rename') label = 'Beta updated';
      if (message === 'release') gate.release();
      process.send(message);
    });
  `;
  const child = spawn(process.execPath, ['-e', code, require.resolve('./load-ts.cjs'), shared, profileB, b],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    own.stop();
    other.stop();
    gate.release();
    foreignGate.release();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const views = await until(async () => {
    const list = await own.list();
    return list.length === 2 ? list : null;
  });
  assert.deepEqual(views.map(view => [view.home, view.name, view.current]), [[a, 'floor', true], [b, 'floor', false]]);
  assert.notEqual(views[0].id, views[1].id);
  assert.deepEqual(views.map(view => view.agents[0].id), ['god', 'god']);
  assert.deepEqual(views.map(view => view.tasks[0].id), ['NSC-1', 'NSC-1']);
  assert.deepEqual(readFloorLock(join(foreign, 'hive')), lock);
  assert.equal(await own.focus('made-up-id'), false);
  let msg = once(child, 'message');
  assert.equal(await own.focus(views[1].id), true);
  assert.equal((await msg)[0], 'focused');

  msg = once(child, 'message');
  child.send('rename');
  await msg;
  assert.equal((await own.list())[1].agents[0].label, 'Beta updated');

  const filename = fs.readdirSync(markerDir).find(name => name.startsWith(child.pid + '-'));
  const markerPath = join(markerDir, filename);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(markerPath).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(marker).sort(), ['pid', 'port', 'profile', 'token']);
  const unauth = await fetch('http://127.0.0.1:' + marker.port + '/overview');
  assert.equal(unauth.status, 403);
  await unauth.text();

  msg = once(child, 'message');
  child.send('release');
  await msg;
  assert.equal(await own.focus(views[1].id), false, 'cached identities cannot target a released floor');
  assert.deepEqual((await own.list()).map(view => view.home), [a]);

  const exited = once(child, 'exit');
  child.kill();
  await exited;
  assert.deepEqual((await own.list()).map(view => view.home), [a]);
  assert.equal(fs.existsSync(markerPath), false, 'crashed peer marker is reaped');
  assert.equal(readFloorLock(join(a, 'hive')).pid, process.pid, 'other owner remains in place');
});
