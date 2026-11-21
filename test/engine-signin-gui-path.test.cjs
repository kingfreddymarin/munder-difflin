'use strict';
// NSC-193 / provider-default GUI PATH fix (2026-11-21):
// Under a launchd GUI launch PATH (/usr/bin:/bin:/usr/sbin:/sbin), execFile('claude', ...)
// → ENOENT in 3ms → auth-unknown → switch preflight fails.
// Repro: account.bin is bare 'claude'; account?.bin is truthy → discovery path skipped.
// Fix: treat non-absolute account.bin as unset in probe() and refresh().
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { createSignInMonitor } = loadTs('src/main/engine-signin.ts');
const tick = () => new Promise(setImmediate);

// Helpers ------------------------------------------------------------------

function makeMonitor(opts = {}) {
  const runs = [];
  // resolvePath: explicitly null/undefined → omit it from createSignInMonitor (uses opts.path only).
  //              not provided → provide a default async resolver.
  const hasResolve = 'resolvePath' in opts && opts.resolvePath != null;
  const defaultResolve = !('resolvePath' in opts)
    ? async (engine) => ('resolvedPath' in opts ? opts.resolvedPath : `/resolved-async/${engine}`)
    : undefined;
  const m = createSignInMonitor({
    path: 'path' in opts ? (() => opts.path) : ((engine) => `/resolved/${engine}`),
    ...(hasResolve ? { resolvePath: opts.resolvePath } : defaultResolve ? { resolvePath: defaultResolve } : {}),
    run: async (bin, args) => { runs.push(bin); return { code: opts.exitCode ?? 0 }; },
  });
  return { m, runs };
}

// 1. refresh(): bare account.bin skips to resolvePath -----------------------

test('refresh(): bare account.bin falls through to resolvePath (GUI PATH ENOENT regression)', async () => {
  const { m, runs } = makeMonitor({ resolvedPath: '/opt/homebrew/bin/claude' });
  const account = { id: 'default-agentX', label: 'Provider default', bin: 'claude', home: '/home/user/.claude' };
  const result = await m.refresh('claude', account);
  assert.equal(result.state, 'signed-in');
  // Bare 'claude' must NEVER be passed to execFile; only the absolute path from discovery.
  assert.equal(runs.length, 1);
  assert.equal(runs[0], '/opt/homebrew/bin/claude');
  assert.doesNotMatch(runs[0], /^claude$/, 'execFile must not receive bare command name');
});

// 2. refresh(): absolute account.bin is used directly (unchanged behaviour) -

test('refresh(): absolute account.bin is used directly without calling resolvePath', async () => {
  let resolvePathCalled = false;
  const { m, runs } = makeMonitor({
    resolvePath: async () => { resolvePathCalled = true; return '/should/not/be/called'; }
  });
  const account = { id: 'dcx', label: 'dcx · Main', bin: '/opt/homebrew/bin/claude', home: '/home/user/.dcx' };
  const result = await m.refresh('claude', account);
  assert.equal(result.state, 'signed-in');
  assert.equal(resolvePathCalled, false, 'resolvePath must not be called when account.bin is already absolute');
  assert.equal(runs[0], '/opt/homebrew/bin/claude');
});

// 3. probe() / status(): bare account.bin falls through to opts.path --------

test('status(): bare account.bin falls through to opts.path for background probe', async () => {
  const { m, runs } = makeMonitor({ path: '/opt/homebrew/bin/claude', exitCode: 0 });
  const account = { id: 'default-agentY', label: 'Provider default', bin: 'claude', home: '/home/user/.claude' };
  m.status('claude', account);
  await tick(); await tick();
  assert.equal(m.status('claude', account).state, 'signed-in');
  assert.equal(runs.length, 1);
  assert.equal(runs[0], '/opt/homebrew/bin/claude');
  assert.doesNotMatch(runs[0], /^claude$/, 'background probe must not use bare name');
});

// 4. refresh(): bare bin + resolvePath returns null → fail-closed unknown ---

test('refresh(): bare account.bin + resolvePath null → unknown (fail-closed)', async () => {
  const { m, runs } = makeMonitor({ resolvePath: async () => null, resolvedPath: null });
  const account = { id: 'default-agentZ', label: 'Provider default', bin: 'claude', home: '/home/user/.claude' };
  const result = await m.refresh('claude', account);
  // No bin resolved → no run; result must be 'unknown', not an ENOENT crash.
  assert.equal(result.state, 'unknown');
  assert.equal(runs.length, 0, 'execFile must not be called when no absolute path is resolvable');
});

// 5. refresh(): bare bin + no resolvePath + opts.path null → fail-closed ----

test('refresh(): bare account.bin + opts.path null → unknown (fail-closed, no resolvePath)', async () => {
  const { m, runs } = makeMonitor({ path: null, resolvePath: undefined });
  const account = { id: 'default-agentW', label: 'Provider default', bin: 'codex', home: '/home/user/.codex' };
  const result = await m.refresh('codex', account);
  assert.equal(result.state, 'unknown');
  assert.equal(runs.length, 0);
});

// 6. refresh(): relative path without separator is also treated as bare ------

test('refresh(): relative path without leading slash falls through to resolvePath', async () => {
  const { m, runs } = makeMonitor({ resolvedPath: '/usr/local/bin/claude' });
  const account = { id: 'rel', label: 'Relative', bin: 'bin/claude', home: '/home/user/.claude' };
  const result = await m.refresh('claude', account);
  assert.equal(result.state, 'signed-in');
  assert.equal(runs[0], '/usr/local/bin/claude');
  assert.doesNotMatch(runs[0], /^bin\//, 'relative path must not be passed to execFile');
});
