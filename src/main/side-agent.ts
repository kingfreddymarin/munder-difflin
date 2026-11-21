import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerPreset } from '../shared/agentProvider';
import type { SideAgentContext, SideAgentProvider, SideAgentResult, SideAgentState } from '../shared/sideAgent';
import type { PtyManager, SpawnOptions } from './pty';
import type { WebContents } from 'electron';

const CARD_LIMIT = 12;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function sideAgentCards(ledger: unknown): SideAgentContext['cards'] {
  const rows = (ledger as { tasks?: unknown } | null)?.tasks;
  const cards = new Map<string, SideAgentContext['cards'][number]>();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (cards.size === CARD_LIMIT) break;
      if (typeof row?.id !== 'string' || !SAFE_ID.test(row.id)) continue;
      if (row.status === 'doing' || row.status === 'blocked') {
        cards.set(row.id, { id: row.id, status: row.status });
      }
    }
  }
  return [...cards.values()];
}

function sideAgentPrompt(context: SideAgentContext): string {
  const cards = context.cards.map(({ id, status }) => `${id} ${status}`).join(', ') || 'none shared';
  return [
    'You are a temporary question assistant outside the Paramount floor.',
    `Source is the active floor orchestrator ID ${SAFE_ID.test(context.orchestratorId) ? context.orchestratorId : 'available in Paramount'}.`,
    `Snapshot captured at ${context.capturedAt}. Active Board card references: ${cards}.`,
    'Answer using this snapshot and what the user shares. For more floor context or any action, refer the user back to the source orchestrator in Paramount.'
  ].join(' ');
}

// Build a provider profile with no floor configuration and no inherited credentials.
function sideAgentLaunch(provider: SideAgentProvider, scratch: string, context: SideAgentContext): Pick<SpawnOptions, 'args' | 'env' | 'inheritEnv' | 'cwd'> {
  const cwd = join(scratch, 'workspace');
  const config = join(scratch, 'config');
  const data = join(scratch, 'data');
  const cache = join(scratch, 'cache');
  const state = join(scratch, 'state');
  const temp = join(scratch, 'tmp');
  for (const dir of [cwd, config, data, cache, state, temp]) mkdirSync(dir);
  const env = {
    HOME: scratch,
    USERPROFILE: scratch,
    APPDATA: config,
    LOCALAPPDATA: data,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state
  };
  const prompt = sideAgentPrompt(context);
  if (provider === 'opencode') {
    const profile = join(config, 'opencode');
    mkdirSync(profile);
    writeFileSync(join(profile, 'opencode.json'), JSON.stringify({
      update: 'disable',
      policies: ['tool.use', 'mcp.use', 'skill.use', 'plugin.use', 'websearch.use'].map(
        (action) => ({ action, resource: '*', effect: 'deny' }))
    }), { mode: 0o600 });
    return { cwd, env, inheritEnv: false, args: ['--standalone', '--prompt', prompt] };
  }
  return {
    cwd,
    env: {
      ...env,
      CLAUDE_CONFIG_DIR: join(config, 'claude'),
      DISABLE_AUTOUPDATER: '1'
    },
    inheritEnv: false,
    args: ['--restricted', '--setting-sources=', '--strict-mcp-config', '--disable-slash-commands',
      '--tools=', '--append-system-prompt', prompt]
  };
}

export const isSideAgentPty = (id: string): boolean => id.startsWith('side-agent:');

type Entry = {
  state: Exclude<SideAgentState, { status: 'idle' }>;
  scratch?: string;
};

export function createSideAgents(
  pty: Pick<PtyManager, 'isCommandAvailable' | 'spawn' | 'kill' | 'killAll' | 'killByOwner' | 'setExitHandler'>,
  readContext: () => SideAgentContext | null,
  publish: (owner: WebContents, disposedPtyId?: string) => void
) {
  const entries = new Map<WebContents, Entry>();
  const liveOwners = new Map<string, WebContents>();
  const clean = (scratch?: string) => {
    if (!scratch) return;
    try { rmSync(scratch, { recursive: true, force: true }); }
    catch (error) { console.error('[side-agent] temporary profile cleanup failed:', error); }
  };
  const failure = (error: string): SideAgentResult => ({ ok: false, error });

  function finish(owner: WebContents, status: 'stopped' | 'exited', exitCode?: number, signal?: number) {
    const entry = entries.get(owner);
    if (entry?.state.status !== 'running') return;
    const { ptyId, provider, context } = entry.state;
    liveOwners.delete(ptyId);
    clean(entry.scratch);
    if (owner.isDestroyed()) entries.delete(owner);
    else entries.set(owner, { state: { provider, context, status, exitCode, signal } });
    publish(owner, ptyId);
  }

  function stop(owner: WebContents): SideAgentResult {
    const state = entries.get(owner)?.state;
    if (state?.status !== 'running') return { ok: true };
    const result = pty.kill(state.ptyId);
    if (!result.ok) return failure('Could not stop the side agent. Try Stop again.');
    finish(owner, 'stopped');
    return { ok: true };
  }

  function launch(owner: WebContents, provider: unknown, restart: boolean): SideAgentResult {
    if (provider !== 'opencode' && provider !== 'claude') return failure('Choose OpenCode or Claude Code.');
    if (entries.get(owner)?.state.status === 'running' && !restart) {
      return failure('A side agent is already running in this window.');
    }
    const { label, defaultCommand } = providerPreset(provider);
    let scratch: string | undefined;
    try {
      const context = readContext();
      if (!context) return failure('Open a floor and start its orchestrator before launching a side agent.');
      if (!pty.isCommandAvailable(defaultCommand)) {
        return failure(`Install ${provider === 'opencode' ? 'OpenCode 2' : label} before starting this side agent.`);
      }
      const stopped = stop(owner);
      if (!stopped.ok) return stopped;
      scratch = mkdtempSync(join(tmpdir(), 'paramount-side-agent-'));
      const ptyId = `side-agent:${randomUUID()}`;
      const result = pty.spawn({ id: ptyId, command: defaultCommand, ...sideAgentLaunch(provider, scratch, context) }, owner);
      if (!result.ok) {
        clean(scratch);
        return failure(`Could not start ${label}. Check that its command-line app is installed and can run.`);
      }
      liveOwners.set(ptyId, owner);
      entries.set(owner, { state: { status: 'running', ptyId, provider, context }, scratch });
      publish(owner);
      return { ok: true };
    } catch {
      clean(scratch);
      return failure(`Could not prepare the ${label} side agent. Check the temporary directory and try again.`);
    }
  }

  pty.setExitHandler((id, code, info) => {
    const owner = liveOwners.get(id);
    if (owner) finish(owner, 'exited', code, info?.signal);
  });

  return {
    state: (owner: WebContents): SideAgentState => entries.get(owner)?.state ?? { status: 'idle' },
    owns: (owner: WebContents, id: string): boolean => liveOwners.get(id) === owner,
    launch,
    stop,
    close(owner: WebContents) {
      if (stop(owner).ok) entries.delete(owner);
      else pty.killByOwner(owner);
    },
    closeAll() {
      pty.killAll();
      for (const entry of entries.values()) clean(entry.scratch);
      entries.clear();
      liveOwners.clear();
    }
  };
}
