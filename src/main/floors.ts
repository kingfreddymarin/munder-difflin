// Several floors at once (Munder 0.5.7 parity, NSC-193). One floor is one app process on one home
// folder. The first process uses the app's own data folder; every other floor runs as its own
// detached process started with --floor-data/--floor-shared/--floor-home, so it has its own data
// folder <shared>/floors/<sha1(home)[:12]> (its own single-instance lock, config, window DB) and its
// own Slack/webhook settings. The floor lock (floor-lock.ts) still decides who holds a hive.
//
// Electron-free on purpose: paramountShell.ts parses the flags before `app` is ready and the tests
// load this file directly.
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { checkFloorLock, pidAlive, type FloorLock, type FloorMe } from './floor-lock';

export const FLOOR_DATA_FLAG = '--floor-data=';
export const FLOOR_SHARED_FLAG = '--floor-shared=';
export const FLOOR_HOME_FLAG = '--floor-home=';
export const FLOORS_DIR = 'floors';

export interface FloorArgs { dataDir: string; sharedDir: string; home: string | null }

function flag(argv: readonly string[], prefix: string): string | null {
  for (const a of argv) if (a.startsWith(prefix) && a.length > prefix.length) return a.slice(prefix.length);
  return null;
}

/** The floor flags of a floor process, or null for the first (main) process. Both folders must be
 *  absolute and different; a relative home is ignored. */
export function parseFloorArgs(argv: readonly string[]): FloorArgs | null {
  const dataDir = flag(argv, FLOOR_DATA_FLAG);
  const sharedDir = flag(argv, FLOOR_SHARED_FLAG);
  const home = flag(argv, FLOOR_HOME_FLAG);
  if (!dataDir || !sharedDir || !isAbsolute(dataDir) || !isAbsolute(sharedDir)) return null;
  if (resolve(dataDir) === resolve(sharedDir)) return null;
  return { dataDir: resolve(dataDir), sharedDir: resolve(sharedDir), home: home && isAbsolute(home) ? resolve(home) : null };
}

/** Set on the relaunch after a Floor location change: the main process opens the configured floor
 *  without the picker. */
export const OPEN_LAST_FLOOR_FLAG = '--council-open-floor';
/** Set on a floor process's relaunch after Switch floor: start at the picker, not on its home. */
export const FLOOR_PICKER_FLAG = '--council-floor-picker';

/** What a process opens at boot (review F1, F2). A floor process opens its own --floor-home, never
 *  the home in its config, and after Switch floor shows the picker instead. The main process opens
 *  nothing (the picker) except on the relaunch after a Floor location change. `rewriteConfig` says
 *  a floor process's config names another home and must be pointed back at its own. */
export function bootFloorPlan(argv: readonly string[], configHome: string | null): { open: string | null; rewriteConfig: boolean } {
  const floor = parseFloorArgs(argv);
  if (floor?.home) {
    if (argv.includes(FLOOR_PICKER_FLAG)) return { open: null, rewriteConfig: false };
    return { open: floor.home, rewriteConfig: !configHome || resolve(configHome) !== floor.home };
  }
  if (argv.includes(OPEN_LAST_FLOOR_FLAG) && configHome) return { open: configHome, rewriteConfig: false };
  return { open: null, rewriteConfig: false };
}

/** Relaunch arguments for Switch floor (review F1): never reopen a floor. The main process drops the
 *  Floor location flag; a floor process keeps its floor flags and adds the picker flag. */
export function switchRelaunchArgs(args: readonly string[]): string[] {
  const rest = args.filter((a) => a !== OPEN_LAST_FLOOR_FLAG && a !== FLOOR_PICKER_FLAG);
  return parseFloorArgs(rest)?.home ? [...rest, FLOOR_PICKER_FLAG] : rest;
}

/** Relaunch arguments after a Floor location change (review F2). The main process opens the new
 *  home from its config; a floor process restarts as the new home's floor, on that home's data folder. */
export function moveRelaunchArgs(args: readonly string[], move: { home: string; dataDir: string }): string[] {
  const rest = args.filter((a) => a !== OPEN_LAST_FLOOR_FLAG && a !== FLOOR_PICKER_FLAG);
  if (!parseFloorArgs(rest)?.home) return [...rest, OPEN_LAST_FLOOR_FLAG];
  return rest.map((a) => a.startsWith(FLOOR_DATA_FLAG) ? `${FLOOR_DATA_FLAG}${move.dataDir}` : a.startsWith(FLOOR_HOME_FLAG) ? `${FLOOR_HOME_FLAG}${move.home}` : a);
}

/** A floor's own data folder: one per home folder, under the shared (main) data folder. */
export function floorDataDirFor(sharedDir: string, home: string): string {
  return join(sharedDir, FLOORS_DIR, createHash('sha1').update(resolve(home)).digest('hex').slice(0, 12));
}

/** SQLite's durable per-floor state. WAL files must travel with the database. */
export const FLOOR_PERSISTED_STATE_FILES = ['harness.db', 'harness.db-wal', 'harness.db-shm'] as const;

export type FloorStateRecoveryState = 'destination-unchanged' | 'previous-target-restored' | 'recovery-backup-retained' | 'new-target-installed';

export class FloorPersistedStateCopyError extends Error {
  constructor(
    message: string,
    readonly recoveryState: FloorStateRecoveryState,
    readonly recoveryPath?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FloorPersistedStateCopyError';
  }
}

/** Hash in fixed-size chunks so large floor databases do not need to fit in memory. */
function floorFileDigest(path: string): string {
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytes: number;
    while ((bytes = readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, bytes));
  } finally { closeSync(fd); }
  return `${statSync(path).size}:${hash.digest('hex')}`;
}

function floorFilesMatch(directory: string, expected: Map<string, string>): boolean {
  try {
    for (const file of FLOOR_PERSISTED_STATE_FILES) {
      const path = join(directory, file);
      const exists = existsSync(path);
      if (exists !== expected.has(file)) return false;
      if (exists && floorFileDigest(path) !== expected.get(file)) return false;
    }
    return true;
  } catch { return false; }
}

function hasFloorFiles(directory: string): boolean {
  return FLOOR_PERSISTED_STATE_FILES.some((file) => existsSync(join(directory, file)));
}

/** Carry durable command history and app state when a floor is re-keyed by a home move. */
export function copyFloorPersistedState(sourceDir: string, targetDir: string, ops: {
  cpSync?: typeof cpSync; renameSync?: typeof renameSync; rmSync?: typeof rmSync;
} = {}): void {
  const copy = ops.cpSync ?? cpSync;
  const rename = ops.renameSync ?? renameSync;
  const remove = ops.rmSync ?? rmSync;
  mkdirSync(targetDir, { recursive: true });
  if (!existsSync(join(sourceDir, 'harness.db'))) return;
  const sourceFiles = new Map(FLOOR_PERSISTED_STATE_FILES.filter((file) => existsSync(join(sourceDir, file)))
    .map((file) => [file, floorFileDigest(join(sourceDir, file))]));
  const previousFiles = new Map(FLOOR_PERSISTED_STATE_FILES.filter((file) => existsSync(join(targetDir, file)))
    .map((file) => [file, floorFileDigest(join(targetDir, file))]));
  const staging = mkdtempSync(join(targetDir, '.floor-state-copy-'));
  const staged = join(staging, 'staged');
  const backup = join(staging, 'backup');
  mkdirSync(staged); mkdirSync(backup);
  const present = FLOOR_PERSISTED_STATE_FILES.filter((file) => existsSync(join(sourceDir, file)));
  const movedOld: string[] = [];
  const installed: string[] = [];
  try {
    // Stage every source file first. A source read/copy failure leaves the target untouched.
    for (const file of present) copy(join(sourceDir, file), join(staged, file));
    // Move all old database members aside, including stale sidecars absent at source.
    for (const file of FLOOR_PERSISTED_STATE_FILES) {
      const target = join(targetDir, file);
      if (existsSync(target)) { rename(target, join(backup, file)); movedOld.push(file); }
    }
    for (const file of present) {
      rename(join(staged, file), join(targetDir, file));
      installed.push(file);
    }
    if (!floorFilesMatch(targetDir, sourceFiles)) throw new Error('Installed floor database files did not match the staged source.');
  } catch (operationError) {
    const restoreErrors: string[] = [];
    for (const file of installed) {
      try { remove(join(targetDir, file), { force: true }); }
      catch (error) { restoreErrors.push(`remove installed ${file}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const file of movedOld) {
      try { rename(join(backup, file), join(targetDir, file)); }
      catch (error) { restoreErrors.push(`restore ${file}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const originalError = operationError instanceof Error ? operationError.message : String(operationError);
    if (!floorFilesMatch(targetDir, previousFiles)) {
      const retainedPath = hasFloorFiles(backup) ? backup : (hasFloorFiles(staged) ? staged : undefined);
      throw new FloorPersistedStateCopyError(
        `Floor state copy failed (${originalError}); prior destination state could not be fully restored.${retainedPath ? ` Recovery data retained at ${retainedPath}.` : ''}${restoreErrors.length ? ` Restore errors: ${restoreErrors.join('; ')}.` : ''}`,
        'recovery-backup-retained', retainedPath, { cause: operationError },
      );
    }
    try { remove(staging, { recursive: true, force: true }); }
    catch (cleanupError) {
      const retainedPath = hasFloorFiles(backup) ? backup : undefined;
      throw new FloorPersistedStateCopyError(
        `Floor state copy failed (${originalError}); prior destination state was restored and verified, but staging cleanup failed${retainedPath ? `; residual data remains at ${retainedPath}` : ''}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        'previous-target-restored', retainedPath, { cause: operationError },
      );
    }
    throw new FloorPersistedStateCopyError(
      `Floor state copy failed (${originalError}); prior destination state was restored and verified.`,
      'previous-target-restored', undefined, { cause: operationError },
    );
  }
  try { remove(staging, { recursive: true, force: true }); }
  catch (cleanupError) {
    const retainedPath = hasFloorFiles(backup) ? backup : undefined;
    throw new FloorPersistedStateCopyError(
      `New floor state was copied and verified, but staging cleanup failed${retainedPath ? `; prior data remains at ${retainedPath}` : ''}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      'new-target-installed', retainedPath, { cause: cleanupError },
    );
  }
}

/** How to start a floor process: the packaged app takes the flags directly; a dev run needs its app path. */
export function floorSpawnPlan(o: { execPath: string; appPath: string; packaged: boolean; dataDir: string; sharedDir: string; home: string }): { command: string; args: string[] } {
  const flags = [`${FLOOR_DATA_FLAG}${o.dataDir}`, `${FLOOR_SHARED_FLAG}${o.sharedDir}`, `${FLOOR_HOME_FLAG}${o.home}`];
  return { command: o.execPath, args: o.packaged ? flags : [o.appPath, ...flags] };
}

/** Settings that belong to one floor and are never copied into a new floor's config: its home and
 *  recents, its repos, missions, limits, per-agent settings, and its Slack and webhook endpoints
 *  (two floors on one port would collide). */
export const FLOOR_CONFIG_STRIP = [
  'harnessHome', 'recentHives', 'registeredRepos', 'missions', 'opsStandupSeeded', 'heartbeatSeeded', 'compactMaintenanceSeeded',
  'tokenLimits', 'agentMcp', 'agentCustomMcp', 'agentSkillsOff', 'autoDeliveryPausedAgents', 'avatars',
  'slackEnabled', 'slackSigningSecret', 'slackBotToken', 'slackChannelId', 'slackPort', 'slackProactivePosting', 'slackMode',
  'webhookEnabled', 'webhookSecret', 'webhookPort', 'webhookTriggers'
] as const;

/** A new floor's first config: the main config without the per-floor settings, on its own home. */
export function seedFloorConfig(main: Record<string, unknown>, home: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(main)) if (!(FLOOR_CONFIG_STRIP as readonly string[]).includes(k)) out[k] = v;
  out.harnessHome = resolve(home);
  out.recentHives = [resolve(home)];
  out.slackEnabled = false;
  out.webhookEnabled = false;
  return out;
}

/** The main config a new floor is seeded from; {} when it is missing or unreadable. */
export function readSharedConfig(sharedDir: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(join(sharedDir, 'config.json'), 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  } catch { return {}; }
}

export function normaliseHome(p: string): string {
  const t = p.trim();
  return resolve(t === '~' ? homedir() : t.startsWith('~/') ? join(homedir(), t.slice(2)) : t);
}
const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Resolve symlinks in the existing prefix without creating missing paths. */
function canonicalPath(input: string): string {
  let candidate = resolve(input);
  const suffix: string[] = [];
  while (!existsSync(candidate)) {
    const parent = resolve(candidate, '..');
    if (parent === candidate) break;
    suffix.unshift(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    candidate = parent;
  }
  try { candidate = realpathSync(candidate); } catch { /* retain normalized absolute path */ }
  return resolve(candidate, ...suffix);
}

function equivalentPath(path: string): string {
  // Default macOS and Windows volumes are case-insensitive. Lower-casing the
  // entire absolute path keeps nonexistent suffixes equivalent there as well.
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLocaleLowerCase('en-US') : path;
}

/** A floor never lives in, above, or inside the app's data folders (this process's and the shared
 *  one): the hive would mix with config, window state and every floor's data. Owner report
 *  2026-11-12: setup had saved ~/Library/Application Support/Paramount itself as the floor. */
export function dataFolderRefusal(home: string, dataDirs: readonly string[]): string | null {
  const h = equivalentPath(canonicalPath(normaliseHome(home)));
  for (const d of dataDirs) {
    const dir = equivalentPath(canonicalPath(d));
    if (within(h, dir) || within(dir, h)) return "A floor cannot use this floor's own data folder.";
  }
  return null;
}

export type FloorProbe =
  | { state: 'missing' } | { state: 'current' } | { state: 'free' } | { state: 'data-folder' }
  | { state: 'held'; lock: FloorLock };

export interface FloorContext {
  /** The floor this process has open, if any. */
  currentHome: string | null;
  me: FloorMe;
  dataDirs: readonly string[];
  isAlive?: (pid: number) => boolean;
}

/** A recent floor's state for the picker. Read-only: nothing is written on any floor. */
export function probeFloor(home: string, ctx: FloorContext): FloorProbe {
  const h = normaliseHome(home);
  if (dataFolderRefusal(h, ctx.dataDirs)) return { state: 'data-folder' };
  if (!existsSync(h)) return { state: 'missing' };
  if (ctx.currentHome && normaliseHome(ctx.currentHome) === h) return { state: 'current' };
  const s = checkFloorLock(join(h, 'hive'), ctx.me, ctx.isAlive ?? pidAlive);
  if (s.state === 'held') return { state: 'held', lock: s.lock };
  if (s.state === 'mine') return { state: 'current' };
  return { state: 'free' };
}

export type FloorRequest =
  | { ok: true; home: string }
  | { ok: false; refusal: 'invalid' | 'current' | 'data-folder' | 'held'; message: string; lock?: FloorLock };

/** May a new floor process open this folder? Checked before any folder or process is made. */
export function validateFloorRequest(home: unknown, ctx: FloorContext): FloorRequest {
  // Checked before resolving: resolve() would anchor a relative path at the app's working folder.
  if (typeof home !== 'string' || !home.trim() || !(isAbsolute(home.trim()) || home.trim() === '~' || home.trim().startsWith('~/'))) return { ok: false, refusal: 'invalid', message: 'Choose a full folder path for the floor.' };
  const h = normaliseHome(home);
  const data = dataFolderRefusal(h, ctx.dataDirs);
  if (data) return { ok: false, refusal: 'data-folder', message: data };
  const p = probeFloor(h, ctx);
  if (p.state === 'current') return { ok: false, refusal: 'current', message: 'That folder is the floor this window already has open.' };
  if (p.state === 'held') return { ok: false, refusal: 'held', message: `That folder is open in another floor (pid ${p.lock.pid}). Close that floor first, or choose another folder.`, lock: p.lock };
  return { ok: true, home: h };
}
