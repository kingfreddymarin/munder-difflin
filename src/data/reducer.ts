// Applies one event to the floor state. The mock provider and the UI store share it;
// the real core runs the same rules on its side.
import type { FloorEvent } from './protocol';
import type { AuditEntry, Message, Snapshot } from './types';

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
    case 'setup.dismiss':
      return audit({ ...s, setupDismissed: true }, ev, 'Continued in degraded mode', 'Setup', c.degraded.length ? `not ready: ${c.degraded.join(', ')}` : 'all ready', ['pm']);
    case 'layout.panels':
      return audit(s, ev, 'Changed Team layout', 'Team', c.panels.join(', '), []);
  }
}
