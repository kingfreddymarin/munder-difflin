// Priority: red (provider limit) > purple (cap reached) > blue-blink (compacting) > yellow (working) > grey (idle)
// Colours reference theme tokens from ui/src/index.css — no raw hex values here.
type AgentStatusColourInput = { status: string; tokensUsed: number; tokensCap: number; providerLimited?: boolean };

export type AgentColour = { dot: string; blink: boolean };

export function agentStatusColour(agent: AgentStatusColourInput): AgentColour {
  if (agent.providerLimited) return { dot: 'bg-status-limited', blink: false };
  if (agent.tokensCap > 0 && agent.tokensUsed >= agent.tokensCap) return { dot: 'bg-status-capped', blink: false };
  if (agent.status === 'compacting') return { dot: 'bg-status-compacting', blink: true };
  if (agent.status === 'working' || agent.status === 'waiting') return { dot: 'bg-status-working', blink: false };
  return { dot: 'bg-status-idle', blink: false };
}
