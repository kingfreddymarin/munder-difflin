import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type SwitchPhase = 'stop-current' | 'start-target' | 'check-viability' | 'persist-target' | 'stop-target' | 'rollback';
export interface SwitchPhaseEvent { cid: string; phase: SwitchPhase; outcome: 'start' | 'ok' | 'fail' }

/** One attempt identity spans preflight and all destructive transaction phases. */
export function createSwitchTrace(sink: (event: Record<string, unknown>) => void, identity: { provider: string; accountId?: string }) {
  const cid = randomUUID();
  let scope: 'agent' | 'orchestrator' | 'unknown' = 'unknown';
  const emit = (event: { phase: string; outcome: string; reason?: string }) => {
    try { sink({ kind: 'paramount-account-switch', cid,
      provider: ['claude', 'codex', 'gemini', 'local'].includes(identity.provider) ? identity.provider : 'other',
      accountId: identity.accountId && /^(acct_[a-f0-9]{24}|dc|dcm|dcx|dcxm)$/.test(identity.accountId) ? identity.accountId : 'provider-default',
      scope, phase: event.phase, outcome: event.outcome, ...(event.reason ? { reason: event.reason } : {}) }); } catch { /* diagnostic failure never changes lifecycle results */ }
  };
  emit({ phase: 'preflight', outcome: 'start' });
  return { cid, emit, setScope: (value: 'agent' | 'orchestrator') => { scope = value; },
    refuse: <T>(reason: string, result: T): T => { emit({ phase: 'preflight', outcome: 'fail', reason }); return result; } };
}

export interface EngineSwitchResult { ok: boolean; error?: string; rollbackError?: string }

export interface AgentEngineSessionRecord {
  provider: string; at: string; sessionId?: string; model?: string; launcherId?: string;
  /** Account identity at retirement; old records may predate fingerprint tracking. */
  launcherFingerprint?: string;
  isGod?: boolean;
}
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
  cid?: string;
  observe?(event: SwitchPhaseEvent): void;
  stopCurrent(): Promise<{ ok: boolean; error?: string }>;
  startTarget(): Promise<{ ok: boolean; error?: string }>;
  targetViable?(): Promise<{ ok: boolean; error?: string }>;
  persistTarget(): Promise<void>;
  stopTarget(): Promise<{ ok: boolean; error?: string }>;
  rollback(): Promise<{ ok: boolean; error?: string }>;
}): Promise<EngineSwitchResult> {
  const cid = deps.cid && /^[a-f0-9-]{36}$/.test(deps.cid) ? deps.cid : randomUUID();
  const emit = (phase: SwitchPhase, outcome: SwitchPhaseEvent['outcome']) => {
    // Diagnostics are best effort and never receive provider output or errors.
    try { deps.observe?.({ cid, phase, outcome }); } catch { /* logging must not affect recovery */ }
  };
  const step = async <T>(phase: SwitchPhase, run: () => Promise<T>): Promise<T> => {
    emit(phase, 'start');
    try {
      const result = await run();
      emit(phase, result && typeof result === 'object' && 'ok' in result && result.ok === false ? 'fail' : 'ok');
      return result;
    } catch (error) { emit(phase, 'fail'); throw error; }
  };
  const stopped = await step('stop-current', () => deps.stopCurrent());
  if (!stopped.ok) return { ok: false, error: stopped.error ?? 'The current session could not be stopped.' };
  let targetAttempted = false;
  let failure: string | undefined;
  try {
    targetAttempted = true;
    const started = await step('start-target', () => deps.startTarget());
    if (!started.ok) failure = started.error ?? 'The target provider session could not start.';
    else {
      const viable = await step('check-viability', async () => deps.targetViable?.());
      if (viable && !viable.ok) failure = viable.error ?? 'The target provider exited during startup.';
      else await step('persist-target', () => deps.persistTarget());
    }
  } catch (error) { failure = error instanceof Error ? error.message : 'Could not save the provider selection.'; }
  if (!failure) return { ok: true };
  if (targetAttempted) {
    let stoppedTarget: { ok: boolean; error?: string };
    try { stoppedTarget = await step('stop-target', () => deps.stopTarget()); }
    catch (error) {
      // The target may still be alive. Do not start the old process when cleanup is uncertain.
      return { ok: false, error: failure, rollbackError: error instanceof Error ? error.message : 'The failed target process could not be stopped; old session was not started to avoid a duplicate.' };
    }
    if (!stoppedTarget.ok) return { ok: false, error: failure, rollbackError: stoppedTarget.error ?? 'The failed target process could not be stopped; old session was not started to avoid a duplicate.' };
  }
  try {
    const rollback = await step('rollback', () => deps.rollback());
    return { ok: false, error: failure, ...(rollback.ok ? {} : { rollbackError: rollback.error ?? 'The previous provider could not be restored.' }) };
  } catch (error) {
    return { ok: false, error: failure, rollbackError: error instanceof Error ? error.message : 'The previous provider could not be restored.' };
  }
}
