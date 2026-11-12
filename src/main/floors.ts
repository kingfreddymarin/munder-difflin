// Several floors at once (Munder 0.5.7 parity, NSC-193). One floor is one app process on one home
// folder. The first process uses the app's own data folder; every other floor runs as its own
// detached process started with --floor-data/--floor-shared/--floor-home, so it has its own data
// folder <shared>/floors/<sha1(home)[:12]> (its own single-instance lock, config, window DB) and its
// own Slack/webhook settings. The floor lock (floor-lock.ts) still decides who holds a hive.
//
// Electron-free on purpose: paramountShell.ts parses the flags before `app` is ready and the tests
// load this file directly.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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

/** A floor's own data folder: one per home folder, under the shared (main) data folder. */
export function floorDataDirFor(sharedDir: string, home: string): string {
  return join(sharedDir, FLOORS_DIR, createHash('sha1').update(resolve(home)).digest('hex').slice(0, 12));
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

/** A floor never lives in, above, or inside the app's data folders (this process's and the shared
 *  one): the hive would mix with config, window state and every floor's data. Owner report
 *  2026-11-12: setup had saved ~/Library/Application Support/Paramount itself as the floor. */
export function dataFolderRefusal(home: string, dataDirs: readonly string[]): string | null {
  const h = normaliseHome(home);
  for (const d of dataDirs) {
    const dir = resolve(d);
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
