'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const { electron, electronReady, appBuild, keyEvents, targetInRenderer } = require('./smoke-main-expressions.cjs');
const expectedBuild = process.argv[3] ?? '973656c0845cc9a0db0055fb366b0231688f699b';
const app = path.resolve(process.argv[2] ?? path.join(__dirname, 'mac-arm64/Paramount.app'));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nsc231-board-')));
const profile = path.join(work, 'profile');
const home = path.join(work, 'home');
const floor = path.join(work, 'floor');
const hive = path.join(floor, 'hive');
const ledger = path.join(hive, 'tasks.json');
const key = 'NSC-231';
const original = { id: key, title: 'Disposable smoke card', status: 'doing', dependsOn: [],
  createdAt: '2026-11-21T07:00:00Z', slackChannel: 'fixture-channel', slackThreadTs: '0.000001' };
for (const dir of [profile, home, hive]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(ledger, JSON.stringify({ tasks: [original] }));
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  harnessHome: floor, recentHives: [floor], onboardingComplete: true, autoMode: false,
  autoUpdate: false, telemetryEnabled: false, semanticMemory: false, reflectEnabled: false,
  orchestratorMaySpawn: false, slackEnabled: false, missions: [], automations: [],
}));
const shell = path.join(work, 'shell');
fs.writeFileSync(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n', { mode: 0o700 });
const readTask = () => JSON.parse(fs.readFileSync(ledger)).tasks.find(task => task.id === key);
let child, inspector, stderr = '', launchError;
async function until(label, read, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`App PID ${child.pid} exited before ${label}: ${child.signalCode ?? child.exitCode}`);
    }
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      if (!/Execution context was destroyed|Promise was collected/.test(error.message)) throw error;
    }
    await pause(100);
  }
  throw new Error('Timed out waiting for ' + label);
}
async function inspectorClient(url) {
  inspector = new WebSocket(url);
  const pending = new Map();
  let next = 0;
  inspector.onmessage = ({ data }) => {
    const result = JSON.parse(data);
    pending.get(result.id)?.(result);
  };
  await Promise.race([
    new Promise((resolve, reject) => { inspector.onopen = resolve; inspector.onerror = reject; }),
    pause(5000, null, { ref: false }).then(() => { throw new Error('Inspector connection timeout'); }),
  ]);
  return expression => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector evaluate timeout')); }, 5000);
    pending.set(id, reply => {
      clearTimeout(timer);
      pending.delete(id);
      if (reply.error || reply.result?.exceptionDetails) {
        reject(new Error(reply.error?.message ?? reply.result.exceptionDetails.exception?.description));
      } else resolve(reply.result.result.value);
    });
    inspector.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
async function run() {
  const exe = path.join(app, 'Contents/MacOS/Paramount');
  const args = ['--inspect=127.0.0.1:0', '--user-data-dir=' + profile, '--council-open-floor'];
  child = spawn(exe, args, {
    env: { PATH: '/usr/bin:/bin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: work, SHELL: shell,
      DO_NOT_TRACK: '1', CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', error => { launchError = error; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  child.stdout.on('data', chunk => { process.stdout.write(chunk); });
  console.log(JSON.stringify({ pid: child.pid, exe, args, work }));
  const main = await inspectorClient(await until('main inspector', () => /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(stderr)?.[1]));
  await until('Electron main ready', () => main(electronReady));
  assert.equal(await main(`${electron}.app.getPath('userData')`), profile);
  assert.equal(await main(`${electron}.app.getVersion()`), '0.4.6');
  assert.equal(await main(appBuild), expectedBuild);
  const windowExpr = `${electron}.BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('paramount://app/'))`;
  await until('packaged renderer', () => main(`Boolean(${windowExpr})`));
  await main(`(() => {
    const win = ${windowExpr};
    win.show();
    win.focus();
    win.webContents.focus();
    win.webContents.debugger.attach('1.3');
    return true;
  })()`);
  const page = script => main(`${windowExpr}.webContents.executeJavaScript(${JSON.stringify(script)})`);
  const input = (method, params) => main(`${windowExpr}.webContents.debugger.sendCommand(${JSON.stringify(method)}, ${JSON.stringify(params)})`);
  const target = (query, operation) => page(`(${targetInRenderer})(${JSON.stringify({ query, operation })})`);
  const selector = (value, scope) => ({ selector: value, scope });
  const named = (value, text, scope) => ({ ...selector(value, scope), text });
  const card = selector(`[data-board-card="${key}"]`);
  const menu = label => named('[role="menuitem"]', label);
  const describe = ({ selector: value, text }) => text ? `${value} "${text}"` : value;
  const present = query => until(describe(query), () => target(query), 5000);
  const hidden = query => until(describe(query) + ' hidden', async () => !await target(query), 5000);
  const expectFocus = query => until('focus on ' + describe(query), () => target(query, 'focused'), 2000);
  async function press(shortcut) {
    for (const event of keyEvents(shortcut)) await input('Input.dispatchKeyEvent', event);
  }
  async function click(query, button = 'left') {
    const position = await until('click position for ' + describe(query), () => target(query, 'center'), 5000);
    await input('Input.dispatchMouseEvent', { ...position, type: 'mouseMoved' });
    await input('Input.dispatchMouseEvent', { ...position, type: 'mousePressed', button, buttons: button === 'right' ? 2 : 1, clickCount: 1 });
    await input('Input.dispatchMouseEvent', { ...position, type: 'mouseReleased', button, buttons: 0, clickCount: 1 });
  }
  async function fill(query, text) {
    assert.equal(await target(query, 'select'), true, 'focus input ' + describe(query));
    await input('Input.insertText', { text });
  }
  async function cycle(shortcut, controls) {
    for (const control of controls) { await press(shortcut); await expectFocus(control); }
  }

  await page("location.hash = '#/board'");
  await present(card);
  await click(card, 'right');
  await expectFocus(menu('Rename…'));
  await press('Escape');
  await expectFocus(card);
  await press('Shift+F10');
  await expectFocus(menu('Rename…'));
  await press('ArrowDown');
  await expectFocus(menu('Edit fields…'));
  await press('Escape');
  await expectFocus(card);
  console.log('PASS right-click, Shift+F10, arrows and menu focus restoration');

  // Delay delivery of real card.update replies to exercise deterministic pending focus.
  // The original handler still performs its own sender check and persistence.
  await main(`(() => {
    const handlers = ${electron}.ipcMain._invokeHandlers;
    const native = handlers.get('paramount:dispatch');
    handlers.set('paramount:dispatch', async (event, command) => {
      const result = await native(event, command);
      if (command?.type === 'card.update' && command.key === '${key}' && globalThis.holdBoardReply) {
        await new Promise(resolve => { globalThis.releaseBoardReply = resolve; });
      }
      return result;
    });
    return true;
  })()`);
  for (const rename of [true, false]) {
    await expectFocus(card);
    await press('Shift+F10');
    if (!rename) await press('ArrowDown');
    await press('Enter');
    const scope = rename ? `[role="group"][aria-label="Rename ${key}"]` : '[role="dialog"]';
    const overlay = selector(scope);
    const title = selector(rename ? '#card-rename' : '#ec-title', scope);
    const close = named('button', 'Close', scope);
    const cancel = named('button', 'Cancel', scope);
    const save = named('button', 'Save', scope);
    const description = selector('#ec-desc', scope);
    const updatedTitle = 'Renamed in native Board';
    const updatedDescription = 'Description added in native Board';
    await expectFocus(title);
    if (rename) await fill(title, updatedTitle);
    else await fill(description, updatedDescription);
    assert.equal(await target(title, 'focus'), true);
    const inner = rename ? [] : [description, selector('#ec-agent', scope), named('[role="radio"]', 'P1', scope)];
    await cycle('Tab', rename ? [save, cancel, title] : [...inner, cancel, save, close, title]);
    await cycle('Shift+Tab', rename ? [cancel, save, title] : [close, save, cancel, ...inner.slice().reverse(), title]);
    await main('globalThis.holdBoardReply = true');
    await press('Enter');
    await present(selector('button[aria-disabled="true"]', scope));
    const pending = rename ? [] : [...inner, close];
    await cycle('Tab', [...pending, title, ...pending, title]);
    await cycle('Shift+Tab', [...pending.slice().reverse(), title]);
    await until('held real IPC reply', () => main('typeof globalThis.releaseBoardReply === "function"'));
    await main('globalThis.holdBoardReply = false; globalThis.releaseBoardReply(); delete globalThis.releaseBoardReply; true');
    await hidden(overlay);
    await expectFocus(card);
    assert.equal(readTask().title, updatedTitle);
    assert.equal(readTask().description, rename ? undefined : updatedDescription);
    console.log('PASS ' + (rename ? 'Rename' : 'Edit fields') + ' focus loop, pending Save, owner IPC persistence, and restored focus');
  }

  // An inspector-created window uses the same real preload and URL but is absent
  // from the application's owned-window registry. Its write must be refused.
  const beforeDenied = fs.readFileSync(ledger);
  const refused = await main(`(async () => {
    const { app, BrowserWindow } = ${electron};
    const guest = new BrowserWindow({ show: false, webPreferences: { preload: app.getAppPath() + '/out/preload/index.js' } });
    try {
      await guest.loadURL('paramount://app/index.html');
      return await guest.webContents.executeJavaScript(${JSON.stringify(`window.cth.paramountDispatch({ type: 'card.update', key: '${key}', patch: { title: 'Forbidden' } })`)});
    } finally { guest.destroy(); }
  })()`);
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.match(JSON.stringify(refused), /FORBIDDEN/i);
  assert.deepEqual(fs.readFileSync(ledger), beforeDenied);
  console.log('PASS non-owner IPC refused, ledger unchanged');

  await click(card, 'right');
  await click(menu('Archive'));
  await hidden(card);
  const newCard = selector('[data-board-focus-fallback]');
  await expectFocus(newCard);
  const archived = readTask();
  assert.equal(archived.status, 'doing');
  assert.equal(archived.slackChannel, original.slackChannel);
  assert.equal(archived.slackThreadTs, original.slackThreadTs);
  assert.ok(archived.boardArchivedAt);
  await main(`${windowExpr}.webContents.reload()`);
  await present(newCard);
  assert.equal(await target(card), false);
  console.log('PASS Board-only Archive, focus on New card, and hidden after reload');
}

const deadline = setTimeout(() => {
  child?.kill('SIGKILL');
  console.error('Native attempt reached the 90-second deadline. Disposable fixture: ' + work);
  process.exit(1);
}, 90000);
run().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
}).finally(async () => {
  clearTimeout(deadline);
  inspector?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await pause(100);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  if (stderr) console.error(stderr.trim());
  console.log('Disposable fixture retained at ' + work);
});
