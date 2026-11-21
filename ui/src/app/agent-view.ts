// Talking to an agent is its live terminal, as in Munder: every place that selects an agent
// (Home, Team, the sidebar, the orchestrator button) opens this view. The profile and the
// chat page stay reachable, but neither is the default.
import type { Agent, TerminalSession } from '../data/types';

export const AGENT_VIEW = 'terminal' as const;

/** Route params for an agent's terminal. */
export function agentViewParams(agentId: string): { a: string } {
  return { a: agentId };
}

/** The orchestrator, which Council shows first. */
export function orchestratorOf(agents: Agent[]): Agent | undefined {
  return agents.find((a) => a.role === 'paramount');
}

/** Agents for the main sidebar: the orchestrator first, then floor order,
 *  each marked live when it has a terminal. */
export function terminalRoster(agents: Agent[], terminals: TerminalSession[]): Array<{ agent: Agent; live: boolean }> {
  const live = new Set(terminals.map((t) => t.agentId));
  const lead = orchestratorOf(agents);
  const ordered = lead ? [lead, ...agents.filter((a) => a.id !== lead.id)] : agents;
  return ordered.map((agent) => ({ agent, live: live.has(agent.id) }));
}

/** Which agent the terminal page shows: the one asked for, else the orchestrator if it is
 *  live, else the first live terminal. */
export function selectedAgentId(requested: string | null, agents: Agent[], terminals: TerminalSession[]): string | undefined {
  if (requested) return requested;
  const lead = orchestratorOf(agents);
  if (lead && terminals.some((t) => t.agentId === lead.id)) return lead.id;
  return terminals[0]?.agentId;
}
