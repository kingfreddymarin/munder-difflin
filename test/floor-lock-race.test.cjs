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
  // Another app (Munder does not take Council's kernel claim) replaced the lock meanwhile.
  const successor = JSON.stringify({ pid: 333, userData: '/tmp/profile-A', since: '2026-11-12T17:00:00.000Z', version: '0.5.7' }, null, 2);
  fs.writeFileSync(f.lockFile, successor);
  old.release();
  assert.equal(fs.readFileSync(f.lockFile, 'utf8'), successor, 'the successor keeps the floor');
  // An unreadable file is not proof of ownership.
  fs.writeFileSync(f.lockFile, '{ partial');
  assert.equal(releaseFloorLock(f.hive, JSON.parse(successor), () => true), false);
  assert.equal(fs.readFileSync(f.lockFile, 'utf8'), '{ partial');
});

test('our lock is published complete in one step and leaves no temp files', (t) => {
  const f = floor(t);
  const r = acquireFloorLock(f.hive, me(111, 'A'), () => true);
  assert.equal(r.ok, true);
  // .floor-lock.flock is the kernel claim (macOS); it stays and is never deleted.
  assert.deepEqual(fs.readdirSync(f.hive).filter((n) => n !== '.floor-lock.flock').sort(), ['.floor-lock']);
  assert.equal(fs.statSync(f.lockFile).mode & 0o777, 0o600);
});

// Re-review R1 (REVIEW-2026-11-12-floorlock-rereview.md): with a crashed claimant's leftovers, two
// real processes interleaved at the reclaim steps both owned the floor. The claim is now a kernel
// lock (macOS O_EXLOCK) that dies with its process, so there is no stale claim to break.
// Each child pauses at a reclaim step until told to go: A at the first of (removing a crashed
// claim mutex, unlinking the stale .floor-lock); B only before unlinking the stale .floor-lock.
function pausedClaimant(hive, ctl, name, pauseOn, waitMs) {
  const src = `
    const fs = require('node:fs'), path = require('node:path');
    const [hive, ctl, name, pauseOn] = process.argv.slice(1);
    const lockFile = path.join(hive, '.floor-lock'), mutex = path.join(hive, '.floor-lock.claim');
    let paused = false;
    const pause = () => { if (paused) return; paused = true; fs.writeFileSync(path.join(ctl, name + '-paused'), '');
      while (!fs.existsSync(path.join(ctl, name + '-go'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); };
    const rm = fs.rmSync, unlink = fs.unlinkSync;
    fs.rmSync = function (p, ...a) { if (pauseOn === 'first' && p === mutex) pause(); return rm.call(fs, p, ...a); };
    fs.unlinkSync = function (p, ...a) { if (p === lockFile) pause(); return unlink.call(fs, p, ...a); };
    const { acquireFloorLock } = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))})('src/main/floor-lock.ts');
    const r = acquireFloorLock(hive, { pid: process.pid, userData: '/tmp/profile-' + name, version: 'race' }, undefined, { waitMs: ${waitMs} });
    fs.writeFileSync(path.join(ctl, name + '-result'), JSON.stringify({ ok: r.ok, error: r.error, pid: process.pid }));
    setTimeout(() => {}, 3000); // stay alive: a live holder
  `;
  return spawn(process.execPath, ['-e', src, hive, ctl, name, pauseOn], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
}
const until = async (cond, ms = 10_000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 20)); } return true; };

test('R1: two processes interleaved at the reclaim of a crashed claimant cannot both own the floor', { timeout: 60_000 }, async (t) => {
  const f = floor(t);
  const ctl = fs.mkdtempSync(path.join(os.tmpdir(), 'council-r1-'));
  t.after(() => fs.rmSync(ctl, { recursive: true, force: true }));
  const dead = 2 ** 22 + 4321;
  fs.mkdirSync(path.join(f.hive, '.floor-lock.claim'));
  fs.writeFileSync(path.join(f.hive, '.floor-lock.claim', 'owner'), String(dead));
  fs.writeFileSync(f.lockFile, JSON.stringify({ pid: dead, userData: '/tmp/profile-dead', since: '', version: '0.5.7' }, null, 2));
  const a = pausedClaimant(f.hive, ctl, 'A', 'first', 8000);
  t.after(() => a.kill('SIGKILL'));
  assert.ok(await until(() => fs.existsSync(path.join(ctl, 'A-paused'))), 'A reached a reclaim step');
  const b = pausedClaimant(f.hive, ctl, 'B', 'unlink', 1500);
  t.after(() => b.kill('SIGKILL'));
  await until(() => fs.existsSync(path.join(ctl, 'B-paused')) || fs.existsSync(path.join(ctl, 'B-result')), 6000);
  fs.writeFileSync(path.join(ctl, 'A-go'), '');
  assert.ok(await until(() => fs.existsSync(path.join(ctl, 'A-result'))));
  fs.writeFileSync(path.join(ctl, 'B-go'), '');
  assert.ok(await until(() => fs.existsSync(path.join(ctl, 'B-result'))));
  const ra = JSON.parse(fs.readFileSync(path.join(ctl, 'A-result'), 'utf8'));
  const rb = JSON.parse(fs.readFileSync(path.join(ctl, 'B-result'), 'utf8'));
  assert.equal([ra, rb].filter((r) => r.ok).length, 1, JSON.stringify({ ra, rb }));
  const winner = ra.ok ? ra : rb;
  assert.equal(JSON.parse(fs.readFileSync(f.lockFile, 'utf8')).pid, winner.pid, 'the lock on disk is the winner\'s');
});

test('R1: a claimant killed while holding the claim leaves nothing stale; six contenders, one winner', { timeout: 60_000 }, async (t) => {
  const f = floor(t);
  const crash = `const { acquireFloorLock } = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))})('src/main/floor-lock.ts');
    const r = acquireFloorLock(process.argv[1], { pid: process.pid, userData: '/tmp/profile-crash', version: 'race' });
    if (!r.ok) process.exit(2); process.kill(process.pid, 'SIGKILL');`;
  await new Promise((resolve) => spawn(process.execPath, ['-e', crash, f.hive], { cwd: path.join(__dirname, '..') }).on('exit', resolve));
  assert.equal(JSON.parse(fs.readFileSync(f.lockFile, 'utf8')).userData, '/tmp/profile-crash');
  const results = await race(f.hive, 6, 2500);
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(winners[0].cleared, true);
});

test('R5: a crashed claim that cannot be cleared is reported within the wait, never spun on', (t) => {
  const f = floor(t);
  const mutex = path.join(f.hive, '.floor-lock.claim');
  fs.mkdirSync(mutex);
  fs.writeFileSync(path.join(mutex, 'owner'), String(2 ** 22 + 99));
  const rm = fs.rmSync;
  let denied = 0;
  fs.rmSync = function (p, ...a) { if (p === mutex) { denied++; const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return rm.call(fs, p, ...a); };
  const started = Date.now();
  let r;
  try { r = acquireFloorLock(f.hive, me(111, 'A'), (pid) => pid === 111, { waitMs: 10, kernelLock: false }); } finally { fs.rmSync = rm; }
  assert.ok(Date.now() - started < 1000, 'bounded');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'io');
  assert.match(r.detail, /could not clear a crashed claim \(\.floor-lock\.claim\): EACCES/);
  assert.equal(denied, 1);
});
