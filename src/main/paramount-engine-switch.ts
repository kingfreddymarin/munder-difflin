import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface EngineSwitchResult { ok: boolean; error?: string; rollbackError?: string }

export interface AgentEngineSessionRecord { provider: string; at: string; sessionId?: string; model?: string; launcherId?: string }
const HISTORY_FILE = 'paramount-agent-engine-history.json';
const lifecycleLocks = new Set<string>();

/** One lock shared by switch and restart handlers. A rejected contender must
 * never take a snapshot or stop the process owned by the operation in flight. */
export async function withAgentLifecycleLock<T>(agentId: string, operation: () => Promise<T>): Promise<T | undefined> {
  if (lifecycleLocks.has(agentId)) return undefined;
  lifecycleLocks.add(agentId);
  try { return await operation(); }
  finally { lifecycleLocks.delete(agentId); }
}

/** Keep pointers to retired provider sessions out of the registry's single active-session slot. */
export function preserveEngineSession(root: string, agentId: string, record: AgentEngineSessionRecord): void {
  const path = join(root, HISTORY_FILE);
  let parsed: unknown = { version: 1, agents: {} };
  if (existsSync(path)) parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1 || !(parsed as { agents?: unknown }).agents || typeof (parsed as { agents?: unknown }).agents !== 'object' || Array.isArray((parsed as { agents?: unknown }).agents)) throw new Error('The saved provider-session history is unreadable; the switch was not started.');
  const agents = (parsed as { agents: Record<string, AgentEngineSessionRecord[]> }).agents;
  const rows = Array.isArray(agents[agentId]) ? agents[agentId] : [];
  agents[agentId] = [...rows, record].slice(-20);
  const temporary = `${path}.${randomUUID()}.tmp`;
  mkdirSync(root, { recursive: true });
  writeFileSync(temporary, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

/** Serializes the destructive part of a provider switch: the old process is gone
 * before a target starts, and any failed target/persist step gets one rollback. */
export async function switchEngineTransaction(deps: {
  stopCurrent(): Promise<{ ok: boolean; error?: string }>;
  startTarget(): Promise<{ ok: boolean; error?: string }>;
  targetViable?(): Promise<{ ok: boolean; error?: string }>;
  persistTarget(): Promise<void>;
  stopTarget(): Promise<{ ok: boolean; error?: string }>;
  rollback(): Promise<{ ok: boolean; error?: string }>;
}): Promise<EngineSwitchResult> {
  const stopped = await deps.stopCurrent();
  if (!stopped.ok) return { ok: false, error: stopped.error ?? 'The current session could not be stopped.' };
  let targetStarted = false;
  let failure: string | undefined;
  try {
    const started = await deps.startTarget();
    targetStarted = started.ok;
    if (!started.ok) failure = started.error ?? 'The target provider session could not start.';
    else {
      const viable = await deps.targetViable?.();
      if (viable && !viable.ok) failure = viable.error ?? 'The target provider exited during startup.';
      else await deps.persistTarget();
    }
  } catch (error) { failure = error instanceof Error ? error.message : 'Could not save the provider selection.'; }
  if (!failure) return { ok: true };
  if (targetStarted) {
    const stoppedTarget = await deps.stopTarget();
    if (!stoppedTarget.ok) return { ok: false, error: failure, rollbackError: stoppedTarget.error ?? 'The failed target process could not be stopped; old session was not started to avoid a duplicate.' };
  }
  const rollback = await deps.rollback();
  return { ok: false, error: failure, ...(rollback.ok ? {} : { rollbackError: rollback.error ?? 'The previous provider could not be restored.' }) };
}
