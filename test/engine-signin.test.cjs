'use strict';
// Owner run of ceeb4aaf: Codex was installed but its refresh token had been revoked; Council said
// nothing and agents died. engine-signin.ts flags a signed-out or expired engine with the fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { createSignInMonitor, signInFailure, STATUS_TTL_MS } = loadTs('src/main/engine-signin.ts');
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

test('index.ts wires exits and the snapshot to the monitor', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.match(code, /engineSignIn\.agentExited\(String\(hive\.registry\(\)\.agents\[dyingAgent\]\?\.provider \?\? 'claude'\), info\?\.tail\)/);
  assert.match(code, /signIn: Object\.fromEntries\(\(\['claude', 'codex'\] as const\)\.filter\(\(e\) => ptyManager\.commandPath\(e\)\)\.map\(\(e\) => \[e, engineSignIn\.status\(e\)\]\)\)/);
});
