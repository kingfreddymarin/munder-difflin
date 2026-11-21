'use strict';
// One packaged desktop smoke derived from the independent review fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { electron, electronReady, floorPeerProfile, hasAllFloorsView } = require('./smoke-main-expressions.cjs');
const app = path.resolve(process.argv[2] ?? path.join(__dirname, 'mac-arm64/Paramount.app'));
const executable = path.join(app, 'Contents/MacOS/Paramount');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-nsc218-package-')));
const profile = path.join(fixture, 'profile');
const a = path.join(fixture, 'floor-a');
const b = path.join(fixture, 'floor-b');
const peerProfile = floorPeerProfile(profile, b);
const privateHome = path.join(fixture, 'fake-home');
for (const dir of [profile, peerProfile, privateHome]) fs.mkdirSync(dir, { recursive: true });
for (const [home, label] of [[a, 'Alpha ledger'], [b, 'Beta ledger']]) {
  fs.mkdirSync(path.join(home, 'hive'), { recursive: true });
  fs.writeFileSync(path.join(home, 'hive', 'tasks.json'), JSON.stringify({
    tasks: [{ id: 'NSC-1', title: label, status: 'todo', dependsOn: [], priority: 1 }]
  }));
}
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  onboardingComplete: true, harnessHome: a, recentHives: [a, b],
  registeredRepos: [], autoMode: false, telemetryEnabled: false, semanticMemory: false,
  reflectEnabled: false, knowledgeGraph: false, slackEnabled: false, missions: []
}));
const shell = path.join(fixture, 'fake-shell');
fs.writeFileSync(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n', { mode: 0o700 });
const processes = [];
function launch(label, args) {
  const switches = ['--inspect=127.0.0.1:0', ...args];
  console.log(label, JSON.stringify([executable, ...switches]));
  const child = spawn(executable, switches, {
    env: {
      PATH: '/usr/bin:/bin', HOME: privateHome, CFFIXED_USER_HOME: privateHome,
      SHELL: shell, DO_NOT_TRACK: '1', COUNCIL_TEST_LABEL: 'NSC-218 isolated',
      CODEX_HOME: path.join(privateHome, '.codex'), CLAUDE_CONFIG_DIR: path.join(privateHome, '.claude')
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  const record = { child, label, stderr: '', error: null };
  child.on('error', error => { record.error = error; });
  child.stderr.on('data', chunk => { record.stderr += chunk; });
  processes.push(record);
  return record;
}
async function connect(record) {
  const session = await inspector(await wait(record.label + ' inspector', () => {
    if (record.error) throw record.error;
    const { exitCode, signalCode } = record.child;
    if (exitCode !== null || signalCode !== null) {
      throw new Error(record.label + ' exited before inspector: ' + (signalCode ?? exitCode));
    }
    return /ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/.exec(record.stderr)?.[0];
  }));
  try {
    await wait(record.label + ' Electron main ready', () => session.evaluate(electronReady));
    return session;
  } catch (error) {
    session.ws.close();
    throw error;
  }
}
const wait = async (label, check) => {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    try { const value = await check(); if (value) return value; }
    catch (error) { if (!/Execution context was destroyed|Promise was collected/.test(error.message)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
};
let primary, peer;
async function inspector(address) {
  const ws = new WebSocket(address);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => { const reply = JSON.parse(data); pending.get(reply.id)?.(reply); pending.delete(reply.id); };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector evaluate timeout')); }, 5000);
    pending.set(id, reply => {
      clearTimeout(timer);
      if (reply.error || reply.result?.exceptionDetails) reject(new Error(reply.error?.message ?? reply.result.exceptionDetails.exception?.description));
      else resolve(reply.result?.result?.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { ws, evaluate, page: js => evaluate(`${windowExpr}?.webContents.executeJavaScript(${JSON.stringify(js)})`) };
}
const page = js => primary.page(js);
const click = (selector, label = '') => page(`(() => {
  const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => !node.disabled && node.textContent.trim().includes(${JSON.stringify(label)}));
  if (!node) return false;
  node.click(); return true;
})()`);

const windowExpr = `${electron}.BrowserWindow.getAllWindows()[0]`;
function frontPid() {
  const asn = execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8', timeout: 2000 }).trim();
  if (asn === '[ NULL ]') return null;
  const info = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'pid', asn], { encoding: 'utf8', timeout: 2000 });
  return Number(/"pid"\s*=\s*(\d+)/i.exec(info)?.[1]) || null;
}
async function run() {
  const first = launch('Floor A', ['--user-data-dir=' + profile, '--council-open-floor']);
  primary = await connect(first);
  assert.equal(await primary.evaluate(`${electron}.app.getPath('userData')`), profile);
  await wait('owned floor A', async () => (await page('window.cth?.listFloorViews?.()'))?.some(floor => floor.home === a));
  assert.equal(await primary.evaluate(windowExpr + ".webContents.getURL().startsWith('paramount://app/')"), true);
  await page("location.hash = '#/settings?tab=team'");
  await wait('Settings toggle', () => click('[role=switch][aria-label="Show floors in one window"]'));
  await wait('All floors on A', () => page(`(${hasAllFloorsView})()`));

  const second = launch('Floor B', ['--floor-data=' + peerProfile, '--floor-shared=' + profile, '--floor-home=' + b]);
  peer = await connect(second);
  assert.equal(await peer.evaluate(`${electron}.app.getPath('userData')`), peerProfile);
  await primary.evaluate(windowExpr + '.show(); ' + windowExpr + '.focus()');
  await wait('both floor tasks projected to A', async () => {
    const floors = await page('window.cth.listFloorViews()');
    const taskIn = (home, label) => floors.some(floor => floor.home === home && floor.tasks.some(task => task.label === label));
    return taskIn(a, 'Alpha ledger') && taskIn(b, 'Beta ledger');
  });
  await wait('both floor tasks rendered on A', () => page("document.body.innerText.includes('Alpha ledger') && document.body.innerText.includes('Beta ledger')"));
  await wait('floor B renderer', () => peer.page("!!window.cth?.listFloorViews"));
  await peer.page("localStorage.setItem('paramount.floor-views', 'true')");
  await peer.evaluate(windowExpr + '.webContents.reload()');
  await wait('floor B starts in All floors', () => peer.page(`(${hasAllFloorsView})()`));
  await primary.evaluate(windowExpr + '.show(); ' + windowExpr + '.focus()');
  await wait('floor A holds OS focus', async () =>
    frontPid() === first.child.pid && await primary.evaluate(windowExpr + '.isFocused()'));
  assert.equal(await click('[aria-label^="floor-b — "]'), true);
  await wait('selected floor B tasks', () => page("document.body.innerText.includes('Beta ledger') && !document.body.innerText.includes('Alpha ledger')"));

  await peer.evaluate(windowExpr + '.webContents.reload()');
  assert.equal(await click('button', 'Open floor controls'), true);
  await wait('floor B renders its own controls after reload', () => peer.page(`(() => {
    const main = [...document.querySelectorAll('main')].find(node => !node.closest('[hidden]') && node.getClientRects().length);
    return !!main
      && !document.querySelector('nav[aria-label="Floor views"]')
      && localStorage.getItem('paramount.floor-views') === 'true';
  })()`));
  await wait('floor B holds OS focus', async () =>
    frontPid() === second.child.pid && await peer.evaluate(windowExpr + '.isFocused()'));
  console.log('PASS: packaged renderer reload, peer controls, saved preference, and macOS focus moved from floor A to floor B');
}
const limit = setTimeout(() => {
  console.error('Smoke exceeded the 75-second overall limit');
  for (const { child } of processes) child.kill('SIGKILL');
  process.exit(1);
}, 75_000);
run().catch(error => {
  console.error(error.message);
  for (const { label, stderr } of processes) {
    const diagnostic = stderr.split('\n').filter(line => !line.includes('ws://127.0.0.1:')).join('\n').trim();
    if (diagnostic) console.error(label + ' stderr:', diagnostic);
  }
  process.exitCode = 1;
}).finally(async () => {
  for (const session of [peer, primary]) session?.ws.close();
  for (const { child } of processes) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
      await exited;
      clearTimeout(kill);
    }
  }
  clearTimeout(limit);
  console.log('Disposable fixture retained at ' + fixture);
});
