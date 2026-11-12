// An orchestrator that dies while starting is a failed start, not a closed terminal.
//
// A normal PTY exit archives the agent (only live terminals are active). For the orchestrator
// Council just started that is wrong: when the CLI exits abnormally within the start window
// (for example `--resume` with no such session, exit 42 "No previous sessions found"), the
// registry entry must stay as it was and the failure must be shown. Incident 2026-11-12: a
// failed resume archived the shared god entry silently.
export const ORCHESTRATOR_START_WINDOW_MS = 60_000;

export interface OrchestratorStartFailure {
  agentId: string;
  provider: string;
  resumed: boolean;
  exitCode?: number;
  signal?: number;
  message: string;
  at: string;
}

interface Start { provider: string; resumed: boolean; startedAt: number }

export function createOrchestratorStartWatch(now: () => number = Date.now, windowMs = ORCHESTRATOR_START_WINDOW_MS) {
  const starts = new Map<string, Start>();
  let failure: OrchestratorStartFailure | null = null;
  return {
    /** Council started this orchestrator; a later successful start clears an earlier failure. */
    started(agentId: string, provider: string, resumed: boolean): void {
      starts.set(agentId, { provider, resumed, startedAt: now() });
      failure = null;
    },
    /** Its PTY exited. Returns the failure when this was a failed start (keep the entry), else null. */
    exited(agentId: string, exitCode: number | undefined, signal: number | undefined): OrchestratorStartFailure | null {
      const start = starts.get(agentId);
      starts.delete(agentId);
      if (!start || now() - start.startedAt > windowMs) return null;
      const abnormal = (typeof signal === 'number' && signal !== 0) || (typeof exitCode === 'number' && exitCode !== 0);
      if (!abnormal) return null;
      const how = typeof exitCode === 'number' && exitCode !== 0 ? `exit code ${exitCode}` : `signal ${signal}`;
      failure = {
        agentId, provider: start.provider, resumed: start.resumed,
        ...(typeof exitCode === 'number' ? { exitCode } : {}), ...(typeof signal === 'number' ? { signal } : {}),
        message: start.resumed
          ? `The orchestrator could not resume its session on ${start.provider} (${how}). Its registry entry was left unchanged; open its terminal output or the floor's crashes folder, then start it again from Team.`
          : `The orchestrator stopped while starting on ${start.provider} (${how}). Its registry entry was left unchanged; start it again from Team.`,
        at: new Date(now()).toISOString(),
      };
      return failure;
    },
    /** The last failed start, for the snapshot. */
    failure(): OrchestratorStartFailure | null { return failure; },
    dismiss(): void { failure = null; },
  };
}
