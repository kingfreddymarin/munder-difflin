import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerPreset } from '../shared/agentProvider';
import type { SideAgentModelList, SideAgentProvider } from '../shared/sideAgent';

/** Longest a provider's model listing may take before we give up and keep its default. */
export const SIDE_AGENT_MODEL_TIMEOUT_MS = 20_000;
const MAX_MODELS = 500;
const MAX_OUTPUT = 1024 * 1024;
// A model id the provider printed; never starts with '-', so it can't be read as a flag.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/#[\]+-]{0,199}$/;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export const isSideAgentModelId = (value: unknown): value is string =>
  typeof value === 'string' && MODEL_ID.test(value);

/** `opencode models` prints one `provider/model` id per line. Anything else (banners,
 *  warnings, log lines) is ignored; ids keep the CLI's order and are deduplicated. */
export function parseOpenCodeModels(stdout: string): string[] {
  const models = new Set<string>();
  for (const raw of stdout.replace(ANSI, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.includes('/') || !MODEL_ID.test(line)) continue;
    models.add(line);
    if (models.size === MAX_MODELS) break;
  }
  return [...models];
}

type ModelSource = { args: string[]; parse: (stdout: string) => string[] };

/** How each side-agent provider lists its models. `null` = the CLI has no listing
 *  command, so the side agent keeps that provider's own default model.
 *  - OpenCode 2: `opencode models --standalone` (private server, no background service).
 *  - Claude Code: no `models` subcommand; `--model` takes an alias or full name only. */
export const SIDE_AGENT_MODEL_SOURCES: Record<SideAgentProvider, ModelSource | null> = {
  opencode: { args: ['models', '--standalone'], parse: parseOpenCodeModels },
  claude: null,
};

export type RunModelList = (
  file: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeout: number }
) => Promise<{ stdout: string }>;

const runModelList: RunModelList = (file, args, { cwd, env, timeout }) => new Promise((resolve, reject) => {
  execFile(file, args, {
    cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: 'utf8',
    // Windows npm shims (.cmd/.bat) only run through cmd.exe; the args are fixed literals.
    shell: process.platform === 'win32' && !/\.(?:exe|com)$/i.test(file),
  }, (error, stdout) => error ? reject(error) : resolve({ stdout }));
});

export type SideAgentModelDeps = {
  /** Absolute path of the provider CLI, or null when it is not installed. */
  commandPath: (command: string) => string | null;
  /** The same isolated profile the side agent launches with, so the listing shows
   *  what the side session can actually reach. Created inside `scratch`, which is removed afterwards. */
  isolatedProfile: (provider: SideAgentProvider, scratch: string) => { cwd: string; env: Record<string, string> };
  run?: RunModelList;
  timeoutMs?: number;
  log?: (message: string, error?: unknown) => void;
};

/** Ask one provider CLI for its models. Never throws: every failure is a list with
 *  no models, which leaves the provider on its own default. */
export async function discoverSideAgentModels(provider: SideAgentProvider, deps: SideAgentModelDeps): Promise<SideAgentModelList> {
  const source = SIDE_AGENT_MODEL_SOURCES[provider];
  if (!source) return { provider, status: 'unsupported', models: [] };
  const { label, defaultCommand } = providerPreset(provider);
  const file = deps.commandPath(defaultCommand);
  if (!file) return { provider, status: 'unavailable', models: [], error: `${label} is not installed.` };
  let scratch: string | undefined;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'paramount-side-models-'));
    const { cwd, env } = deps.isolatedProfile(provider, scratch);
    const { stdout } = await (deps.run ?? runModelList)(file, source.args, {
      cwd, env, timeout: deps.timeoutMs ?? SIDE_AGENT_MODEL_TIMEOUT_MS,
    });
    const models = source.parse(String(stdout ?? ''));
    if (!models.length) return { provider, status: 'error', models: [], error: `${label} listed no models.` };
    return { provider, status: 'ok', models };
  } catch (error) {
    deps.log?.(`[side-agent] ${label} model listing failed`, error);
    const timedOut = (error as { killed?: boolean; signal?: string } | null)?.killed === true;
    return { provider, status: 'error', models: [], error: timedOut ? `${label} took too long to list models.` : `${label} could not list models.` };
  } finally {
    if (scratch) {
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
    }
  }
}

/** Per-provider cache of model listings for this app session. Discovery is lazy (first
 *  request) and asynchronous, so it never blocks app startup or the main thread; a failed
 *  listing is not cached, so reopening the side agent retries it. */
export function createSideAgentModelCatalog(deps: SideAgentModelDeps) {
  const pending = new Map<SideAgentProvider, Promise<SideAgentModelList>>();
  const settled = new Map<SideAgentProvider, SideAgentModelList>();
  function list(provider: SideAgentProvider, refresh = false): Promise<SideAgentModelList> {
    const inflight = pending.get(provider);
    if (inflight) return inflight;
    const known = settled.get(provider);
    if (known && !refresh) return Promise.resolve(known);
    const next = discoverSideAgentModels(provider, deps).then((result) => {
      pending.delete(provider);
      if (result.status === 'ok' || result.status === 'unsupported') settled.set(provider, result);
      else settled.delete(provider);
      return result;
    });
    pending.set(provider, next);
    return next;
  }
  return {
    list,
    /** The configured model, only when the provider itself listed it; otherwise undefined (provider default). */
    resolve(provider: SideAgentProvider, configured: unknown): string | undefined {
      if (!isSideAgentModelId(configured)) return undefined;
      return settled.get(provider)?.models.includes(configured) ? configured : undefined;
    },
  };
}
