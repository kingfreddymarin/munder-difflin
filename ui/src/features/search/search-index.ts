/**
 * Pure floor-search index — no React, no @/ aliases, compiles standalone.
 *
 * buildSearchIndex() merges static view/setting destinations with live floor
 * data (agents, cards, automations) into a flat, filterable list.
 * filterResults() does a case-insensitive substring match against label + detail.
 */

export type SearchKind = 'agent' | 'task' | 'automation' | 'setting' | 'view';

export interface SearchResult {
  id: string;
  label: string;
  detail?: string;
  kind: SearchKind;
  route: string;
  params?: Record<string, string>;
}

export const STATIC_VIEWS: readonly SearchResult[] = [
  { id: 'view:home', label: 'Home', detail: 'Dashboard overview', kind: 'view', route: 'home' },
  { id: 'view:terminal', label: 'Terminal', detail: 'Live agent sessions', kind: 'view', route: 'terminal' },
  { id: 'view:side-agent', label: 'Side Agent', detail: 'Chat with an AI assistant', kind: 'view', route: 'side-agent' },
  { id: 'view:board', label: 'Board', detail: 'Task kanban board', kind: 'view', route: 'board' },
  { id: 'view:team', label: 'Team', detail: 'Agents, automations and sources', kind: 'view', route: 'team' },
  { id: 'view:health', label: 'Health', detail: 'Service diagnostics', kind: 'view', route: 'health' },
  { id: 'view:settings', label: 'Settings', detail: 'App and floor preferences', kind: 'view', route: 'settings' },
  { id: 'view:automations', label: 'Automations', detail: 'Schedules, triggers and team activity', kind: 'view', route: 'team', params: { panel: 'automations' } },
  { id: 'view:graph', label: 'Team graph', detail: 'Agent communication graph', kind: 'view', route: 'team', params: { panel: 'graph' } },
];

export const STATIC_SETTINGS: readonly SearchResult[] = [
  { id: 'setting:setup', label: 'Setup', detail: 'Floor setup and prerequisites', kind: 'setting', route: 'settings', params: { tab: 'setup' } },
  { id: 'setting:account', label: 'Account', detail: 'Name, work email, timezone', kind: 'setting', route: 'settings', params: { tab: 'account' } },
  { id: 'setting:connections', label: 'Connections', detail: 'Integrations available to this floor', kind: 'setting', route: 'settings', params: { tab: 'connections' } },
  { id: 'setting:team', label: 'Team configuration', detail: 'Orchestrator, teams and defaults', kind: 'setting', route: 'settings', params: { tab: 'team' } },
  { id: 'setting:providers', label: 'AI engines', detail: 'Provider and model settings', kind: 'setting', route: 'settings', params: { tab: 'providers' } },
  { id: 'setting:memory', label: 'Memory', detail: 'Agent memory settings', kind: 'setting', route: 'settings', params: { tab: 'memory' } },
  { id: 'setting:autonomy', label: 'Autonomy & YOLO', detail: 'Iteration speed and auto-approve settings', kind: 'setting', route: 'settings', params: { tab: 'autonomy' } },
  { id: 'setting:notifications', label: 'Notifications', detail: 'Desktop notification preferences', kind: 'setting', route: 'settings', params: { tab: 'notifications' } },
  { id: 'setting:audit', label: 'My changes', detail: 'Audit log of your edits', kind: 'setting', route: 'settings', params: { tab: 'audit' } },
];

export function buildSearchIndex(
  agents: ReadonlyArray<{ id: string; name: string; role: string }>,
  cards: ReadonlyArray<{ key: string; title: string; status: string }>,
  automations: ReadonlyArray<{ id: string; name: string; when: string }>,
): SearchResult[] {
  const agentItems: SearchResult[] = agents.map((a) => ({
    id: `agent:${a.id}`,
    label: a.name,
    detail: a.role,
    kind: 'agent',
    route: 'terminal',
    params: { a: a.id },
  }));

  const taskItems: SearchResult[] = cards.map((c) => ({
    id: `task:${c.key}`,
    label: c.title,
    detail: c.status,
    kind: 'task',
    route: 'board',
  }));

  const autoItems: SearchResult[] = automations.map((a) => ({
    id: `auto:${a.id}`,
    label: a.name,
    detail: a.when,
    kind: 'automation',
    route: 'team',
    params: { panel: 'automations' },
  }));

  return [...STATIC_VIEWS, ...STATIC_SETTINGS, ...agentItems, ...taskItems, ...autoItems];
}

export function filterResults(items: readonly SearchResult[], query: string): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return items as SearchResult[];
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      (item.detail !== undefined && item.detail.toLowerCase().includes(q)),
  );
}

/** Group results by kind, in display order. Empty groups are omitted. */
export const KIND_ORDER: readonly SearchKind[] = ['agent', 'task', 'automation', 'view', 'setting'];

export const KIND_LABELS: Record<SearchKind, string> = {
  agent: 'Agents',
  task: 'Tasks',
  automation: 'Automations',
  view: 'Views',
  setting: 'Settings',
};

export function groupResults(items: SearchResult[]): Array<{ kind: SearchKind; label: string; results: SearchResult[] }> {
  const map = new Map<SearchKind, SearchResult[]>();
  for (const item of items) {
    if (!map.has(item.kind)) map.set(item.kind, []);
    map.get(item.kind)!.push(item);
  }
  return KIND_ORDER.filter((k) => map.has(k)).map((k) => ({
    kind: k,
    label: KIND_LABELS[k],
    results: map.get(k)!,
  }));
}

/**
 * Returns true when a keydown event should open the search palette.
 *
 * Platform rules (Ctrl+K is readline kill-to-end-of-line in xterm):
 *   macOS  → Cmd+K only (Ctrl+K must reach the terminal PTY unchanged)
 *   other  → Ctrl+K only when the event target is NOT inside an xterm (.xterm)
 *
 * `target` is typed as a duck-typed closest-capable object (no DOM lib needed
 * for standalone compilation and unit tests).
 */
export function isSearchTrigger(
  key: string,
  metaKey: boolean,
  ctrlKey: boolean,
  target: { closest(selector: string): object | null } | null,
  isMac: boolean,
): boolean {
  if (key.toLowerCase() !== 'k') return false;
  if (isMac) return metaKey && !ctrlKey;
  if (!ctrlKey) return false;
  if (target !== null && target.closest('.xterm') !== null) return false;
  return true;
}
