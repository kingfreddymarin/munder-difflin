// Projections of the core's raw hive data into what Home and Chats show: open asks (Munder's
// ASK ME) and live agent activity from log.jsonl. Pure functions with relative imports only,
// so the provider test can compile them without the app's path aliases.
import type { ActivityEvent, ActivityKind, Message } from './types';

type Raw = Record<string, unknown>;
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const list = (value: unknown): Raw[] => Array.isArray(value) ? value.filter((item): item is Raw => !!item && typeof item === 'object') : [];
const iso = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
};

/** Plain text of one markdown line: no bullet, emphasis or code ticks. */
const plain = (line: string) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').replace(/\*\*|__|`/g, '').trim();

/**
 * The options of a decision ask. PROTOCOL.md tells agents to give each option its own "-" bullet or
 * "1." number, so two to six short list items mean "pick one". Anything else is a free-text ask.
 */
export function askOptions(markdown: string): string[] {
  const items = markdown.split('\n').filter((line) => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(line)).map(plain).filter(Boolean);
  if (items.length < 2 || items.length > 6 || items.some((item) => item.length > 120)) return [];
  return items;
}

/**
 * One message per humanQA entry, routed to the asking agent's chat (`from`, else the assignee, else god).
 * Open = no answer and not dismissed, on a card that is not done (PROTOCOL.md "Asking the human").
 * The id is `<task id>:<index>`, which `ask.reply` / `ask.dismiss` take back.
 */
export function cardAsks(tasks: Raw[], agentIds: ReadonlySet<string>, godId: string): Message[] {
  return tasks.flatMap((task) => list(task.humanQA).map((qa, index): Message => {
    const owner = [str(qa.from), str(task.assignee)].find((id) => agentIds.has(id)) ?? godId;
    const text = str(qa.q);
    const answered = !!str(qa.a);
    const dismissed = !!str(qa.dismissedAt);
    const mode = str(qa.mode);
    return {
      id: `${str(task.id)}:${index}`, chatId: `agent:${owner}`, from: owner,
      at: iso(qa.askedAt) ?? iso(task.updatedAt) ?? iso(task.createdAt) ?? new Date(0).toISOString(),
      kind: 'question', text, ticket: str(task.id), options: askOptions(text),
      answer: str(qa.a) || undefined, answerMode: mode === 'answer' || mode === 'decision' || mode === 'done' ? mode : undefined,
      dismissed, dismissible: true,
      // A done card's ask is history, not something waiting on you.
      read: answered || dismissed || str(task.status) === 'done',
    };
  }));
}

/** What one log.jsonl line says an agent did, or null for lines that are not agent activity. */
function describe(line: Raw, name: (id: string) => string): { agentId: string; kind: ActivityKind; text: string } | null {
  const agentId = str(line.agentId);
  switch (str(line.kind)) {
    case 'message': {
      const from = str(line.from);
      const to = str(line.to);
      const subject = str(line.subject);
      return { agentId: from, kind: 'message', text: `${to === 'human' ? 'Messaged you' : `→ ${name(to)}`}${subject ? `: ${subject}` : ''}` };
    }
    case 'pty-submit': return { agentId, kind: 'tool', text: str(line.source) === 'queue' ? 'Picked up its next message' : 'Received input' };
    case 'drain': case 'inbox-settled': return { agentId, kind: 'message', text: `Read ${Number(line.count) || 0} message${Number(line.count) === 1 ? '' : 's'}` };
    case 'spawn': return { agentId, kind: 'lifecycle', text: 'Joined the floor' };
    case 'archive': return { agentId, kind: 'lifecycle', text: line.archived === false ? 'Back on the floor' : 'Left the floor' };
    case 'session': return { agentId, kind: 'lifecycle', text: 'Started a new session' };
    case 'rename': return { agentId, kind: 'edit', text: `Renamed from ${str(line.previousName)} to ${str(line.name)}` };
    case 'role': return { agentId, kind: 'edit', text: `Role is now ${str(line.role)}` };
    case 'agent-hold': return { agentId: str(line.id), kind: 'lifecycle', text: line.onHold ? 'Put on hold' : 'Released from hold' };
    case 'agent-exit': return { agentId, kind: line.abnormal ? 'breaker' : 'lifecycle', text: line.abnormal ? `Crashed (exit ${String(line.exitCode ?? '?')})` : 'Session ended' };
    case 'proxy-degraded': return { agentId, kind: 'breaker', text: 'Token proxy degraded' };
    case 'breaker': case 'circuit-breaker': return { agentId, kind: 'breaker', text: `Circuit breaker: ${str(line.level) || str(line.action) || 'tripped'}` };
    default: return null;
  }
}

/**
 * Agent activity, newest first, from the core's log tail. Only lines about a known agent are kept,
 * so the feed is exactly what the agents on this floor did; nothing is invented.
 */
export function logActivity(log: unknown, agentIds: ReadonlySet<string>, name: (id: string) => string): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  list(log).forEach((line, index) => {
    const at = iso(line.ts) ?? iso(line.at);
    const event = at ? describe(line, name) : null;
    if (!event || !at || !agentIds.has(event.agentId)) return;
    out.push({ id: `log-${str(line.id) || `${at}-${index}`}`, at, ...event });
  });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
