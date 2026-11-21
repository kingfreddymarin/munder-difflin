// Applies one event to the floor state. The mock provider and the UI store share it;
// the real core runs the same rules on its side.
import type { FloorEvent } from './protocol';
import type { AuditEntry, Card, Message, Snapshot } from './types';

const nameOf = (s: Snapshot, agentId: string) => s.agents.find((a) => a.id === agentId)?.name ?? agentId;
const chatFor = (s: Snapshot, agentId: string) => s.chats.find((c) => c.kind === 'agent' && c.agentIds[0] === agentId)?.id;

function audit(s: Snapshot, ev: FloorEvent, action: string, target: string, detail: string, contextFor: string[]): Snapshot {
  const entry: AuditEntry = { id: ev.id, at: ev.at, action, target, detail, contextFor };
  // Each affected agent receives the change as a context note in its own chat.
  const notes: Message[] = contextFor
    .map((agentId) => chatFor(s, agentId))
    .filter((c): c is string => !!c)
    .map((chatId, i) => ({ id: `${ev.id}-ctx-${i}`, chatId, from: 'you', at: ev.at, kind: 'context', text: `${action}: ${detail}` }));
  return { ...s, audit: [entry, ...s.audit], messages: [...s.messages, ...notes] };
}

/** Same rule as the core's parentError: another active card, and not one of `key`'s descendants. */
function parentAllowed(cards: Card[], key: string, parent: string): boolean {
  if (!cards.some((x) => x.key === parent && !x.boardArchivedAt)) return false;
  const seen = new Set<string>();
  for (let at: string | undefined = parent; at && !seen.has(at); at = cards.find((x) => x.key === at)?.parentId) {
    if (at === key) return false;
    seen.add(at);
  }
  return true;
}

export function applyEvent(s: Snapshot, ev: FloorEvent): Snapshot {
  const c = ev.command;
  switch (c.type) {
    case 'chat.send': {
      const chat = s.chats.find((x) => x.id === c.chatId);
      if (!chat) return s;
      const msg: Message = { id: ev.id, chatId: c.chatId, from: 'you', at: ev.at, kind: 'text', text: c.text, priority: true, read: false };
      // Direct messages from you jump the queue: the agent drops to its next safe point and reads it first.
      const agents = s.agents.map((a) => (chat.agentIds.includes(a.id) ? { ...a, status: 'working' as const, doing: `Reading your priority message: “${c.text.slice(0, 60)}”` } : a));
      const next = { ...s, agents, messages: [...s.messages, msg] };
      const entry: AuditEntry = { id: ev.id, at: ev.at, action: 'Sent a priority message', target: chat.title, detail: c.text, contextFor: chat.agentIds };
      return { ...next, audit: [entry, ...next.audit] };
    }
    case 'question.answer': {
      const m = s.messages.find((x) => x.id === c.messageId);
      if (!m) return s;
      const messages = s.messages.map((x) => (x.id === c.messageId ? { ...x, answer: c.option } : x));
      const notifications = s.notifications.map((n) => (n.messageId === c.messageId ? { ...n, resolved: c.option } : n));
      return audit({ ...s, messages, notifications }, ev, 'Answered', m.ticket ?? nameOf(s, m.from), `“${c.option}” to: ${m.text}`, [m.from]);
    }
    case 'ask.reply': {
      const m = s.messages.find((x) => x.id === c.messageId);
      if (!m) return s;
      const messages = s.messages.map((x) => (x.id === c.messageId ? { ...x, answer: c.text, answerMode: c.mode, read: true } : x));
      const notifications = s.notifications.map((n) => (n.messageId === c.messageId ? { ...n, resolved: c.text } : n));
      const action = c.mode === 'done' ? 'Marked done' : c.mode === 'decision' ? 'Decided' : 'Answered';
      return audit({ ...s, messages, notifications }, ev, action, m.ticket ?? nameOf(s, m.from), `“${c.text}” to: ${m.text}`, [m.from]);
    }
    case 'ask.dismiss': {
      const m = s.messages.find((x) => x.id === c.messageId);
      if (!m) return s;
      const messages = s.messages.map((x) => (x.id === c.messageId ? { ...x, dismissed: true, read: true } : x));
      const notifications = s.notifications.map((n) => (n.messageId === c.messageId ? { ...n, resolved: 'Dismissed' } : n));
      return { ...s, messages, notifications };
    }
    case 'home.layout':
      return { ...s, homeLayout: { ...s.homeLayout, ...c.layout } };
    case 'home.objectives':
      // The editor sends the full normalized list (objectivesToSave); keep this file type-import only.
      return { ...s, objectives: c.objectives.map((o) => ({ ...o, cardKeys: [...o.cardKeys] })) };
    case 'chats.view': {
      const { type: _type, ...view } = c;
      return { ...s, chatView: { ...s.chatView, ...view } };
    }
    case 'notification.act': {
      const n = s.notifications.find((x) => x.id === c.notificationId);
      if (!n) return s;
      const notifications = s.notifications.map((x) => (x.id === n.id ? { ...x, resolved: c.action } : x));
      const messages = n.messageId ? s.messages.map((x) => (x.id === n.messageId ? { ...x, answer: c.action } : x)) : s.messages;
      const to = n.from === 'system' ? ['pm'] : [n.from];
      return audit({ ...s, notifications, messages }, ev, c.action, n.title, n.body, to);
    }
    case 'card.move': {
      const card = s.cards.find((x) => x.key === c.key);
      if (!card) return s;
      const cards = s.cards.map((x) => (x.key === c.key ? { ...x, status: c.status, updated: ev.at } : x));
      return audit({ ...s, cards }, ev, 'Moved card', card.key, `${card.status} → ${c.status}`, [card.agentId]);
    }
    case 'card.dispatch':
      return { ...s, cards: s.cards.map((card) => card.key === c.key ? { ...card, agentId: c.agentId } : card) };
    case 'card.create': {
      if (!c.key || s.cards.some((x) => x.key === c.key)) return s;
      const card: Card = {
        key: c.key, title: c.title, status: c.status ?? 'todo', priority: c.priority === 1 ? 'P1' : c.priority === 3 ? 'P3' : 'P2',
        agentId: c.assignee ?? '', created: ev.at, createdBy: 'you', updated: ev.at, description: c.description ?? '',
        plan: [], doneMeans: [], tags: [], refs: [], tokens: 0, origin: 'you', people: [],
      };
      return audit({ ...s, cards: [...s.cards, card] }, ev, 'Created card', card.key, card.title, c.assignee ? [c.assignee] : []);
    }
    case 'card.archive': {
      const card = s.cards.find((x) => x.key === c.key);
      if (!card || card.boardArchivedAt) return s;
      const cards = s.cards.map((x) => x === card ? { ...x, boardArchivedAt: ev.at } : x);
      return audit({ ...s, cards }, ev, 'Archived card', card.key, card.title, []);
    }
    case 'card.update': {
      const card = s.cards.find((x) => x.key === c.key);
      if (!card) return s;
      // The core refuses a missing parent, the card itself and cycles; the mock relies on this guard.
      if (c.patch.parentId && !parentAllowed(s.cards, c.key, c.patch.parentId)) return s;
      const priorityStr: 'P1' | 'P2' | 'P3' | undefined = c.patch.priority === 1 ? 'P1' : c.patch.priority === 3 ? 'P3' : c.patch.priority === 2 ? 'P2' : undefined;
      const cards = s.cards.map((x) => x.key !== c.key ? x : {
        ...x,
        ...(c.patch.title !== undefined ? { title: c.patch.title } : {}),
        ...(c.patch.description !== undefined ? { description: c.patch.description } : {}),
        ...(priorityStr !== undefined ? { priority: priorityStr } : {}),
        ...(c.patch.assignee !== undefined ? { agentId: c.patch.assignee } : {}),
        ...(c.patch.parentId !== undefined ? { parentId: c.patch.parentId || undefined } : {}),
        ...(c.patch.blockItems !== undefined ? { blockItems: c.patch.blockItems } : {}),
        updated: ev.at,
      });
      const detail = Object.entries(c.patch).map(([k, v]) => `${k} = ${v}`).join(', ');
      return audit({ ...s, cards }, ev, 'Updated card', card.key, detail, card.agentId ? [card.agentId] : []);
    }
    case 'automation.toggle': {
      const a = s.automations.find((x) => x.id === c.id);
      if (!a) return s;
      const automations = s.automations.map((x) => (x.id === c.id ? { ...x, enabled: c.enabled } : x));
      return audit({ ...s, automations }, ev, c.enabled ? 'Resumed automation' : 'Paused automation', a.name, a.when, ['pm']);
    }
    case 'access.set': {
      const key = `${c.agentId}:${c.sourceId}`;
      const before = s.access[key] ?? 'none';
      const label = { rw: 'read + write', r: 'read only', none: 'no access' };
      return audit({ ...s, access: { ...s.access, [key]: c.access } }, ev, 'Changed data access', nameOf(s, c.agentId), `${c.sourceId}: ${label[before]} → ${label[c.access]}`, [c.agentId]);
    }
    case 'agent.update': {
      const agents = s.agents.map((a) => (a.id === c.agentId ? { ...a, ...c.patch } : a));
      const detail = Object.entries(c.patch).map(([k, v]) => `${k} = ${v}`).join(', ');
      return audit({ ...s, agents }, ev, 'Updated agent profile', nameOf(s, c.agentId), detail, [c.agentId]);
    }
    case 'floor.yolo': {
      const yolo = { ...s.me.yolo, ...c.patch, since: c.patch.on ? ev.at : s.me.yolo.since };
      let notifications = s.notifications;
      if (yolo.on) notifications = notifications.map((n) => (n.kind === 'approval' && !n.resolved ? { ...n, resolved: 'Auto-approved (YOLO)' } : n));
      const detail = c.patch.on === undefined ? Object.entries(c.patch).map(([k, v]) => `${k} = ${v}`).join(', ') : c.patch.on ? 'on: no token caps, approvals auto-granted, breaker only steers' : 'off: caps and approvals restored';
      return audit({ ...s, me: { ...s.me, yolo }, notifications }, ev, 'YOLO mode', 'Floor', detail, s.agents.map((a) => a.id));
    }
    case 'floor.iteration': {
      const iteration = { ...s.me.iteration, ...c.patch };
      return audit({ ...s, me: { ...s.me, iteration } }, ev, 'Iteration cycle', 'Floor', Object.entries(c.patch).map(([k, v]) => `${k} = ${v}`).join(', '), s.agents.map((a) => a.id));
    }
    case 'account.connection': {
      const connections = s.me.connections.map((x) => (x.id === c.id ? { ...x, connected: c.connected } : x));
      return audit({ ...s, me: { ...s.me, connections } }, ev, c.connected ? 'Connected' : 'Disconnected', c.id, '', ['pm']);
    }
    case 'account.notify': {
      const notify = s.me.notify.map((x) => (x.id === c.id ? { ...x, on: c.on } : x));
      return audit({ ...s, me: { ...s.me, notify } }, ev, 'Notification setting', c.id, c.on ? 'on' : 'off', ['pm']);
    }
    case 'account.profile':
      return audit({ ...s, me: { ...s.me, ...c.patch } }, ev, 'Updated account', 'You', Object.keys(c.patch).join(', '), ['pm']);
    case 'settings.update': {
      const key = Object.keys(c.patch)[0] ?? '';
      const settings = { ...s.settings, [key]: ['circuitBreaker', 'providerBaseUrls', 'providerDefaultModels'].includes(key)
        ? { ...(s.settings?.[key] as Record<string, unknown> | undefined), ...(c.patch[key] as Record<string, unknown>) }
        : c.patch[key] };
      return audit({ ...s, settings }, ev, 'Updated setting', key, String(key === 'circuitBreaker' ? Object.keys(c.patch.circuitBreaker as object)[0] : c.patch[key]), s.agents.map((a) => a.id));
    }
    case 'terminal.input': {
      const terminals = s.terminals.map((t) => (t.agentId === c.agentId ? { ...t, pending: undefined, lines: [...t.lines, { stream: 'in' as const, text: `you › ${c.text}` }] } : t));
      return audit({ ...s, terminals }, ev, 'Typed into terminal', nameOf(s, c.agentId), c.text, [c.agentId]);
    }
    case 'prereq.install':
    case 'prereq.start': {
      const p = s.prerequisites.find((x) => x.id === c.id);
      if (!p) return s;
      // The core runs the command with your approval and re-checks; the mock marks it ready.
      const prerequisites = s.prerequisites.map((x) => (x.id === c.id ? { ...x, state: 'ready' as const, detail: c.type === 'prereq.install' ? 'installed just now · running' : 'started just now' } : x));
      const services = s.services.map((x) => (x.id === c.id ? { ...x, state: 'ok' as const, detail: 'running · checked just now', fix: undefined } : x));
      return audit({ ...s, prerequisites, services }, ev, c.type === 'prereq.install' ? 'Installed prerequisite' : 'Started prerequisite', p.name, (c.type === 'prereq.install' ? p.install : p.start) ?? '', ['pm']);
    }
    case 'setup.complete':
      return audit({ ...s, floorSetup: s.floorSetup ? { ...s.floorSetup, complete: true, harnessHome: c.home } : s.floorSetup }, ev, 'Set up this floor', 'Setup', `${c.engine}${c.model ? ` · ${c.model}` : ''} · ${c.home}`, ['pm']);
    case 'setup.dismiss':
      return audit({ ...s, setupDismissed: true }, ev, 'Continued in degraded mode', 'Setup', c.degraded.length ? `not ready: ${c.degraded.join(', ')}` : 'all ready', ['pm']);
    case 'layout.panels':
      return audit(s, ev, 'Changed Team layout', 'Team', c.panels.join(', '), []);
    case 'board.columns':
      return audit({ ...s, board: { columns: c.order } }, ev, 'Reordered board columns', 'Board', c.order.join(' → '), []);
    case 'card.open':
    case 'card.link':
      // Opening is a side effect in the core; the board's data does not change.
      return s;
    default:
      // The core also pushes events for its own commands (diagnostics.save, …) that change no
      // floor data. Keep the state: returning undefined blanks the whole app to "Connecting…".
      return s;
  }
}

/** The next key of the most used prefix (NSC-68 → NSC-69); the core does the same for real cards. */
export function nextCardKey(keys: string[]): string {
  const counts = new Map<string, { n: number; max: number }>();
  for (const key of keys) {
    const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(key);
    if (!m) continue;
    const at = counts.get(m[1]) ?? { n: 0, max: 0 };
    counts.set(m[1], { n: at.n + 1, max: Math.max(at.max, Number(m[2])) });
  }
  const [prefix, at] = [...counts].sort((a, b) => b[1].n - a[1].n)[0] ?? ['P', { max: 0 }];
  return `${prefix}-${at.max + 1}`;
}
