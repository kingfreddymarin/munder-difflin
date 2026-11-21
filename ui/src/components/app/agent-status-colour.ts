// Priority: red (constrained/crashed) > purple (cap reached) > blue-blink (compacting) > yellow (working) > grey (idle)
type AgentStatusColourInput = { status: string; tokensUsed: number; tokensCap: number };

export type AgentColour = { dot: string; blink: boolean };

export function agentStatusColour(agent: AgentStatusColourInput): AgentColour {
  if (agent.status === 'constrained' || agent.status === 'crashed') return { dot: 'bg-rose-500', blink: false };
  if (agent.tokensCap > 0 && agent.tokensUsed >= agent.tokensCap) return { dot: 'bg-violet-400', blink: false };
  if (agent.status === 'compacting') return { dot: 'bg-blue-400', blink: true };
  if (agent.status === 'working' || agent.status === 'waiting') return { dot: 'bg-yellow-400', blink: false };
  return { dot: 'bg-zinc-500/50', blink: false };
}
