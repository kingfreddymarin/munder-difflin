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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
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

/** Take the floor: refuse while another live process holds it, else write our lock exclusively. */
export function acquireFloorLock(hiveRoot: string, me: FloorMe, isAlive: (pid: number) => boolean = pidAlive, now: () => Date = () => new Date()): FloorClaim {
  const file = join(hiveRoot, FLOOR_LOCK_FILE);
  const lock: FloorLock = { pid: me.pid, userData: absolute(me.userData), since: now().toISOString(), version: me.version };
  let cleared: FloorLock | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = checkFloorLock(hiveRoot, me, isAlive);
    if (current.state === 'held') return { ok: false, error: 'held', lock: current.lock };
    if (current.state !== 'free') {
      if (current.state === 'stale') cleared = current.lock;
      try { unlinkSync(file); } catch { /* raced away */ }
    }
    try {
      mkdirSync(hiveRoot, { recursive: true });
      const fd = openSync(file, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify(lock, null, 2)); } finally { closeSync(fd); }
      return { ok: true, lock, ...(cleared ? { cleared } : {}) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, error: 'io', detail: e instanceof Error ? e.message : String(e) };
    }
  }
  const last = checkFloorLock(hiveRoot, me, isAlive);
  if (last.state === 'held') return { ok: false, error: 'held', lock: last.lock };
  return { ok: false, error: 'io', detail: 'could not create the lock after three attempts' };
}

/** Remove the lock only when it is ours (or unreadable). */
export function releaseFloorLock(hiveRoot: string, me: FloorMe): boolean {
  const lock = readFloorLock(hiveRoot);
  if (lock === null) return false;
  if (lock !== 'unreadable' && !samePath(lock.userData, me.userData)) return false;
  try { unlinkSync(join(hiveRoot, FLOOR_LOCK_FILE)); return true; } catch { return false; }
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
  let held: string | null = null; // the harnessHome whose hive we hold
  let state: FloorGateState = { state: 'none' };
  const hiveOf = (home: string) => join(home, 'hive');
  return {
    /** Claim `home`'s floor. Called before any floor service starts. */
    claim(home: string | null | undefined): FloorGateState {
      if (!home) { state = { state: 'none' }; return state; }
      if (held && samePath(held, home)) { state = { state: 'open', floor: home }; return state; }
      if (held) { releaseFloorLock(hiveOf(held), me); held = null; }
      const r = acquireFloorLock(hiveOf(home), me, isAlive);
      if (r.ok) { held = home; state = { state: 'open', floor: home }; }
      else if (r.error === 'held') state = { state: 'refused', refusal: { floor: home, owner: floorOwnerName(r.lock), pid: r.lock.pid, since: r.lock.since, userData: r.lock.userData } };
      else state = { state: 'error', floor: home, detail: r.detail };
      return state;
    },
    /** The home the hive may use: the configured one only while we hold its lock. */
    homeFor(home: string | null | undefined): string | null {
      return home && held && samePath(held, home) ? home : null;
    },
    state(): FloorGateState { return state; },
    /** On quit or floor change. */
    release(): void {
      if (held) releaseFloorLock(hiveOf(held), me);
      held = null;
    },
  };
}
