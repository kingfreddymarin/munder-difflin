'use strict';
// Review 2026-11-12 (REVIEW-2026-11-12-floorlock.md) F1 and F4:
//  F1: an exclusive create followed by a separate write let a second claimant see an empty file,
//      unlink it and also win ("race true true"). Acquisition and stale reclaim must be serialized,
//      and a claim being written must never be unlinked.
//  F4: release checked only the profile path; it could delete a successor's lock, and removed an
//      unreadable lock unconditionally.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { acquireFloorLock, releaseFloorLock, createFloorGate, FLOOR_LOCK_FILE } = loadTs('src/main/floor-lock.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'council-race-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = path.join(home, 'hive');
  fs.mkdirSync(hive);
  return { home, hive, lockFile: path.join(hive, FLOOR_LOCK_FILE) };
}
const me = (pid, profile) => ({ pid, userData: `/tmp/profile-${profile}`, version: 'test' });

test('the reviewer\'s race: a second claimant entering mid-claim does not also win', (t) => {
  const f = floor(t);
  // As in the review's command A: run claimant B at the filesystem boundary of A's claim (the
  // moment A's lock becomes visible). B must find A's complete lock and be refused.
  let second;
  const link = fs.linkSync;
  fs.linkSync = function (from, to) {
    const r = link.call(fs, from, to);
    if (to === f.lockFile && !second) { second = 'running'; second = acquireFloorLock(f.hive, me(222, 'B'), () => true, { waitMs: 300 }); }
    return r;
  };
  let first;
  try { first = acquireFloorLock(f.hive, me(111, 'A'), () => true); } finally { fs.linkSync = link; }
  assert.equal(first.ok, true);
  assert.equal(second.ok, false, 'B must not also win');
  assert.equal(JSON.parse(fs.readFileSync(f.lockFile, 'utf8')).pid, 111);
});

test('a lock being written (empty or partial, and young) is waited for, never unlinked', (t) => {
  const f = floor(t);
  fs.writeFileSync(f.lockFile, ''); // Munder between its exclusive create and its write
  const r = acquireFloorLock(f.hive, me(222, 'B'), () => true, { waitMs: 200, sleep: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'io');
  assert.ok(fs.existsSync(f.lockFile), 'the in-progress claim is still there');
  assert.equal(fs.readFileSync(f.lockFile, 'utf8'), '');
});

// Real processes: N claimants start at the same instant; exactly one may win.
function race(hive, n, holdMs) {
  const child = `
    const loadTs = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))});
    const { acquireFloorLock } = loadTs('src/main/floor-lock.ts');
    const at = Number(process.argv[2]);
    while (Date.now() < at) {}
    const r = acquireFloorLock(process.argv[1], { pid: process.pid, userData: '/tmp/profile-' + process.pid, version: 'race' });
    process.stdout.write(JSON.stringify({ ok: r.ok, error: r.error, cleared: !!r.cleared }));
    setTimeout(() => {}, ${holdMs}); // stay alive so the others see a live holder
  `;
  const at = Date.now() + 1500;
  return Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', child, hive, String(at)], { cwd: path.join(__dirname, '..') });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `exit ${code}`)));
  })));
}

test('concurrent processes on a free floor: exactly one wins', { timeout: 60_000 }, async (t) => {
  const f = floor(t);
  const results = await race(f.hive, 6, 2500);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.ok(results.filter((r) => !r.ok).every((r) => r.error === 'held'), JSON.stringify(results));
});

test('concurrent processes reclaiming a dead holder\'s lock: exactly one wins', { timeout: 60_000 }, async (t) => {
  const f = floor(t);
  fs.writeFileSync(f.lockFile, JSON.stringify({ pid: 2 ** 22 + 12345, userData: '/tmp/profile-dead', since: '2026-11-12T00:00:00.000Z', version: '0.5.7' }, null, 2), { mode: 0o600 });
  const results = await race(f.hive, 6, 2500);
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(winners[0].cleared, true);
});

test('release never removes a successor\'s lock or an unreadable file', (t) => {
  const f = floor(t);
  const old = createFloorGate(me(111, 'A'), () => true);
  assert.equal(old.claim(f.home).state, 'open');
  // Same profile relaunched (or another holder after a takeover) replaces the lock.
  assert.equal(acquireFloorLock(f.hive, me(333, 'A'), () => true).ok, true);
  const successor = fs.readFileSync(f.lockFile, 'utf8');
  old.release();
  assert.equal(fs.readFileSync(f.lockFile, 'utf8'), successor, 'the successor keeps the floor');
  // An unreadable file is not proof of ownership.
  fs.writeFileSync(f.lockFile, '{ partial');
  const lock = JSON.parse(successor);
  assert.equal(releaseFloorLock(f.hive, lock, () => true), false);
  assert.equal(fs.readFileSync(f.lockFile, 'utf8'), '{ partial');
});

test('our lock is published complete in one step and leaves no temp files', (t) => {
  const f = floor(t);
  const r = acquireFloorLock(f.hive, me(111, 'A'), () => true);
  assert.equal(r.ok, true);
  assert.deepEqual(fs.readdirSync(f.hive).sort(), ['.floor-lock']);
  assert.equal(fs.statSync(f.lockFile).mode & 0o777, 0o600);
});
