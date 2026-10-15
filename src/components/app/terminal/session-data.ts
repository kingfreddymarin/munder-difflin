// Pure selectors behind the terminal side panel (lane e-terminal). No React, so tests import them directly.
import type { ParamountArtifact } from '../../../data/paramount-api';
import type { Message } from '../../../data/types';

const byNewest = (a: { at: string }, b: { at: string }) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0);

/** Open asks from this agent, newest first (Munder's ASK ME order). */
export function openAsks(messages: Message[], agentId: string): Message[] {
  return messages.filter((m) => m.from === agentId && !m.read && !m.answer && (m.kind === 'question' || m.kind === 'approval')).sort(byNewest);
}

/** Messages one agent sent to another agent, either direction, deduped (the hive keeps an inbox and an outbox copy), newest first.
 *  With no `agentId`, the whole floor's agent-to-agent traffic. */
export function agentTalk(messages: Message[], agentIds: ReadonlySet<string>, agentId?: string): Message[] {
  const seen = new Set<string>();
  return messages.filter((m) => {
    if (!m.to || m.from === 'you' || !agentIds.has(m.from) || !agentIds.has(m.to)) return false;
    if (agentId && m.from !== agentId && m.to !== agentId) return false;
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  }).sort(byNewest);
}

export type ArtifactGroup = 'changed' | 'commits' | 'mentioned' | 'links';
export const ARTIFACT_GROUPS: { id: ArtifactGroup; label: string; kinds: ParamountArtifact['kind'][] }[] = [
  { id: 'changed', label: 'Uncommitted changes', kinds: ['changed'] },
  { id: 'commits', label: 'Recent commits', kinds: ['commit', 'committed'] },
  { id: 'mentioned', label: 'Paths it mentioned', kinds: ['mentioned'] },
  { id: 'links', label: 'Links (PRs, runs, work items)', kinds: ['link'] },
];

/** Groups artifacts for display; empty groups are dropped. Order within a group is the core's. */
export function groupArtifacts(artifacts: ParamountArtifact[]): { id: ArtifactGroup; label: string; items: ParamountArtifact[] }[] {
  return ARTIFACT_GROUPS.map((g) => ({ id: g.id, label: g.label, items: artifacts.filter((a) => g.kinds.includes(a.kind)) })).filter((g) => g.items.length > 0);
}
