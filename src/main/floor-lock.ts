// One app per floor, compatible with Munder Difflin 0.5.x's `<hive>/.floor-lock`.
//
// Munder 0.5.3+ records which process has a hive open in `.floor-lock`, and refuses a floor
// another live process holds. Council must honour the same file both ways: never open a floor
// Munder holds, and write the lock in Munder's format so Munder refuses Council's floor.
// The format is the file Munder writes: JSON with two-space indent and no trailing newline,
// mode 0600, fields { pid, userData, since, version }. The holder is identified by its
// userData folder (a relaunch of the same profile is "mine"); a dead pid is stale and is
// taken over; an unreadable file is replaced. Written for Council from that observed format
// and behaviour (the lock code is not in the public Munder source).
//
// The gate below keeps every floor service off until the lock is held: index.ts resolves the
// hive's home through `homeFor`, so on a refused floor hive.root() is null and no migration,
// archive, socket bind, git commit, spawn or registry write can run.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const FLOOR_LOCK_FILE = '.floor-lock';

export interface FloorLock { pid: number; userData: string; since: string; version?: string }
export interface FloorMe { pid: number; userData: string; version: string }
export type FloorLockCheck =
  | { state: 'free' } | { state: 'unreadable' }
  | { state: 'mine' | 'held' | 'stale'; lock: FloorLock };
export type FloorClaim =
  | { ok: true; lock: FloorLock; cleared?: FloorLock }
  | { ok: false; error: 'held'; lock: FloorLock }
  | { ok: false; error: 'io'; detail: string };

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function absolute(p: string): string {
  const t = p.trim();
  return resolve(t === '~' ? homedir() : t.startsWith('~/') ? join(homedir(), t.slice(2)) : t);
}
const samePath = (a: string, b: string) => absolute(a) === absolute(b);

export function readFloorLock(hiveRoot: string): FloorLock | 'unreadable' | null {
  const file = join(hiveRoot, FLOOR_LOCK_FILE);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<FloorLock> | null;
    if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.pid) || typeof raw.userData !== 'string' || !raw.userData) return 'unreadable';
    return { pid: raw.pid as number, userData: raw.userData, since: typeof raw.since === 'string' ? raw.since : '', ...(typeof raw.version === 'string' ? { version: raw.version } : {}) };
  } catch { return 'unreadable'; }
}

export function checkFloorLock(hiveRoot: string, me: FloorMe, isAlive: (pid: number) => boolean = pidAlive): FloorLockCheck {
  const lock = readFloorLock(hiveRoot);
  if (lock === null) return { state: 'free' };
  if (lock === 'unreadable') return { state: 'unreadable' };
  if (samePath(lock.userData, me.userData)) return { state: 'mine', lock };
  return isAlive(lock.pid) ? { state: 'held', lock } : { state: 'stale', lock };
}

// ── Acquisition is serialized ────────────────────────────────────────────────
// Review F1 (2026-11-12): an exclusive create followed by a separate write let a second claimant
// see an empty file, take it for unreadable, unlink it and also win. Now:
//  - our lock appears complete in one step: written to a private temp file, then hard-linked to
//    `.floor-lock` (link fails with EEXIST when a lock exists, like 'wx');
//  - every check / reclaim / create / release runs while holding a claim mutex, the directory
//    `.floor-lock.claim` (mkdir is atomic), so two Councils never interleave;
//  - an unreadable lock younger than PARTIAL_GRACE_MS is someone's claim being written (Munder
//    writes after its exclusive create): we wait, we never unlink it;
//  - a lock is removed only if its bytes are still the ones inspected (stale reclaim) or the ones
//    we wrote (release, review F4).
export const CLAIM_MUTEX = '.floor-lock.claim';
const MUTEX_STALE_MS = 10_000;
export const PARTIAL_GRACE_MS = 2_000;

export interface AcquireOptions { now?: () => Date; waitMs?: number; sleep?: (ms: number) => void }

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const readText = (file: string): string | null => { try { return readFileSync(file, 'utf8'); } catch (e) { if (errCode(e) === 'ENOENT') return null; throw e; } };
const ageMs = (file: string): number => { try { return Date.now() - statSync(file).mtimeMs; } catch { return 0; } };
const lockText = (lock: FloorLock) => JSON.stringify(lock, null, 2);

/** Run `fn` holding the claim mutex. Returns 'busy' when it could not be taken within waitMs. */
function withClaimMutex<T>(hiveRoot: string, waitMs: number, sleep: (ms: number) => void, isAlive: (pid: number) => boolean, fn: () => T): T | 'busy' {
  const dir = join(hiveRoot, CLAIM_MUTEX);
  const owner = join(dir, 'owner');
  const deadline = Date.now() + waitMs;
  for (;;) {
    let mine = false;
    try { mkdirSync(dir); mine = true; } catch (e) { if (errCode(e) !== 'EEXIST') throw e; }
    if (mine) {
      try { writeFileSync(owner, String(process.pid), { mode: 0o600 }); } catch { /* the pid only helps break a crashed claim */ }
      try { return fn(); } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* next claimant breaks it as stale */ } }
    }
    // A claim takes milliseconds; a mutex left by a crashed claimant is broken once its owner is
    // gone, or once it is old without an owner file.
    let holder: number | null = null;
    try { holder = Number.parseInt(readFileSync(owner, 'utf8'), 10); } catch { holder = null; }
    const stale = holder && holder > 0 ? !isAlive(holder) : ageMs(dir) > MUTEX_STALE_MS;
    if (stale) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* raced */ } continue; }
    if (Date.now() >= deadline) return 'busy';
    sleep(15 + Math.floor(Math.random() * 20));
  }
}

/** Take the floor: refuse while another live process holds it, else publish our complete lock. */
export function acquireFloorLock(hiveRoot: string, me: FloorMe, isAlive: (pid: number) => boolean = pidAlive, opts: AcquireOptions | (() => Date) = {}): FloorClaim {
  const o: AcquireOptions = typeof opts === 'function' ? { now: opts } : opts;
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? sleepSync;
  const file = join(hiveRoot, FLOOR_LOCK_FILE);
  const deadline = Date.now() + (o.waitMs ?? 3_000);
  try { mkdirSync(hiveRoot, { recursive: true }); } catch (e) { return { ok: false, error: 'io', detail: e instanceof Error ? e.message : String(e) }; }
  let cleared: FloorLock | undefined;
  for (;;) {
    const step = withClaimMutex(hiveRoot, Math.max(0, deadline - Date.now()), sleep, isAlive, (): FloorClaim | 'wait' => {
      const before = readText(file);
      const current = checkFloorLock(hiveRoot, me, isAlive);
      if (current.state === 'held') return { ok: false, error: 'held', lock: current.lock };
      if (current.state === 'unreadable' && ageMs(file) < PARTIAL_GRACE_MS) return 'wait';
      if (current.state !== 'free') {
        if (current.state === 'stale') cleared = current.lock;
        // Remove only the bytes we inspected; a lock that changed meanwhile is re-checked.
        if (readText(file) !== before) return 'wait';
        try { unlinkSync(file); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
      }
      const lock: FloorLock = { pid: me.pid, userData: absolute(me.userData), since: now().toISOString(), version: me.version };
      const tmp = join(hiveRoot, `${FLOOR_LOCK_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      writeFileSync(tmp, lockText(lock), { mode: 0o600, flag: 'wx' });
      try {
        chmodSync(tmp, 0o600);
        linkSync(tmp, file);
      } catch (e) {
        if (errCode(e) === 'EEXIST') return 'wait'; // another app created one between our checks
        throw e;
      } finally { try { unlinkSync(tmp); } catch { /* already gone */ } }
      return { ok: true, lock, ...(cleared ? { cleared } : {}) };
    });
    if (step !== 'wait' && step !== 'busy') return step;
    if (Date.now() >= deadline) {
      const last = checkFloorLock(hiveRoot, me, isAlive);
      if (last.state === 'held') return { ok: false, error: 'held', lock: last.lock };
      return { ok: false, error: 'io', detail: step === 'busy' ? 'another app is claiming this floor right now; try again' : 'the floor lock is being written by another app; try again' };
    }
    sleep(50);
  }
}

/** Remove the lock only when it is still exactly the claim this process wrote (review F4):
 *  never a successor's lock, never an unreadable file. */
export function releaseFloorLock(hiveRoot: string, mine: FloorLock, isAlive: (pid: number) => boolean = pidAlive, waitMs = 1_000): boolean {
  const file = join(hiveRoot, FLOOR_LOCK_FILE);
  if (!existsSync(hiveRoot)) return false;
  const r = withClaimMutex(hiveRoot, waitMs, sleepSync, isAlive, () => {
    if (readText(file) !== lockText(mine)) return false;
    try { unlinkSync(file); return true; } catch { return false; }
  });
  return r === true;
}

/** The app that holds a lock, in words: "Munder Difflin 0.5.7", "Paramount 0.4.6". */
export function floorOwnerName(lock: FloorLock): string {
  const v = lock.version ?? '';
  if (/^[A-Za-z]/.test(v)) return v;
  const app = /munder-difflin/i.test(lock.userData) ? 'Munder Difflin' : /paramount/i.test(lock.userData) ? 'Paramount' : 'Another app';
  return v ? `${app} ${v}` : app;
}

export interface FloorRefusal { floor: string; owner: string; pid: number; since: string; userData: string }
export type FloorGateState = { state: 'none' } | { state: 'open'; floor: string } | { state: 'refused'; refusal: FloorRefusal } | { state: 'error'; floor: string; detail: string };

/** Holds this process's claim on one floor. `homeFor` hands the hive its home only while held. */
export function createFloorGate(me: FloorMe, isAlive: (pid: number) => boolean = pidAlive) {
  let held: { home: string; lock: FloorLock } | null = null; // the harnessHome whose hive we hold
  let reserved: { home: string; lock: FloorLock } | null = null; // a move destination (config:changeHome)
  let state: FloorGateState = { state: 'none' };
  const hiveOf = (home: string) => join(home, 'hive');
  const take = (home: string): { ok: true; lock: FloorLock } | { ok: false; state: FloorGateState } => {
    const r = acquireFloorLock(hiveOf(home), me, isAlive);
    if (r.ok) return { ok: true, lock: r.lock };
    if (r.error === 'held') return { ok: false, state: { state: 'refused', refusal: { floor: home, owner: floorOwnerName(r.lock), pid: r.lock.pid, since: r.lock.since, userData: r.lock.userData } } };
    return { ok: false, state: { state: 'error', floor: home, detail: r.detail } };
  };
  return {
    /** Claim `home`'s floor. Called before any floor service starts. */
    claim(home: string | null | undefined): FloorGateState {
      if (!home) { state = { state: 'none' }; return state; }
      if (held && samePath(held.home, home)) { state = { state: 'open', floor: home }; return state; }
      if (held) { releaseFloorLock(hiveOf(held.home), held.lock, isAlive); held = null; }
      const r = take(home);
      if (r.ok) { held = { home, lock: r.lock }; state = { state: 'open', floor: home }; }
      else state = r.state;
      return state;
    },
    /** Claim a second floor (a move destination) while keeping the current one until its
     *  services have stopped. 'open' when reserved; the refusal or error otherwise. */
    reserve(home: string): FloorGateState {
      if (held && samePath(held.home, home)) return { state: 'open', floor: home };
      if (reserved && samePath(reserved.home, home)) return { state: 'open', floor: home };
      if (reserved) { releaseFloorLock(hiveOf(reserved.home), reserved.lock, isAlive); reserved = null; }
      const r = take(home);
      if (!r.ok) return r.state;
      reserved = { home, lock: r.lock };
      return { state: 'open', floor: home };
    },
    /** Give up a reservation (the move failed). */
    unreserve(): void {
      if (reserved) releaseFloorLock(hiveOf(reserved.home), reserved.lock, isAlive);
      reserved = null;
    },
    /** The home the hive may use: the configured one only while we hold its lock. */
    homeFor(home: string | null | undefined): string | null {
      return home && held && samePath(held.home, home) ? home : null;
    },
    state(): FloorGateState { return state; },
    /** On quit or floor change: the current floor only (a reservation is kept for the relaunch). */
    release(): void {
      if (held) releaseFloorLock(hiveOf(held.home), held.lock, isAlive);
      held = null;
    },
  };
}
