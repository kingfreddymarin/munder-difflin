import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isSafeCommandName, windowsFallbackCandidates } from './shellEnv';

export type CommandDiscoveryState = 'checking' | 'ready' | 'missing' | 'unknown';
export type CommandDiscoveryResult = { path: string | null; state: CommandDiscoveryState };
export type SnapshotCommandCache = Pick<ReturnType<typeof createSnapshotCommandDiscovery>, 'get' | 'peek' | 'resolve'>;

type Probe = (command: string) => Promise<{ path: string | null; reliable: boolean }>;
type Entry = { result: CommandDiscoveryResult; checkedAt: number; pending?: Promise<void>; failures: number };

const FENCE = '__MD_SHELL_FENCE__';
const PROBE_TIMEOUT_MS = 3000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const READY_TTL_MS = 60_000;
const MISSING_TTL_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

/** Bounded asynchronous command discovery for snapshot consumers. It never blocks the caller. */
export function createSnapshotCommandDiscovery(opts: {
  probe: Probe;
  fallback: (command: string) => string | null;
  onChange?: (command: string, result: CommandDiscoveryResult) => void;
  now?: () => number;
}): {
  get(command: string): CommandDiscoveryResult;
  peek(command: string): CommandDiscoveryResult;
  resolve(command: string, force?: boolean): Promise<CommandDiscoveryResult>;
} {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const unknown: CommandDiscoveryResult = { path: null, state: 'unknown' };
  const snapshot = (entry?: Entry): CommandDiscoveryResult => entry?.pending
    ? { path: null, state: 'checking' }
    : entry?.result ?? unknown;
  const start = (command: string, force = false): CommandDiscoveryResult => {
    if (!isSafeCommandName(command)) return { path: null, state: 'missing' };
    const old = entries.get(command);
    if (old?.pending) return { path: null, state: 'checking' };
    const age = old ? now() - old.checkedAt : Infinity;
    if (!force && old && (old.result.state === 'unknown'
      ? age < Math.min(MAX_BACKOFF_MS, 1000 * (2 ** Math.max(0, old.failures - 1)))
      : age < (old.result.state === 'missing' ? MISSING_TTL_MS : READY_TTL_MS))) return old.result;
    const entry: Entry = old ?? { result: unknown, checkedAt: 0, failures: 0 };
    entry.result = { path: null, state: 'checking' };
    entry.pending = Promise.resolve().then(() => opts.probe(command)).then((probe) => {
      let path = probe.path;
      if (path && !existsSync(path)) path = null;
      if (!path) path = opts.fallback(command);
      if (path && !existsSync(path)) path = null;
      entry.result = path ? { path, state: 'ready' } : probe.reliable ? { path: null, state: 'missing' } : unknown;
      entry.failures = entry.result.state === 'unknown' ? entry.failures + 1 : 0;
      entry.checkedAt = now();
    }).catch(() => {
      entry.result = unknown;
      entry.failures++;
      entry.checkedAt = now();
    }).finally(() => {
      entry.pending = undefined;
      try { opts.onChange?.(command, entry.result); } catch { /* snapshot invalidation is best effort */ }
    });
    entries.set(command, entry);
    return { path: null, state: 'checking' };
  };
  return {
    get: (command) => start(command),
    peek: (command) => snapshot(entries.get(command)),
    async resolve(command, force = false) {
      start(command, force);
      const pending = entries.get(command)?.pending;
      if (pending) await pending;
      return snapshot(entries.get(command));
    }
  };
}

/** Shared projection used by the snapshot IPC handler. */
export function snapshotCommandTools(cache: SnapshotCommandCache, codexRequired: boolean) {
  return {
    claude: cache.get('claude'),
    codex: { ...cache.get('codex'), required: codexRequired },
    mempalace: cache.get('mempalace')
  };
}

/** The monitor callback is intentionally a nonblocking cache read/request. */
export function snapshotSignInPath(cache: SnapshotCommandCache, engine: string): string | null {
  return cache.get(engine).path;
}

export function installedSnapshotEngines(cache: SnapshotCommandCache): Array<'claude' | 'codex'> {
  return (['claude', 'codex'] as const).filter((engine) => cache.peek(engine).state === 'ready');
}

/** Run the same fenced login-shell `which` query without blocking the Electron main thread. */
export function probeLoginShellCommand(command: string, signal?: AbortSignal): Promise<{ path: string | null; reliable: boolean }> {
  if (!isSafeCommandName(command)) return Promise.resolve({ path: null, reliable: true });
  if (signal?.aborted) return Promise.resolve({ path: null, reliable: false });
  if (process.platform === 'win32') return probeWindowsCommand(command, signal);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.env.SHELL ?? '/bin/zsh', ['-ilc', `printf %s ${FENCE}; which ${command}; printf %s ${FENCE}`], {
        stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
      });
    } catch { resolve({ path: null, reliable: false }); return; }
    let output = '';
    let settled = false;
    const finish = (value: { path: string | null; reliable: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => { child.kill(); finish({ path: null, reliable: false }); };
    const timer = setTimeout(() => { child.kill(); finish({ path: null, reliable: false }); }, PROBE_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) { child.kill(); finish({ path: null, reliable: false }); }
    });
    child.once('error', () => finish({ path: null, reliable: false }));
    child.once('close', (code) => {
      const begin = output.indexOf(FENCE);
      const end = output.lastIndexOf(FENCE);
      if (code !== 0 || begin < 0 || end <= begin) { finish({ path: null, reliable: false }); return; }
      const candidates = output.slice(begin + FENCE.length, end).trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      finish({ path: candidates.at(-1) ?? null, reliable: true });
    });
  });
}

function probeWindowsCommand(command: string, signal?: AbortSignal): Promise<{ path: string | null; reliable: boolean }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn('where', [command], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
    catch { resolve({ path: null, reliable: false }); return; }
    let output = '';
    let settled = false;
    const finish = (value: { path: string | null; reliable: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => { child.kill(); finish({ path: null, reliable: false }); };
    const timer = setTimeout(() => { child.kill(); finish({ path: null, reliable: false }); }, PROBE_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) { child.kill(); finish({ path: null, reliable: false }); }
    });
    child.once('error', () => finish({ path: null, reliable: false }));
    child.once('close', (code) => {
      if (code !== 0 && code !== 1) { finish({ path: null, reliable: false }); return; }
      const pathExts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((part) => part.trim().toUpperCase()).filter(Boolean);
      const match = output.trim().split(/\r?\n/).map((line) => line.trim()).find((path) => {
        const dot = path.lastIndexOf('.');
        const sep = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
        return dot > sep && pathExts.includes(path.slice(dot).toUpperCase()) && existsSync(path);
      });
      finish({ path: match ?? null, reliable: code === 0 || code === 1 });
    });
  });
}

export function fallbackCommandPath(command: string): string | null {
  if (!isSafeCommandName(command)) return null;
  if (process.platform === 'win32') return windowsFallbackCandidates(command).find((candidate) => existsSync(candidate)) ?? null;
  const candidates = [
    `/opt/homebrew/bin/${command}`, `/usr/local/bin/${command}`,
    `${process.env.HOME ?? ''}/.local/bin/${command}`,
    `${process.env.HOME ?? ''}/.claude/local/${command}`,
    `${process.env.HOME ?? ''}/.volta/bin/${command}`,
    ...(command === 'opencode' && process.env.HOME ? [`${process.env.HOME}/.opencode/bin/opencode`] : [])
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
