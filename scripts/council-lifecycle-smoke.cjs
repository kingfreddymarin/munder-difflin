#!/usr/bin/env node
'use strict';
// Actual built-app lifecycle test. Never calls ensure/start/restore on behalf of the UI.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
if (args.includes('--help')) {
  console.log('node --experimental-websocket scripts/council-lifecycle-smoke.cjs [--self-test | --build | --app /path/Paramount.app] [--report report.json] [--source-commit SHA] [--timeout-ms 45000] [--expect-known-bad]');
  process.exit(0);
}
const timeout = Number(option('--timeout-ms', '45000'));
assert(Number.isFinite(timeout) && timeout >= 1000 && timeout <= 120000, 'timeout must be 1000..120000');
const reportFile = path.resolve(option('--report', 'evidence-2026-11-12/council-lifecycle-baseline.json'));
const work = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'council-lifecycle-'));
const profile = path.join(work, 'profile');
const studio = path.join(work, 'studio');
const hive = path.join(studio, 'hive');
const bin = path.join(work, 'bin');
for (const dir of [profile, studio, bin, path.join(work, 'home')]) fs.mkdirSync(dir, { recursive: true });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); };
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout?.trim();
const labels = ['Fresh profile and first-launch setup', 'Incomplete setup reopened', 'Missing prerequisites recovery', 'Setup cancelled', 'First floor creation and readiness', 'Restart after setup', 'Existing floor reopen', 'Orchestrator startup', 'Agent and temp spawn requests', 'Prompt and inbox delivery', 'Terminal streaming and input', 'Task assignment and status', 'Completion receipts', 'Stop, restart and session recovery', 'Memory and handoff continuity', 'Provider, account and model selection', 'Token and budget enforcement', 'Automation dispatch', 'NSC-192 cross-hive relay'];
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), authority: 'Munder Difflin 0.5.7 packaged', sourceCommit: option('--source-commit', git('rev-parse', 'HEAD')), harnessCommit: git('rev-parse', 'HEAD'), sourceDirty: git('status', '--porcelain', '--', 'src', 'ui/src'), runCommand: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], work, probe: 'Local deterministic CLI; no provider requests. Lifecycle and IPC are not mocked.', rows: labels.map((behaviour, i) => ({ row: i + 1, behaviour, status: 'fail', coverage: 'untested', errorId: `SMOKE-UNTESTED-${i + 1}`, logExcerpt: 'Outside this bounded lifecycle probe; not evidence of parity.' })), checks: [], observations: {} };
let proc, ws, app, launchError, stderr = '', port, before, requestId;
const pending = new Map(); let seq = 0;
function redact(value) { return String(value).replace(/(?:sk-(?:ant-)?|xox[baprs]-|gh[pousr]_)[A-Za-z0-9_-]{10,}/g, '[redacted]').slice(-5000); }
function excerpt() { let log = ''; try { log = fs.readFileSync(path.join(hive, 'log.jsonl'), 'utf8'); } catch {} return redact(log.slice(-3500) + '\n' + stderr.slice(-1500)); }
function result(rows, ok, detail, coverage = 'tested') {
  for (const n of rows) Object.assign(report.rows[n - 1], { status: ok ? 'pass' : 'fail', coverage, detail, errorId: ok ? null : `SMOKE-ROW-${n}-${sha(String(detail)).slice(0, 8)}`, logExcerpt: ok ? null : excerpt() || String(detail) });
}
async function check(name, rows, fn) {
  try { const detail = await fn(); result(rows, true, detail); report.checks.push({ name, status: 'pass', detail }); return detail; }
  catch (error) { const detail = redact(error.stack || error); result(rows, false, detail); report.checks.push({ name, status: 'fail', errorId: `SMOKE-${name}`, detail, logExcerpt: excerpt() || detail }); return null; }
}
// Content + relative names + modes; do not follow symlinks out of a profile.
function hashTree(dir) {
  const hash = crypto.createHash('sha256'); let count = 0;
  function walk(file, rel) {
    let stat; try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') { hash.update(rel + ':missing'); return; } throw e; }
    hash.update(JSON.stringify([rel, stat.mode & 0o777, stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : 'file']));
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(file));
    else if (stat.isDirectory()) for (const item of fs.readdirSync(file).sort()) walk(path.join(file, item), rel + '/' + item);
    else if (stat.isFile()) { hash.update(fs.readFileSync(file)); count++; }
  }
  walk(dir, '.'); return { sha256: hash.digest('hex'), files: count };
}
const support = path.join(os.homedir(), 'Library/Application Support');
const protectedDirs = ['Munder Difflin', 'munder-difflin', 'Paramount', 'Council', 'council'].map(n => path.join(support, n));
function profileHashes() { return Object.fromEntries(protectedDirs.map(dir => [dir, hashTree(dir)])); }
async function until(fn, description, limit = timeout) {
  const end = Date.now() + limit; let last;
  while (Date.now() < end) { if (launchError) throw launchError; try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await sleep(250); }
  throw new Error(`Timed out: ${description}${last ? ': ' + last.message : ''}`);
}
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeout);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function main(expression) {
  const r = await call('Runtime.evaluate', { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}
const page = js => main(`require('electron').BrowserWindow.getAllWindows().find(w => !w.isDestroyed()).webContents.executeJavaScript(${JSON.stringify(js)})`);
const bridge = js => page(`(async () => { const b = window.cth || window.paramount; ${js} })()`);
const state = () => bridge('return { registry: await b.hiveRegistry(), ptys: await b.listPtys() };');
async function button(text) {
  assert(await page(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) return false; b.click(); return true; })()`), `Enabled ${text} button not found`);
}
const setInput = (selector, value) => page(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Input missing'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
async function freePort() { const server = net.createServer(); await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); }); const p = server.address().port; await new Promise(r => server.close(r)); return p; }
// A fake CLI only responds to submitted input. It never polls inbox in the background:
// a reply therefore proves that the app delivered a wake through the real PTY.
function makeProbe() {
  const pythonResult = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 10000 });
  const python = pythonResult.stdout?.trim(); assert(pythonResult.status === 0 && python && !/[\r\n]/.test(python), 'A working Python 3 executable is required');
  const script = `#!${python}\nimport os, sys, json, pathlib, time, socket, signal\nsignal.alarm(300)\nif '--version' in sys.argv:\n print('claude 2.1.0 (Council lifecycle probe)'); sys.exit(0)\nroot=pathlib.Path(${JSON.stringify(hive)})\nagent=os.environ.get('AGENT_ID','god')\ndef hook(event):\n try:\n  sock=socket.socket(socket.AF_UNIX); sock.settimeout(1); sock.connect(os.environ['HIVE_SOCK']); sock.sendall((json.dumps({'agent_id':agent,'hook_event_name':event})+'\\n').encode()); sock.recv(65536); sock.close()\n except Exception as error: print('COUNCIL_PROBE_HOOK_ERROR '+str(error), flush=True)\nprint('COUNCIL_PROBE_READY', flush=True)\nhook('SessionStart'); hook('Stop')\nfor line in sys.stdin:\n print('COUNCIL_PROBE_ECHO '+line.strip(), flush=True)\n inbox=root/'agents'/agent/'inbox'\n for f in sorted(inbox.glob('*.json')):\n  try: m=json.loads(f.read_text())\n  except Exception: continue\n  mid='probe-'+str(time.time_ns())\n  out=root/'agents'/agent/'outbox'; out.mkdir(parents=True, exist_ok=True)\n  (out/(mid+'.json')).write_text(json.dumps({'to':'human','act':'inform','subject':'Probe reply','body':'COUNCIL_PROBE_REPLY '+m.get('body',''),'conversation':m.get('conversation'),'in_reply_to':m.get('id')}))\n  done=inbox/'.done'; done.mkdir(exist_ok=True); f.rename(done/f.name)\n hook('Stop')\n`;
  fs.writeFileSync(path.join(bin, 'claude'), script, { mode: 0o755 });
  // Prevent every supported provider name from falling through to host credentials.
  for (const name of ['codex', 'dc', 'dcx', 'dcxm', 'dcm', 'gemini', 'grok', 'cursor-agent', 'agy', 'opencode', 'pi']) fs.copyFileSync(path.join(bin, 'claude'), path.join(bin, name));
  for (const name of fs.readdirSync(bin)) fs.chmodSync(path.join(bin, name), 0o755);
  // Preserve the isolated PATH when shellEnv asks a login shell for its PATH.
  fs.writeFileSync(path.join(bin, 'smoke-shell'), '#!/bin/sh\nexec /bin/sh -c "$2"\n', { mode: 0o755 });
}
async function launch() {
  port = await freePort(); launchError = null;
  const exe = path.join(app, 'Contents/MacOS', fs.readdirSync(path.join(app, 'Contents/MacOS')).find(n => !n.startsWith('.')));
  // Scrub inherited broker, provider and cloud credentials. No inherited live hive.
  const env = { PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(work, 'home'), SHELL: path.join(bin, 'smoke-shell'), TMPDIR: work, LANG: 'en_US.UTF-8', DO_NOT_TRACK: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' };
  proc = spawn(exe, [`--inspect=${port}`, `--user-data-dir=${profile}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.on('error', e => { launchError = e; });
  proc.stdout.on('data', d => { stderr = (stderr + d).slice(-10000); }); proc.stderr.on('data', d => { stderr = (stderr + d).slice(-10000); });
  const target = await until(async () => {
    if (proc.exitCode !== null || proc.signalCode) throw new Error(`App exited: ${proc.exitCode}/${proc.signalCode}`);
    return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0];
  }, 'main inspector');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.onmessage = event => { const d = JSON.parse(event.data); const p = pending.get(d.id); if (!p) return; pending.delete(d.id); clearTimeout(p.timer); d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result); };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  assert.equal(path.resolve(await main("require('electron').app.getPath('userData')")), profile, 'App ignored disposable profile');
  await until(() => page("!!document.querySelector('[data-testid=setup-flow]') || !!(window.cth && document.querySelector('main'))"), 'actual UI');
  report.observations.appVersion = await main("require('electron').app.getVersion()");
}
async function quit() {
  if (!proc) return;
  if (ws?.readyState === 1) { try { await main("(setTimeout(() => require('electron').app.quit(), 50), true)"); } catch {} }
  const end = Date.now() + 5000;
  while (proc.exitCode === null && !proc.signalCode && Date.now() < end) await sleep(100);
  if (proc.exitCode === null && !proc.signalCode) { proc.kill('SIGTERM'); await sleep(500); }
  if (proc.exitCode === null && !proc.signalCode) proc.kill('SIGKILL');
  ws?.close(); proc = null;
}
function run(command, argv, cwd = root) {
  const r = spawnSync(command, argv, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
  report.observations.buildLog = redact((r.stdout || '') + (r.stderr || ''));
  if (r.error || r.status !== 0) throw new Error(`Build failed: ${r.error?.message || r.status}\n${report.observations.buildLog}`);
}
async function exercise() {
  await launch();
  await check('fresh-profile', [1], async () => {
    assert(await page("!!document.querySelector('[data-testid=setup-flow][data-stage=workspace]')"));
    assert(!fs.existsSync(hive)); assert(!fs.existsSync(path.join(profile, 'hive')));
    assert.equal(readJson(path.join(profile, 'config.json')).harnessHome ?? null, null);
    return 'Workspace setup visible; no hive in either fixture root or disposable profile. HarnessMD account gates are outside this probe.';
  });
  await button('Continue'); await button('Back');
  await check('cancel-and-resume', [2, 4], async () => {
    await quit(); await launch(); assert(await page("!!document.querySelector('[data-testid=setup-flow][data-stage=workspace]')")); assert(!fs.existsSync(hive));
    return 'Closed during setup; reopened at workspace with no floor. Back navigation exercised.';
  });
  await setInput('#setup-home', studio); await button('Continue');
  assert(await page("(() => { const e = document.querySelector('input[name=engine][value=claude]'); if (!e || e.disabled) return false; e.click(); return true; })()"), 'Probe engine unavailable');
  await button('Finish setup');
  await check('floor-created', [5], async () => {
    await until(() => fs.existsSync(path.join(hive, 'registry.json')), 'first floor');
    assert.equal(readJson(path.join(profile, 'config.json')).harnessHome, studio);
    await until(() => page("!document.querySelector('[data-testid=setup-flow]')"), 'setup completion');
    return 'UI Finish setup created isolated floor. Runtime readiness is checked separately in row 8.';
  });
  await check('orchestrator', [8], async () => {
    await until(async () => { const s = await state(); return s.registry.godId && s.ptys.filter(p => p.id === 'pty-' + s.registry.godId).length === 1; }, 'exactly one orchestrator');
    await sleep(2000); const s = await state(); assert.equal(Object.values(s.registry.agents).filter(a => a.isGod).length, 1); assert.equal(s.ptys.filter(p => p.id === 'pty-' + s.registry.godId).length, 1);
    report.observations.orchestrator = s; return 'Exactly one registry god and one live PTY, stable across repeated observation.';
  });
  await check('message-roundtrip', [10], async () => {
    const s = await state(); assert(s.registry.godId, 'No orchestrator for message round-trip');
    const marker = 'COUNCIL_ROUNDTRIP_' + crypto.randomUUID();
    const sent = await bridge(`return b.hiveSend({to:${JSON.stringify(s.registry.godId)},act:'request',subject:'Lifecycle probe',body:${JSON.stringify(marker)}}, 'human');`);
    assert(sent.ok, JSON.stringify(sent));
    await until(async () => (await bridge('return b.hiveMessages({limit:200});')).some(m => m.body?.includes('COUNCIL_PROBE_REPLY ' + marker)), 'probe reply from app-triggered inbox wake');
    return 'Human message crossed hive delivery, PTY wake, probe outbox and runtime routing back to UI read model.';
  });
  requestId = 'lifecycle-' + crypto.randomUUID();
  await check('spawn-request', [9], async () => {
    writeJson(path.join(hive, 'spawn-requests', requestId + '.json'), { objective: 'Local lifecycle probe; echo only.', cwd: studio, name: 'Lifecycle temp', provider: 'claude', command: path.join(bin, 'claude'), isolate: false, tokenCap: 100 });
    await until(async () => { const s = await state(); return fs.existsSync(path.join(hive, 'spawn-requests/.done', requestId + '.json')) && !!s.registry.agents['worker-' + requestId] && s.ptys.some(p => p.id === 'pty-worker-' + requestId); }, 'request consumed and temp live');
    return 'Request moved to .done; exact worker id registered with a live PTY.';
  });
  // Create one lasting agent through the real public IPC as an independent restart
  // fixture. This does not make row 8 or 9 pass and does not invoke any lifecycle loop.
  const fixtureId = 'lifecycle-stopped';
  await check('restore-fixture', [], async () => {
    const opts = { id: 'pty-' + fixtureId, cwd: studio, command: path.join(bin, 'claude'), provider: 'claude', isolate: false, hive: { id: fixtureId, name: 'Lifecycle stopped fixture', provider: 'claude', cwd: studio, role: 'Smoke fixture' } };
    const spawned = await bridge(`return b.spawnPty(${JSON.stringify(opts)});`); assert(spawned.ok, JSON.stringify(spawned));
    const agent = { id: fixtureId, name: 'Lifecycle stopped fixture', character: 'jim', accent: 'blue', description: 'Smoke fixture', project: 'fixture', tmuxTarget: '', cwd: studio, status: 'idle', action: 'ready', progress: 0, ptyId: 'pty-' + fixtureId, provider: 'claude', command: path.join(bin, 'claude') };
    const priorRoster = await bridge('return b.rosterReadSync();');
    const roster = { version: 1, savedAt: new Date().toISOString(), agents: [...(priorRoster?.agents || []).filter(a => a.id !== fixtureId), agent], archived: priorRoster?.archived || [], restorable: priorRoster?.restorable || [], queues: priorRoster?.queues || {}, selectedId: fixtureId };
    const saved = await bridge(`return b.rosterWrite(${JSON.stringify(roster)});`); assert(saved.ok, JSON.stringify(saved));
    return 'Lasting probe agent created via spawnPty and saved via rosterWrite; no automatic lifecycle method was called.';
  });
  await check('terminal-stream', [11], async () => {
    await bridge(`window.__probeOutput = ''; b.onPtyData('pty-${fixtureId}', d => { window.__probeOutput += d; }); return true;`);
    const sent = await bridge(`return b.writePty('pty-${fixtureId}', 'COUNCIL_TERMINAL_PROBE\\r');`); assert(sent.ok);
    await until(() => page("window.__probeOutput.includes('COUNCIL_PROBE_ECHO COUNCIL_TERMINAL_PROBE')"), 'terminal output from input');
    return 'Real PTY input caused probe output streamed through the preload subscription.';
  });
  await check('inbox-wake', [], async () => {
    const id = 'worker-' + requestId; const s = await state(); assert(s.registry.agents[id], 'Spawned temp missing');
    const marker = 'COUNCIL_WAKE_' + crypto.randomUUID();
    const sent = await bridge(`return b.hiveSend({to:${JSON.stringify(id)},act:'request',subject:'Wake probe',body:${JSON.stringify(marker)}}, 'human');`); assert(sent.ok);
    await until(async () => (await bridge('return b.hiveMessages({limit:200});')).some(m => m.from === id && m.body?.includes('COUNCIL_PROBE_REPLY ' + marker)), 'agent inbox wake');
    return 'Separate temp inbox caused terminal input and routed response.';
  });
  // A missing worker is a failed restoration prerequisite, never a vacuous pass.
  const prior = await state(); report.observations.beforeQuit = prior;
  await quit(); await launch();
  await check('reopen-floor', [6, 7], async () => {
    assert(!await page("!!document.querySelector('[data-testid=setup-flow]')"));
    assert.equal(readJson(path.join(profile, 'config.json')).harnessHome, studio); return 'Persisted setup opens the same fixture floor.';
  });
  await check('restore', [14], async () => {
    const registryIds = Object.keys(prior.registry.agents); const ids = registryIds.filter(id => id === fixtureId || prior.registry.agents[id].isGod); assert(ids.includes(fixtureId) && prior.ptys.some(p => p.id === 'pty-' + fixtureId), 'Lasting stopped-agent fixture was not established');
    await until(async () => { const s = await state(); return ids.every(id => s.ptys.filter(p => p.id === 'pty-' + id).length === 1); }, 'stopped agents restored');
    const restored = await state(); assert.deepEqual(Object.keys(restored.registry.agents).sort(), registryIds.sort());
    await sleep(2000); const stable = await state(); assert.equal(new Set(stable.ptys.map(p => p.id)).size, stable.ptys.length); assert(ids.every(id => stable.ptys.filter(p => p.id === 'pty-' + id).length === 1)); assert(stable.ptys.every(p => registryIds.some(id => p.id === 'pty-' + id)));
    report.observations.afterRelaunch = stable; return 'Original stopped identities restored once; no extra registry entries or PTYs.';
  });
}
if (args.includes('--self-test')) {
  try {
    makeProbe();
    const probeEnv = { PATH: bin + ':/usr/bin:/bin', HOME: path.join(work, 'home'), AGENT_ID: 'offline-fixture' };
    const version = spawnSync(path.join(bin, 'claude'), ['--version'], { encoding: 'utf8', timeout: 3000, env: probeEnv });
    assert.equal(version.status, 0, JSON.stringify(version)); assert.match(version.stdout, /Council lifecycle probe/);
    const shell = spawnSync(path.join(bin, 'smoke-shell'), ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', env: { PATH: bin + ':/usr/bin:/bin' } });
    assert.equal(shell.status, 0); assert(shell.stdout.startsWith(bin));
    const probe = spawnSync(path.join(bin, 'claude'), [], { input: 'offline-probe\n', encoding: 'utf8', timeout: 3000, env: probeEnv });
    assert.equal(probe.status, 0); assert.match(probe.stdout, /COUNCIL_PROBE_ECHO offline-probe/);
    const original = hashTree(studio);
    fs.writeFileSync(path.join(studio, 'canary'), 'one'); const changed = hashTree(studio);
    assert.notEqual(original.sha256, changed.sha256);
    fs.writeFileSync(path.join(studio, 'canary'), 'two'); assert.notEqual(changed.sha256, hashTree(studio).sha256);
    assert.equal(report.rows.length, 19); assert(report.rows.every(r => r.status === 'fail' && r.coverage === 'untested' && r.errorId));
    console.log('SELF-TEST PASS: executable probe, PTY input/output contract, isolated shell PATH, content-sensitive profile hashes and fail-closed report defaults. No app launched.');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  process.exit(0);
}
(async () => {
  try {
    before = profileHashes(); report.profiles = { before };
    makeProbe();
    writeJson(path.join(profile, 'config.json'), { autoUpdate: false, telemetryEnabled: false, semanticMemory: false, reflectEnabled: false, orchestratorMaySpawn: true, defaultCommand: path.join(bin, 'claude'), integrations: [], missions: [], automations: [] });
    if (args.includes('--build')) {
      run('npm', ['run', 'build']); run('npm', ['run', 'build'], path.join(root, 'ui'));
      run(process.execPath, ['scripts/paramount-ui-dist.cjs', 'node_modules/.bin/electron-builder', '--config', 'electron-builder.config.cjs', '--dir', '--config.npmRebuild=false', '--config.electronDist=node_modules/electron/dist', '--config.directories.output=dist/lifecycle-smoke']);
    }
    app = path.resolve(option('--app', 'dist/lifecycle-smoke/mac-arm64/Paramount.app'));
    report.app = app; report.buildHash = hashTree(path.join(app, 'Contents')).sha256;
    report.buildIdentity = { sourceAttribution: args.includes('--build') ? 'built by this invocation' : 'caller-supplied source commit; artifact content hashes are authoritative', mainAsarHash: sha(fs.readFileSync(path.join(app, 'Contents/Resources/app.asar'))), uiHash: hashTree(path.join(app, 'Contents/Resources/paramount-ui')).sha256 };
    assert(typeof WebSocket === 'function', 'Use Node 22+ or --experimental-websocket');
    await exercise();
  } catch (error) {
    report.fatal = { errorId: 'SMOKE-ENVIRONMENT-OR-BOOT', message: redact(error.stack || error), logExcerpt: excerpt() || redact(error.stack || error) };
    for (const row of report.rows.filter(r => r.coverage === 'untested')) { row.errorId = report.fatal.errorId; row.logExcerpt = report.fatal.message + '\n' + report.fatal.logExcerpt; }
  } finally {
    await quit();
    try { report.profiles = { ...report.profiles, after: profileHashes() }; report.profiles.unchanged = JSON.stringify(before) === JSON.stringify(report.profiles.after); } catch (error) { report.profiles = { ...report.profiles, unchanged: false, error: String(error) }; }
    report.finishedAt = new Date().toISOString();
    report.knownBad = { expectedFailures: [8, 9, 14], observed: [8, 9, 14].filter(n => report.rows[n - 1].coverage === 'tested' && report.rows[n - 1].status === 'fail') };
    report.knownBad.proven = !report.fatal && report.profiles.unchanged && report.knownBad.observed.length === 3 && report.checks.some(c => c.name === 'restore-fixture' && c.status === 'pass') && [1, 2, 4, 5, 6, 7].every(n => report.rows[n - 1].status === 'pass');
    report.pass = !report.fatal && report.profiles.unchanged && report.rows.every(r => r.status === 'pass') && report.checks.every(c => c.status === 'pass');
    writeJson(reportFile, report);
    console.log(JSON.stringify({ report: reportFile, pass: report.pass, knownBadProven: report.knownBad.proven, profilesUnchanged: report.profiles.unchanged, fatal: report.fatal?.message, rows: report.rows.map(r => `${r.row}:${r.status}/${r.coverage}`) }, null, 2));
    process.exitCode = report.pass || (args.includes('--expect-known-bad') && report.knownBad.proven) ? 0 : 1;
  }
})();
