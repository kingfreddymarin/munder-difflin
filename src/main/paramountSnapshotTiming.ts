/** Payload-free, bounded diagnostics for the Paramount snapshot's top-level stages. */
export type SnapshotStage =
  | 'config' | 'floorSetup' | 'hookHealth' | 'orchestratorFailure' | 'registry'
  | 'tasks' | 'messages' | 'organization' | 'archivedAgents' | 'log' | 'roster'
  | 'activity' | 'snapshotConfig' | 'missions' | 'ptys' | 'preferences' | 'integrations'
  | 'skidProbe' | 'enginePaths' | 'signIn';

export interface SnapshotStageTiming {
  now(): number;
  log(event: Record<string, unknown>): void;
  thresholdMs?: number;
  maxEventsPerWindow?: number;
  windowMs?: number;
}

export function createSnapshotStageTimer(deps: SnapshotStageTiming) {
  const thresholdMs = deps.thresholdMs ?? 100;
  const maxEventsPerWindow = deps.maxEventsPerWindow ?? 12;
  const windowMs = deps.windowMs ?? 60_000;
  let windowStart = deps.now();
  let emitted = 0;

  const round = (ms: number) => Math.round(ms * 10) / 10;
  function report(cid: string, stage: SnapshotStage, syncMs: number, waitMs: number, outcome: 'ok' | 'error'): void {
    if (syncMs < thresholdMs && waitMs < thresholdMs) return;
    const now = deps.now();
    if (now - windowStart >= windowMs || now < windowStart) {
      windowStart = now;
      emitted = 0;
    }
    if (emitted >= maxEventsPerWindow) return;
    emitted++;
    // Logging is best-effort: diagnostics cannot alter IPC success or replace its original error.
    try {
      deps.log({
        kind: 'paramount-snapshot-stage', cid, stage,
        syncMs: round(syncMs), waitMs: round(waitMs), totalMs: round(syncMs + waitMs), outcome
      });
    } catch { /* preserve application result when stderr/log sink is unavailable */ }
  }

  return {
    measure<T>(cid: string, stage: SnapshotStage, work: () => T): T {
      const started = deps.now();
      let result: T;
      try { result = work(); }
      catch (error) {
        report(cid, stage, deps.now() - started, 0, 'error');
        throw error;
      }
      const invoked = deps.now();
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
        return Promise.resolve(result).then(
          (value) => { report(cid, stage, invoked - started, deps.now() - invoked, 'ok'); return value; },
          (error) => { report(cid, stage, invoked - started, deps.now() - invoked, 'error'); throw error; }
        ) as T;
      }
      report(cid, stage, invoked - started, 0, 'ok');
      return result;
    }
  };
}
