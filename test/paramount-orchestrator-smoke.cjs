'use strict';
// Built-app acceptance: real UI, IPC, hive and PTY; a fixture CLI avoids model
// charges and edits by an autonomous agent. Never uses the normal app profile.
// Run after npm run build and (cd ui && npm run build):
// node --experimental-websocket test/paramount-orchestrator-smoke.cjs
// Add PARAMOUNT_SMOKE_SIDE_AGENT=1 for the side-agent acceptance flow.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-orchestrator-smoke-'));
const profile = path.join(work, 'appdata');
const floorHome = path.join(work, 'floor');
const bin = path.join(work, 'bin');
fs.mkdirSync(path.join(profile, 'Paramount'), { recursive: true });
fs.mkdirSync(bin);
fs.mkdirSync(floorHome);
const capture = path.join(work, 'fixture-started');
const inputCapture = path.join(work, 'fixture-input');
const builtUI = path.join(work, 'ui');
// Serve an immutable snapshot: a concurrent rebuild must not remove lazy chunks
// after the test has loaded index.html.
fs.cpSync(path.join(root, 'ui/dist'), builtUI, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "fixture CLI ready\\n"\nprintf started > "$PARAMOUNT_SMOKE_CAPTURE"\nwhile read -r line; do printf "%s\\n" "$line" >> "$PARAMOUNT_SMOKE_INPUT"; printf "fixture received input\\n"; done\n', { mode: 0o755 });
const sideCapture = path.join(work, 'side-starts.jsonl');
const sideInput = path.join(work, 'side-input');
const fixtureNode = JSON.stringify(process.execPath);
const sideFixture = path.join(bin, 'side-fixture.cjs');
fs.writeFileSync(sideFixture, `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
fs.appendFileSync(${JSON.stringify(sideCapture)}, JSON.stringify({
  provider: process.argv[2], args: process.argv.slice(3), cwd: process.cwd(), home: process.env.HOME,
  isolated: !process.env.HIVE_ROOT && !process.env.AGENT_ID && !process.env.NSC236_FIXTURE_SECRET,
  pid: process.pid
}) + '\\n');
console.log('side fixture ready');
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (line === 'fail') process.exit(23);
  fs.appendFileSync(${JSON.stringify(sideInput)}, line + '\\n');
});
`);
if (process.env.PARAMOUNT_SMOKE_SIDE_AGENT === '1') {
  fs.writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh
exec ${fixtureNode} "${sideFixture}" opencode "$@"
`, { mode: 0o755 });
  const claude = path.join(bin, 'claude');
  const floorFixture = fs.readFileSync(claude, 'utf8');
  fs.writeFileSync(claude, floorFixture.replace('#!/bin/sh', `#!/bin/sh
case " $* " in
  *" --restricted "*) exec ${fixtureNode} "${sideFixture}" claude "$@";;
esac`));
}
const fixtureShell = path.join(bin, 'fixture-shell');
// shellEnv requests -ilc; execute the script against the fixture PATH, without
// loading a user's rc files which could replace it with the real CLI.
fs.writeFileSync(fixtureShell, '#!/bin/sh\nexec /bin/sh -c "$2"\n', { mode: 0o755 });
fs.writeFileSync(path.join(profile, 'Paramount', 'config.json'), JSON.stringify({
  harnessHome: floorHome, onboardingComplete: true,
  godProvider: 'claude', godModel: 'claude-opus-4-8', registeredRepos: [],
  autoMode: false, telemetryEnabled: false, semanticMemory: false,
  knowledgeGraph: false, slackEnabled: false, missions: [],
}));
const wrapper = path.join(work, 'main.cjs');
fs.writeFileSync(wrapper, `const { app } = require('electron');\napp.setPath('appData', ${JSON.stringify(profile)});\napp.on('browser-window-created', (_event, win) => { win.show = () => {}; win.focus = () => {}; });\nrequire(${JSON.stringify(path.join(root, 'out/main/index.js'))});\n`);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const base = builtUI;
  const file = path.resolve(base, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
let child, ws, seq = 0, stage = 'boot', stderr = '';
const checkpoint = (next) => { stage = next; console.log('smoke:', next); };
const pending = new Map();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, label, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; }
    catch (error) {
      // Startup/navigation can replace the inspector context. Poll the same
      // live child rather than treating the lost observation as an app exit.
      if (!/Promise was collected|Execution context was destroyed/.test(error.message) || child?.exitCode !== null) throw error;
    }
    await pause(200);
  }
  throw new Error('Timeout: ' + label);
};
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, (result) => { clearTimeout(timer); result.error ? reject(new Error(result.error.message)) : resolve(result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function main(expression) {
  const r = await call('Runtime.evaluate', { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
}
const page = (js) => main(`require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(js)})`);
const click = (label) => page(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
async function runSideAgentSmoke() {
  const state = () => page('window.cth.sideAgentState()');
  const starts = () => fs.existsSync(sideCapture)
    ? fs.readFileSync(sideCapture, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  const count = async (expected) => assert.equal((await page('window.cth.listPtys()')).length, expected);
  const rosterIds = async () => Object.keys((await page('window.cth.hiveRegistry()')).agents).sort();
  const ledger = () => page('window.cth.paramountSnapshot().then(s => s.tasks)');
  const floorHive = path.join(floorHome, 'hive');
  fs.writeFileSync(path.join(floorHive, 'board.md'), '# Fixture plan\n## Decisions\n- Approved browser validation.\n');
  fs.writeFileSync(path.join(floorHive, 'tasks.json'), JSON.stringify({ tasks: [{
    id: 'NSC-236', title: 'Fixture context card', status: 'blocked', assignee: 'god',
    blocker: 'Awaiting replay', priority: 2, dependsOn: [], createdAt: new Date().toISOString()
  }] }));
  const before = await rosterIds();
  const beforeLedger = await ledger();
  await until(() => JSON.parse(fs.readFileSync(path.join(floorHive, 'fleet.json'), 'utf8')).agents.some((entry) => entry.id === 'god'), 'orchestrator fleet row');
  await page("location.hash = '#/side-agent'");
  await until(() => click('Start side agent'), 'side agent start');
  const first = await until(async () => { const value = await state(); return value.status === 'running' && value; }, 'first side agent');
  const firstRun = await until(() => starts()[0], 'OpenCode fixture boot');
  assert.equal(firstRun.provider, 'opencode');
  assert.equal(firstRun.isolated, true);
  assert.equal(first.context.orchestratorId, 'god');
  assert.match(firstRun.args.at(-1), /Source: .+ \(god\), floor/);
  assert.match(firstRun.args.at(-1), /Fixture context card.*assignee: god.*blocker: Awaiting replay/);
  assert.ok(first.context.roster.some((entry) => entry.id === 'god'));
  assert.ok(first.context.decisions.includes('Approved browser validation.'));
  assert.match(first.context.boardSummary, /Fixture plan/);
  assert.notEqual(firstRun.cwd, root);
  await count(1);
  assert.deepEqual(await rosterIds(), before);
  await until(() => page("!!document.querySelector('[aria-label=\"Side agent terminal\"] .xterm')"), 'side terminal attached');
  assert.equal((await page(`window.cth.writePty(${JSON.stringify(first.ptyId)}, 'fixture question\\r')`)).ok, true);
  await until(() => fs.existsSync(sideInput) && fs.readFileSync(sideInput, 'utf8').includes('fixture question'), 'side terminal input');

  assert.equal(await click('Open source orchestrator'), true);
  await until(() => page("location.hash === '#/terminal?a=god'"), 'orchestrator link');
  await page("location.hash = '#/side-agent'");
  fs.writeFileSync(path.join(floorHive, 'board.md'), '# New fixture plan\n');
  await until(() => click('Restart'), 'side agent restart');
  const restarted = await until(async () => {
    const value = await state();
    return value.status === 'running' && value.ptyId !== first.ptyId && value;
  }, 'fresh side agent');
  assert.equal((await page(`window.cth.writePty(${JSON.stringify(first.ptyId)}, 'stale')`)).ok, false);
  const restartRun = await until(() => starts()[1], 'restarted provider boot');
  assert.match(restartRun.args.at(-1), /New fixture plan/);
  assert.equal(fs.existsSync(firstRun.home), false);
  await until(() => click('Stop'), 'stop side agent');
  await until(async () => (await state()).status === 'stopped', 'stopped state');
  assert.equal(fs.existsSync(starts()[1].home), false);

  await until(() => page(`(() => {
    const select = document.querySelector('select');
    if (!select || select.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'claude');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`), 'choose Claude');
  assert.equal(await click('Start side agent'), true);
  const thirdRun = await until(() => starts()[2], 'Claude fixture boot');
  assert.equal(thirdRun.provider, 'claude');
  assert.equal(thirdRun.isolated, true);
  assert.equal(thirdRun.args.includes('--tools='), true);
  const changed = await state();
  assert.notEqual(changed.ptyId, restarted.ptyId);
  assert.equal((await page(`window.cth.writePty(${JSON.stringify(changed.ptyId)}, 'fail\\r')`)).ok, true);
  await until(() => page("document.body.innerText.includes('provider exited (code 23)')"), 'exit error');
  assert.equal((await state()).exitCode, 23);
  assert.equal(fs.existsSync(thirdRun.home), false);
  assert.deepEqual(await rosterIds(), before);
  assert.deepEqual(await ledger(), beforeLedger);
  await count(1);
  assert.equal(await click('Start side agent'), true);
  await until(() => starts()[3], 'retry after exit');
  await until(() => click('Stop'), 'stop retried side agent');
  console.log(JSON.stringify({ result: 'PASS', sideAgent: true, providerSelection: true,
    contextAndOrchestratorLink: true, ptyInput: true, restartStopExitAndRetry: true,
    floorRosterLedgerAndTerminalsUnchanged: true, scratchCleanup: true }));
}
async function run() {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  child = spawn(process.env.PARAMOUNT_SMOKE_ELECTRON || require('electron'), ['--inspect=0', wrapper, '--council-open-floor'], {
    cwd: root, env: { ...process.env, PARAMOUNT_UI_URL: url, SHELL: fixtureShell,
      PATH: bin + path.delimiter + process.env.PATH, PARAMOUNT_SMOKE_CAPTURE: capture, PARAMOUNT_SMOKE_INPUT: inputCapture, NSC236_FIXTURE_SECRET: 'do-not-forward', DO_NOT_TRACK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let inspector = '';
  let launchError;
  child.on('error', (error) => { launchError = error; });
  child.stderr.on('data', (data) => { stderr += data; inspector ||= /ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/.exec(stderr)?.[0] || ''; });
  child.stdout.resume();
  await until(() => { if (launchError) throw launchError; if (child.exitCode !== null) throw new Error('Electron exited: ' + stderr.slice(-1000)); return inspector; }, 'inspector');
  ws = new WebSocket(inspector);
  ws.onmessage = ({ data }) => { const msg = JSON.parse(data); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  checkpoint('window');
  await until(() => main(`(() => { try { const e = require('electron'); return e.app.isReady() && e.BrowserWindow.getAllWindows().length > 0 && !e.BrowserWindow.getAllWindows()[0].webContents.isLoading(); } catch { return false; } })()`), 'window');
  assert.equal(await main("require('electron').app.getPath('userData')"), path.join(profile, 'Paramount'));
  checkpoint('provider');
  await main("globalThis.__smokeErrors = []; require('electron').BrowserWindow.getAllWindows()[0].webContents.on('console-message', (_e, level, message) => { if (level >= 2) __smokeErrors.push(message); }); true");
  await until(() => page("typeof window.cth?.paramountSnapshot === 'function' && !document.body.innerText.includes('Connecting to the floor')"), 'live provider');
  const initial = await page('window.cth.paramountSnapshot()');
  assert.equal(Object.keys(initial.registry.agents).length, 0);
  assert.equal(fs.existsSync(capture), false);
  checkpoint('Team');
  await page("location.hash = '#/team'");
  await until(() => click('Start Paramount orchestrator'), 'orchestrator action');
  await until(() => page("document.querySelector('#h-engine')?.value === 'claude'"), 'configured engine');
  assert.equal(await page("document.querySelector('#h-engine').disabled"), true);
  assert.equal(await click('Review'), true);
  checkpoint('preview');
  await until(() => page("!!document.querySelector('[data-hire-plan=god]')"), 'preview');
  assert.equal(fs.existsSync(capture), false);
  assert.equal((await page('window.cth.listPtys()')).length, 0);
  if (process.env.PARAMOUNT_SMOKE_ALLOCATION_FAILURE_ONLY === '1') {
    checkpoint('PTY allocation failure recovery');
    const ptyModule = JSON.stringify(path.join(root, 'node_modules/node-pty'));
    await main(`globalThis.__smokeSpawn = require(${ptyModule}).spawn; require(${ptyModule}).spawn = () => { throw new Error('fixture PTY allocation failure'); }; true`);
    const command = { type: 'agent.hire', orchestrator: true, confirm: true, manifest: { spec: 'munder-difflin/hire@1', name: 'Paramount' } };
    let failed;
    try { failed = await page(`window.cth.paramountDispatch(${JSON.stringify(command)})`); }
    finally { await main(`require(${ptyModule}).spawn = globalThis.__smokeSpawn; true`); }
    assert.equal(failed.ok, false);
    assert.equal((await page('window.cth.listPtys()')).length, 0);
    const retry = await page(`window.cth.paramountDispatch(${JSON.stringify({ ...command, confirm: false })})`);
    assert.equal(retry.ok, true, 'failed PTY allocation must not leave a phantom live orchestrator');
    console.log(JSON.stringify({ result: 'PASS', allocationFailureRecovery: true }));
    return;
  }
  assert.equal(await click('Start Paramount'), true);
  checkpoint('confirmed launch');
  await until(() => fs.existsSync(capture), 'fixture PTY started');
  await until(() => page("document.body.innerText.includes('Started. Paramount is on the Team and in Terminal.')"), 'started feedback');
  const started = await page('window.cth.paramountSnapshot()');
  assert.equal(started.registry.godId, 'god');
  assert.equal(started.registry.agents.god.isGod, true);
  assert.equal(started.registry.agents.god.provider, 'claude');
  assert.ok(started.messages.some((m) => m.subject === 'Start orchestrator'));
  assert.equal((await page("window.cth.hiveSend({ to: 'god', act: 'request', subject: 'Fixture human request', body: 'Inspect the fixture inbox.' }, 'human')")).ok, true);
  assert.equal((await page('window.cth.listPtys()')).length, 1);
  const duplicate = await page(`window.cth.paramountDispatch({ type: 'agent.hire', orchestrator: true, confirm: true, manifest: { spec: 'munder-difflin/hire@1', name: 'Duplicate' } })`);
  assert.equal(duplicate.code, 'CONFLICT');
  assert.equal(await click('Close'), true);
  checkpoint('Team projection');
  await until(() => page("!document.querySelector('[role=dialog]')"), 'sheet closed');
  assert.equal(await page("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Start Paramount orchestrator')"), false);
  assert.equal(await page("document.body.innerText.includes('Paramount')"), true);
  await page("location.hash = '#/terminal'");
  checkpoint('Terminal');
  await until(() => page("document.body.innerText.includes('Paramount') && !!document.querySelector('.xterm')"), 'Terminal projection');
  if (process.env.PARAMOUNT_SMOKE_SIDE_AGENT === '1') {
    checkpoint('Side Agent');
    await runSideAgentSmoke();
    return;
  }
  checkpoint('heartbeat conversation');
  const heartbeatBody = 'Floor heartbeat — 1 actionable inbox message(s) awaiting you (worker/human mail). Drain your inbox NOW and act on them.\nRecent log:\n{"kind":"paramount-op"}';
  assert.equal((await page(`window.cth.hiveSend({ to: 'god', act: 'inform', subject: 'Heartbeat', body: ${JSON.stringify(heartbeatBody)} }, 'heartbeat')`)).ok, true);
  await page("location.hash = '#/chats?c=agent:god'");
  await until(() => page("document.body.innerText.includes('Heartbeat · 1 message waiting.')"), 'compact system update');
  assert.equal(await page("document.body.innerText.includes('Drain your inbox NOW')"), false);
  assert.equal(await click('Open terminal'), true);
  await until(() => page("!!document.querySelector('.xterm') && !!document.querySelector('details summary')"), 'system detail in Terminal');
  assert.equal(await page("document.querySelector('details pre').textContent.includes('paramount-op')"), true);
  checkpoint('startup and human-mail submission');
  await until(() => fs.existsSync(inputCapture) && fs.readFileSync(inputCapture, 'utf8').includes('$AGENT_DIR/inbox'), 'automatic inbox submission', 90000);
  // Settings defaults to Account; select Setup explicitly.
  await page("location.hash = '#/settings?tab=setup'");
  checkpoint('Settings');
  await until(() => page("document.body.innerText.includes('Runtime checks')"), 'Settings Setup');
  assert.equal(await page("document.body.innerText.includes('optional')"), true);
  assert.equal(await page("document.body.innerText.includes('Set up this Mac for Paramount')"), false);
  const ptys = await page('window.cth.listPtys()');
  for (const pty of ptys) assert.equal((await page(`window.cth.killPty(${JSON.stringify(pty.id)})`)).ok, true);
  checkpoint('stopped orchestrator recovery');
  await page("location.hash = '#/team'");
  await until(() => click('Start Paramount orchestrator'), 'restart action');
  await until(() => page("document.querySelector('#h-engine')?.value === 'claude'"), 'restart engine');
  assert.equal(await click('Review'), true);
  await until(() => page("!!document.querySelector('[data-hire-plan=god]')"), 'restart preview');
  assert.equal(await click('Start Paramount'), true);
  await until(() => page("document.body.innerText.includes('Started. Paramount is on the Team and in Terminal.')"), 'restarted feedback');
  assert.equal((await page('window.cth.listPtys()')).length, 1);
  assert.equal((await page('window.cth.hiveRegistry()')).godId, 'god');
  console.log(JSON.stringify({ result: 'PASS', isolatedProfile: true, fixtureCLI: true,
    previewDoesNotSpawn: true, confirmedMainAgent: true, duplicateRejected: true,
    teamAndTerminal: true, compactHeartbeat: true, heartbeatDetailsInTerminal: true,
    optionalRuntime: true, automaticInboxSubmission: true, stoppedOrchestratorRecovery: true, cleanup: 'fixture PTYs stopped in finally' }));
}
run().catch(async (error) => {
  console.error(stage + ': ' + error.message.replaceAll(work, '<fixture>'));
  console.error('Electron:', child?.exitCode, stderr.slice(-3000).replaceAll(work, '<fixture>').replaceAll(root, '<repo>'));
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      console.error(JSON.stringify(await page("({ hash: location.hash, text: document.body.innerText.slice(-2500), xterms: document.querySelectorAll('.xterm').length })")).replaceAll(work, '<fixture>'));
      console.error(JSON.stringify(await main('globalThis.__smokeErrors')).replaceAll(work, '<fixture>'));
    } catch { /* page may have closed */ }
  }
  process.exitCode = 1;
}).finally(async () => {
  if (ws?.readyState === WebSocket.OPEN) {
    try { await page("(async () => { await window.cth.sideAgentAct?.('stop'); for (const p of await window.cth.listPtys()) await window.cth.killPty(p.id); })()"); } catch { /* app may already have exited */ }
    try { await main("setTimeout(() => require('electron').app.exit(0), 50); true"); } catch { /* transport may already be closed */ }
    ws.close();
  }
  if (child && child.exitCode === null) child.kill();
  child?.stdout.destroy();
  child?.stderr.destroy();
  server.closeAllConnections();
  setTimeout(() => { if (child && child.exitCode === null) child.kill('SIGKILL'); }, 1500).unref();
  server.close();
});
