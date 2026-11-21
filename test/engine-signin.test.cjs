'use strict';
// Owner run of ceeb4aaf: Codex was installed but its refresh token had been revoked; Council said
// nothing and agents died. engine-signin.ts flags a signed-out or expired engine with the fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const loadTs = require('./load-ts.cjs');
const { createSignInMonitor, signInFailure, STATUS_TTL_MS, resolveSignInAccountHome } = loadTs('src/main/engine-signin.ts');
const tick = () => new Promise(setImmediate);

test('a revoked Codex token in a dying agent\'s output flags Codex with "codex login"', () => {
  assert.match(signInFailure('codex', 'Error: refresh token was revoked. Please log in again.'), /codex login/);
  assert.match(signInFailure('claude', 'Invalid API key · Please run /login'), /claude auth login/);
  assert.equal(signInFailure('codex', 'panic: index out of range'), null);
  assert.equal(signInFailure('gemini', 'not logged in'), null);
});

test('status commands: exit 0 signed in, non-zero signed out, errors unknown; checked in the background and cached', async () => {
  let now = 1_000; const runs = [];
  const codes = { codex: { code: 1 }, claude: { code: 0 } };
  const m = createSignInMonitor({ path: (e) => `/bin/${e}`, now: () => now, run: async (bin, args) => { runs.push([bin, ...args]); return codes[bin.split('/').pop()]; } });
  assert.equal(m.status('codex').state, 'unknown', 'the snapshot never waits for the status command');
  await tick(); await tick();
  assert.deepEqual(m.status('codex'), { state: 'signed-out', fix: 'Run `codex login` in Terminal, then start the agent again.' });
  assert.equal(m.status('claude').state, 'unknown'); await tick(); await tick();
  assert.equal(m.status('claude').state, 'signed-in');
  assert.deepEqual(runs, [['/bin/codex', 'login', 'status'], ['/bin/claude', 'auth', 'status']]);
  m.status('codex'); m.status('codex'); await tick();
  assert.equal(runs.length, 2, 'cached for STATUS_TTL_MS');
  now += STATUS_TTL_MS + 1; m.status('codex'); await tick();
  assert.equal(runs.length, 3);
  const broken = createSignInMonitor({ path: () => '/bin/codex', run: async () => ({ code: null, error: true }) });
  broken.status('codex'); await tick(); await tick();
  assert.equal(broken.status('codex').state, 'unknown');
});

test('an expired sign-in seen on an agent exit wins over a status that still says signed in', async () => {
  const m = createSignInMonitor({ path: () => '/bin/codex', run: async () => ({ code: 0 }) });
  m.status('codex'); await tick(); await tick();
  assert.equal(m.status('codex').state, 'signed-in');
  m.agentExited('codex', 'refresh token was revoked');
  const s = m.status('codex');
  assert.equal(s.state, 'expired'); assert.match(s.fix, /codex login/); assert.ok(s.seen);
  m.agentExited('codex', 'segfault'); assert.equal(m.status('codex').state, 'expired');
});

test('Codex status and expired-token findings stay scoped to the selected account home', async () => {
  const runs = [];
  const m = createSignInMonitor({ path: () => '/bin/codex', run: async (bin, args, timeout, env) => {
    runs.push({ bin, args, home: env?.CODEX_HOME });
    return { code: env?.CODEX_HOME.endsWith('dcxm') ? 0 : 1 };
  } });
  const dcx = { id: 'dcx', label: 'dcx · Main', home: '/fixture/dcx', bin: '/bin/codex' };
  const dcxm = { id: 'dcxm', label: 'dcxm · Alternate', home: '/fixture/dcxm', bin: '/bin/codex' };
  assert.equal(m.status('codex', dcx).state, 'unknown');
  assert.equal(m.status('codex', dcxm).state, 'unknown');
  await tick(); await tick();
  assert.equal(m.status('codex', dcx).state, 'signed-out');
  assert.equal(m.status('codex', dcxm).state, 'signed-in');
  assert.equal(m.status('codex', dcx).accountHome, undefined);
  assert.equal(m.status('codex', dcxm).accountLabel, 'dcxm · Alternate');
  m.agentExited('codex', 'refresh token was revoked', dcx);
  assert.equal(m.status('codex', dcx).state, 'expired');
  assert.equal(m.status('codex', dcxm).state, 'signed-in');
  assert.deepEqual(runs.map((r) => r.home), ['/fixture/dcx', '/fixture/dcxm', '/fixture/dcx']);
  assert.doesNotMatch(JSON.stringify(runs), /token|credential/i);
});

test('Check again clears stale account expiry without restarting and keeps provider defaults scoped', async () => {
  const runs = [];
  const m = createSignInMonitor({ path: () => '/bin/codex', run: async (_bin, _args, _timeout, env) => {
    runs.push({ home: env?.CODEX_HOME, key: env?.OPENAI_API_KEY });
    return { code: 0 };
  } });
  const account = { id: 'dcx', label: 'dcx · Main', home: '/fixture/dcx', bin: '/bin/codex' };
  m.agentExited('codex', 'refresh token was revoked', account);
  assert.equal(m.status('codex', account).state, 'expired');
  const refreshed = await m.refresh('codex', account);
  assert.equal(refreshed.state, 'signed-in');
  assert.equal(refreshed.accountId, 'dcx');
  await m.refresh('codex');
  assert.equal(runs[0].home, '/fixture/dcx');
  assert.equal(runs.at(-1).home, resolveSignInAccountHome('codex'));
  assert.ok(runs.every((run) => run.key === undefined));
});

test('Check again asynchronously refreshes a cold default command path and preserves explicit account bins', async () => {
  const runs = [];
  let resolves = 0;
  const m = createSignInMonitor({
    path: () => null,
    resolvePath: async () => { resolves++; await tick(); return '/fixture/claude'; },
    run: async (bin, args, timeout, env) => { runs.push({ bin, args, home: env?.CLAUDE_CONFIG_DIR }); return { code: 0 }; }
  });
  const selected = { id: 'alt', label: 'Alternate', home: '/fixture/alternate', bin: '/fixture/alternate/claude' };
  const checkedAccount = await m.refresh('claude', selected);
  assert.equal(checkedAccount.state, 'signed-in');
  assert.equal(resolves, 0, 'selected account binary bypasses provider default discovery');
  const checkedDefault = await m.refresh('claude');
  assert.equal(checkedDefault.state, 'signed-in');
  assert.equal(resolves, 1, 'default Check again awaits current async discovery');
  assert.deepEqual(runs.map(({ bin, home }) => [bin, home]), [
    ['/fixture/alternate/claude', '/fixture/alternate'], ['/fixture/claude', resolveSignInAccountHome('claude')]
  ]);
});

test('index.ts wires exits and the snapshot to the monitor', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.match(code, /engineSignIn\.agentExited\(String\(hive\.registry\(\)\.agents\[dyingAgent\]\?\.provider \?\? 'claude'\), info\?\.tail, ptySignInAccount\.get\(id\)\)/);
  assert.match(code, /engineSignIn\.status\(profile\.provider as 'claude' \| 'codex', profile\)/);
  assert.match(code, /ipcMain\.handle\('engine-signin:refresh'[\s\S]+engineSignIn\.refresh\(provider, account \?\? undefined\)/);
});

test('same profile ID with changed fingerprint or home never inherits cached auth or expiry', async () => {
  const calls = [];
  const m = createSignInMonitor({ path: () => '/bin/codex', run: async (_bin, _args, _timeout, env) => {
    calls.push(env.CODEX_HOME); return { code: env.CODEX_HOME.endsWith('/old') ? 0 : 1 };
  } });
  const old = { id: 'dcx', label: 'Work', home: '/fixture/old', fingerprint: 'a'.repeat(64) };
  const changed = { ...old, home: '/fixture/new', fingerprint: 'b'.repeat(64) };
  await m.refresh('codex', old);
  m.agentExited('codex', 'refresh token was revoked', old);
  assert.equal(m.status('codex', changed).state, 'unknown');
  await tick();
  assert.equal(m.status('codex', changed).state, 'signed-out');
  assert.deepEqual(calls, ['/fixture/old', '/fixture/new']);
  const renamed = { ...changed, label: 'Renamed' };
  assert.equal(m.status('codex', renamed).state, 'signed-out', 'label changes do not change auth identity');
});

test('default status honors the same explicit account home as login and invalidates on home change', async () => {
  const saved = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = '/fixture/default-a';
    const calls = [];
    const m = createSignInMonitor({ path: () => '/bin/codex', run: async (_bin, _args, _timeout, env) => {
      calls.push(env.CODEX_HOME); return { code: 0 };
    } });
    await m.refresh('codex');
    process.env.CODEX_HOME = '/fixture/default-b';
    assert.equal(m.status('codex').state, 'unknown');
    await tick();
    assert.deepEqual(calls, ['/fixture/default-a', '/fixture/default-b']);
  } finally { if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved; }
});

test('account status DTO does not disclose private account home or credential fields', async () => {
  const m = createSignInMonitor({ path: () => '/bin/claude', run: async () => ({ code: 0 }) });
  const state = await m.refresh('claude', { id: 'dc', label: 'Work', home: '/fixture/private-account', fingerprint: 'a'.repeat(64) });
  assert.equal(state.accountId, 'dc');
  assert.equal(state.accountHome, undefined);
  assert.doesNotMatch(JSON.stringify(state), /private-account|password|credential|token/i);
});
test('main login uses exact identity helper and fresh composed account catalog', () => {
 const source=fs.readFileSync(path.join(__dirname,'../src/main/index.ts'),'utf8');
 const login=source.slice(source.indexOf("ipcMain.handle('engine-signin:start'"),source.indexOf("ipcMain.handle('engine-signin:refresh'"));
 assert.match(login,/resolveSignInAccountHome\(provider, account \?\? undefined\)/);
 assert.match(login,/signInAccountKey\(provider, account \?\? undefined\)/);
 assert.match(login,/if \(account === null\)/);
 const resolution=source.slice(source.indexOf('function signInAccount('),source.indexOf("ipcMain.handle('engine-signin:start'"));
 assert.match(resolution,/currentAccountDiscovery\(\)/);
 assert.match(source,/if \(!gotInstanceLock\) throw new Error\('Another Paramount instance owns the account catalog/);
 assert.match(source,/createAccountProfileStore\(join\(sharedDataDir\(\), 'account-profiles'\)\)/);
});
