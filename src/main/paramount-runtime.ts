// Council runtime duties that Munder runs from renderer hooks (public MIT
// useRestoreTeam.ts): remember which agents had a live terminal and bring them
// back, resumed, on the next launch. Munder's renderer keeps that list in the
// roster's `restorable`; Council replaced the renderer, so the main process keeps
// it in <hive>/paramount-runtime.json instead.
//
// One runtime per floor: a lock file in the hive root names the owning process.
// While another live process holds it (a second Council, or a Munder build that
// honours it), this runtime neither restores nor records, so agents are never
// started twice. Spawn requests and inbox wake already run in main (index.ts).
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAgentModel } from './paramount-models';

export const RUNTIME_FILE = 'paramount-runtime.json';
export const LOCK_FILE = '.paramount-runtime.lock';
export const RESTORE_DELAY_MS = 2500; // Munder's AUTO_RESTORE_DELAY_MS
export const BEAT_MS = 5000;

export interface LiveAgent {
  id: string;
  name: string;
  provider: string;
  cwd: string;
  role?: string;
  isGod?: boolean;
}

export interface RuntimeDeps {
  /** Hive root, or null while the floor is not set up. */
  hiveRoot(): string | null;
  /** Agents that have a live terminal right now (registry joined with live PTYs). */
  liveAgents(): LiveAgent[];
  /** True when this agent already has a live terminal. */
  isLive(agentId: string): boolean;
  /** True when the registry marks this agent stopped by the human (archived). */
  isArchived(agentId: string): boolean;
  isDirectory(path: string): boolean;
  /** Start the agent again with its prior session resumed. */
  respawn(agent: LiveAgent): Promise<{ ok: boolean; error?: string }>;
  pid: number;
  /** True when that process is alive (kill(pid, 0)). */
  processAlive(pid: number): boolean;
  log(step: Record<string, unknown>): void;
  now(): number;
}

interface RuntimeRecord { schema: 'paramount-runtime-v1'; savedAt: string; agents: LiveAgent[] }

function readRecord(root: string): LiveAgent[] {
  try {
    const raw = JSON.parse(readFileSync(join(root, RUNTIME_FILE), 'utf8')) as Partial<RuntimeRecord>;
    if (raw.schema !== 'paramount-runtime-v1' || !Array.isArray(raw.agents)) return [];
    return raw.agents.filter((a): a is LiveAgent => !!a && typeof a.id === 'string' && typeof a.name === 'string'
      && typeof a.provider === 'string' && typeof a.cwd === 'string');
  } catch { return []; }
}

function writeRecord(root: string, agents: LiveAgent[], now: number): void {
  const file = join(root, RUNTIME_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const record: RuntimeRecord = { schema: 'paramount-runtime-v1', savedAt: new Date(now).toISOString(), agents };
  writeFileSync(tmp, JSON.stringify(record, null, 1) + '\n');
  renameSync(tmp, file);
}

/** Take or keep the floor's runtime lock. False while another live process holds it. */
export function acquireLock(root: string, deps: Pick<RuntimeDeps, 'pid' | 'processAlive' | 'now'>): boolean {
  const file = join(root, LOCK_FILE);
  try {
    const held = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown };
    if (typeof held.pid === 'number' && held.pid !== deps.pid && deps.processAlive(held.pid)) return false;
    if (held.pid === deps.pid) return true;
  } catch { /* no lock, or unreadable: take it */ }
  writeFileSync(file, JSON.stringify({ pid: deps.pid, since: new Date(deps.now()).toISOString() }) + '\n');
  return true;
}

export function releaseLock(root: string, pid: number): void {
  try {
    const held = JSON.parse(readFileSync(join(root, LOCK_FILE), 'utf8')) as { pid?: unknown };
    if (held.pid === pid) unlinkSync(join(root, LOCK_FILE));
  } catch { /* nothing to release */ }
}

/** Restore the agents recorded as live at the last quit. Skips agents already
 *  live, stopped by the human, or whose folder is gone; one failure never stops the rest. */
export async function restoreAgents(root: string, deps: RuntimeDeps): Promise<{ restored: string[]; skipped: string[]; failed: string[] }> {
  const result = { restored: [] as string[], skipped: [] as string[], failed: [] as string[] };
  for (const agent of readRecord(root)) {
    // The orchestrator's start and resume belong to the setup/orchestrator path (matrix row 8).
    if (agent.isGod) { result.skipped.push(agent.id); continue; }
    if (deps.isLive(agent.id) || deps.isArchived(agent.id)) { result.skipped.push(agent.id); continue; }
    if (!deps.isDirectory(agent.cwd)) {
      result.failed.push(agent.id);
      deps.log({ kind: 'paramount-runtime', step: 'restore', agentId: agent.id, outcome: 'failed', code: 'CWD_MISSING' });
      continue;
    }
    try {
      const res = await deps.respawn(agent);
      (res.ok ? result.restored : result.failed).push(agent.id);
      deps.log({ kind: 'paramount-runtime', step: 'restore', agentId: agent.id, outcome: res.ok ? 'ok' : 'failed', ...(res.ok ? {} : { code: 'SPAWN_FAILED', cause: (res.error ?? '').slice(0, 200) }) });
    } catch (error) {
      result.failed.push(agent.id);
      deps.log({ kind: 'paramount-runtime', step: 'restore', agentId: agent.id, outcome: 'failed', code: 'SPAWN_THREW', cause: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    }
  }
  return result;
}

export interface ParamountRuntime {
  /** One beat: take the lock, restore once per floor, then record the live set. */
  beat(): Promise<void>;
  /** Called on app quit: stop recording first, so terminals closing during
   *  shutdown are not mistaken for agents the human stopped. */
  quit(): void;
}

export function createParamountRuntime(deps: RuntimeDeps): ParamountRuntime {
  let restoredFor: string | null = null;
  let quitting = false;
  let busy = false;
  let lockedOut: string | null = null;
  // Munder keeps an agent restorable when its restore fails and says why; dropping
  // it would read as "nothing happened". Kept until it is live again or stopped.
  let unrestored: LiveAgent[] = [];
  return {
    async beat() {
      const root = deps.hiveRoot();
      if (!root || quitting || busy || !existsSync(root)) return;
      busy = true;
      try {
        if (!acquireLock(root, deps)) {
          if (lockedOut !== root) deps.log({ kind: 'paramount-runtime', step: 'lock', outcome: 'held-by-other', code: 'SECOND_RUNTIME' });
          lockedOut = root;
          return;
        }
        lockedOut = null;
        if (restoredFor !== root) {
          restoredFor = root;
          const recorded = readRecord(root);
          const r = await restoreAgents(root, deps);
          unrestored = recorded.filter((a) => r.failed.includes(a.id));
          deps.log({ kind: 'paramount-runtime', step: 'restore-summary', restored: r.restored.length, skipped: r.skipped.length, failed: r.failed.length });
        }
        if (!quitting) {
          const live = deps.liveAgents();
          unrestored = unrestored.filter((a) => !deps.isLive(a.id) && !deps.isArchived(a.id));
          writeRecord(root, [...live, ...unrestored.filter((a) => !live.some((l) => l.id === a.id))], deps.now());
        }
      } finally { busy = false; }
    },
    quit() {
      quitting = true;
      const root = deps.hiveRoot();
      if (root) releaseLock(root, deps.pid);
    }
  };
}

/** Arm the runtime: first beat after Munder's restore delay, then every BEAT_MS. */
export function startParamountRuntime(deps: RuntimeDeps, onQuit: (fn: () => void) => void): ParamountRuntime {
  const runtime = createParamountRuntime(deps);
  const tick = () => { runtime.beat().catch((e) => deps.log({ kind: 'paramount-runtime', step: 'beat', outcome: 'failed', cause: String(e).slice(0, 200) })); };
  const first = setTimeout(tick, RESTORE_DELAY_MS);
  const timer = setInterval(tick, BEAT_MS);
  onQuit(() => { clearTimeout(first); clearInterval(timer); runtime.quit(); });
  return runtime;
}

/** Wiring from index.ts primitives, so registration there is one line. */
export interface RuntimeHost {
  hive: { root(): string | null; registry(): { godId?: string | null; agents?: Record<string, { name?: string; provider?: string; cwd?: string; role?: string; isGod?: boolean; archived?: boolean }> } };
  ptyForAgent(agentId: string): string | undefined;
  config(): { defaultCommand?: string; autoMode?: boolean; defaultModel?: string; godProvider?: string; godModel?: string };
  /** Model choices in priority order (per-agent pick, configured default, role tier). */
  modelChoices(agentId: string, meta: { role?: string; isGod?: boolean }): Array<string | undefined>;
  /** Model ids the configured catalog offers for an engine. */
  offeredModels(provider: string): string[];
  buildLaunch(opts: { requestProvider: string; requestModel?: string; defaultCommand?: string; autoMode: boolean }): { bin: string; args: string[] };
  spawn(opts: { id: string; cwd: string; command: string; args: string[]; cols: number; rows: number; provider: string; isolate: false; resume: true;
    hive: { id: string; name: string; provider: string; cwd: string; role?: string } }): Promise<{ ok: boolean; error?: string }>;
  isDirectory(path: string): boolean;
  log(step: Record<string, unknown>): void;
  onQuit(fn: () => void): void;
}

export function registerParamountRuntime(host: RuntimeHost): ParamountRuntime {
  const agents = () => host.hive.registry().agents ?? {};
  const deps: RuntimeDeps = {
    hiveRoot: () => host.hive.root(),
    liveAgents: () => Object.entries(agents())
      .filter(([id, a]) => !a.archived && !!host.ptyForAgent(id) && typeof a.cwd === 'string')
      .map(([id, a]) => ({ id, name: a.name ?? id, provider: a.provider ?? 'claude', cwd: a.cwd as string,
        ...(a.role ? { role: a.role } : {}), ...(a.isGod || host.hive.registry().godId === id ? { isGod: true } : {}) })),
    isLive: (id) => !!host.ptyForAgent(id),
    isArchived: (id) => agents()[id]?.archived === true,
    isDirectory: host.isDirectory,
    respawn: (agent) => {
      const config = host.config();
      const launch = host.buildLaunch({ requestProvider: agent.provider, requestModel: resolveAgentModel(agent.provider, host.modelChoices(agent.id, { role: agent.role }), host.offeredModels),
        defaultCommand: config.defaultCommand, autoMode: config.autoMode !== false });
      return host.spawn({ id: agent.id, cwd: agent.cwd, command: launch.bin, args: launch.args, cols: 120, rows: 32, provider: agent.provider,
        isolate: false, resume: true, hive: { id: agent.id, name: agent.name, provider: agent.provider, cwd: agent.cwd, ...(agent.role ? { role: agent.role } : {}) } });
    },
    pid: process.pid,
    processAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
    log: host.log,
    now: () => Date.now()
  };
  return startParamountRuntime(deps, host.onQuit);
}
