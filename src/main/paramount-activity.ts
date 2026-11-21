/** Live per-agent activity for Paramount's Team graph and roster (owner use of 52051eda: every agent
 *  showed idle, because the registry's `status` is not kept up to date while agents run).
 *
 *  Busy follows Munder's floor rule: a terminal that printed within the idle window is working, a
 *  quiet one is idle (renderer QUIESCE_IDLE_MS, main WORKER_WAKE_IDLE_MS). An agent with no live
 *  terminal is never busy. Tokens, the last tool and the context fill are the figures fleet.json
 *  publishes, read from the same telemetry. */

export interface AgentActivity {
  busy: boolean;
  /** The last tool the agent ran, or '' when none is known. */
  doing: string;
  tokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  breaker: string | null;
  /** Context window fill in percent, or null when the engine does not report it. */
  contextPct: number | null;
  /** True when the agent's terminal output contained a provider usage-limit message
   *  (e.g. Claude Code's "Usage limit reached"). Distinct from the circuit breaker. */
  providerLimited: boolean;
}

export interface ActivityFacts {
  /** The terminal's last output time (epoch ms), undefined when the agent has no live terminal. */
  lastOutputAt?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  breaker?: string;
  lastTool?: string | null;
  context?: { tokens: number; limit: number } | null;
  /** Whether the agent's terminal tail contains a provider usage-limit message. */
  providerLimited?: boolean;
}

export function agentActivity(facts: Record<string, ActivityFacts>, now: number, idleMs: number): Record<string, AgentActivity> {
  const out: Record<string, AgentActivity> = {};
  for (const [id, f] of Object.entries(facts)) {
    const last = f.lastOutputAt ?? 0;
    out[id] = {
      busy: last > 0 && now - last < idleMs,
      doing: f.lastTool ?? '',
      tokens: f.tokens ?? null,
      inputTokens: f.inputTokens ?? null,
      outputTokens: f.outputTokens ?? null,
      cacheReadTokens: f.cacheReadTokens ?? null,
      cacheCreationTokens: f.cacheCreationTokens ?? null,
      costUsd: f.costUsd ?? null,
      breaker: f.breaker ?? null,
      contextPct: f.context && f.context.limit > 0 ? Math.round((f.context.tokens / f.context.limit) * 100) : null,
      providerLimited: f.providerLimited ?? false,
    };
  }
  return out;
}
