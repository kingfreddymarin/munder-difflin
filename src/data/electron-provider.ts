import type { Command, DataProvider, FloorEvent } from './protocol';
import type { Agent, Card, Message, Snapshot } from './types';

type RefreshProvider = DataProvider & { onRefresh: (listener: () => void) => () => void };

const array = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const date = (value: unknown): string => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString();

function role(value: string, isGod: boolean): Agent['role'] {
  if (isGod) return 'paramount';
  if (value.includes('co-lead')) return 'co-lead';
  if (value.includes('lead')) return 'lead';
  if (value.includes('watch')) return 'watcher';
  if (value.includes('temp') || value.includes('ephemeral')) return 'ephemeral';
  return 'worker';
}

function status(value: string, breaker: string): Agent['status'] {
  if (breaker === 'constrain' || breaker === 'stop') return 'constrained';
  if (value === 'working' || value === 'busy') return 'working';
  if (value === 'blocked' || value === 'waiting') return 'waiting';
  if (value === 'crashed' || value === 'error') return 'crashed';
  return 'idle';
}

export function createElectronProvider(): RefreshProvider {
  const listeners = new Set<(event: FloorEvent) => void>();
  let lastSnapshot: Snapshot | null = null;

  return {
    async snapshot() {
      const bridge = window.cth;
      if (!bridge) throw new Error('Electron preload is unavailable. Open Paramount in the desktop app.');
      const native = object(await bridge.paramountSnapshot());
      if (!object(native.registry).agents || !Array.isArray(object(native.tasks).tasks) || !Array.isArray(native.ptys) || !Array.isArray(native.messages)) {
        throw new Error('The local core returned an incomplete snapshot.');
      }
      const registry = object(native.registry);
      const registryAgents = object(registry.agents);
      const roster = object(native.roster);
      const rosterAgents = array(roster.agents);
      const rosterById = new Map(rosterAgents.map((item) => [string(item.id), item]));
      const tasks = array(object(native.tasks).tasks);
      const rawMessages = native.messages;
      const config = object(native.config);
      const preferences = object(native.preferences);
      const profile = object(preferences.profile);
      const livePtys = new Map(array(native.ptys).map((pty) => [string(pty.id), pty]));
      const ptyByAgent = new Map(rosterAgents.flatMap((agent) => {
        const pty = livePtys.get(string(agent.ptyId));
        return pty ? [[string(agent.id), pty] as const] : [];
      }));

      const agents: Agent[] = Object.entries(registryAgents).filter(([, raw]) => !object(raw).archived).map(([id, raw]) => {
        const source = object(raw);
        const local = rosterById.get(id) ?? {};
        const name = string(source.name, string(local.name, id));
        return {
        id, name, initials: name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase(),
        role: role(string(source.role).toLowerCase(), id === string(registry.godId)), status: status(string(source.status, string(local.status)), string(source.breaker)),
        engine: string(local.provider, 'unknown'), model: string(local.model), level: 1, color: string(local.accent, 'sky'), doing: string(local.action),
        step: 0, steps: 0, tokensUsed: 0, tokensCap: 0,
        tokensIn: 0, tokensOut: 0, tokensCached: 0, contextPct: 0,
        bundle: '', skills: [], mcps: [], rules: [],
      }; });
      const agentIds = new Set(agents.map((agent) => agent.id));
      const chats = agents.map((agent) => ({ id: `agent:${agent.id}`, kind: 'agent' as const, title: agent.name, agentIds: [agent.id], pinned: agent.role === 'paramount' }));
      const routedMessages: Message[] = array(rawMessages).filter((item) => agentIds.has(string(item.owner))).map((item) => ({
        id: string(item.id), chatId: `agent:${string(item.owner)}`, from: string(item.from) === 'human' ? 'you' : string(item.from),
        at: date(item.created_at), kind: item.requires_reply ? 'question' : 'text',
        text: [string(item.subject), string(item.body)].filter(Boolean).join('\n\n'),
        read: item.archived === true,
      }));
      const questions: Message[] = tasks.flatMap((task) => array(task.humanQA).map((item, index) => ({
        id: `${string(task.id)}:${index}`, chatId: `agent:${agentIds.has(string(task.assignee)) ? string(task.assignee) : string(registry.godId)}`,
        from: agentIds.has(string(task.assignee)) ? string(task.assignee) : string(registry.godId),
        at: date(item.askedAt), kind: 'question' as const, text: string(item.q), ticket: string(task.id),
        answer: string(item.a) || undefined, read: !!item.a,
      })));
      const messages: Message[] = [...routedMessages, ...questions];
      const cards: Card[] = tasks.map((task) => ({
        key: string(task.id), title: string(task.title, 'Untitled task'),
        status: ['todo', 'doing', 'blocked', 'done'].includes(string(task.status)) ? string(task.status) as Card['status'] : 'todo',
        priority: Number(task.priority) <= 1 ? 'P1' : Number(task.priority) === 2 ? 'P2' : 'P3',
        agentId: string(task.assignee), created: date(task.createdAt), createdBy: 'hive', updated: date(task.updatedAt ?? task.createdAt),
        description: string(task.description), dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.filter((id): id is string => typeof id === 'string').join(', ') : '',
        plan: [], doneMeans: [], links: [], evidence: [], tokens: 0, origin: 'hive', people: [],
      }));
      const snapshot: Snapshot = {
        prerequisites: [], setupDismissed: true, objectives: [], wins: [],
        me: { name: string(profile.name), email: '', workEmail: string(profile.workEmail), timezone: string(profile.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone),
          connections: [], notify: [{ id: 'desktop', label: 'Desktop', on: config.notifications === true }], yolo: { on: false, autoOffHours: null, keepHardRules: true },
          iteration: { speed: 'balanced', heartbeatSec: 0, standupMin: 0, checkpointEverySteps: 0 } },
        agents, chats, messages,
        notifications: messages.filter((message) => message.kind === 'question' && !message.read).map((message) => ({
          id: message.id, kind: 'question' as const, from: message.from, title: 'Needs your answer', body: message.text,
          at: message.at, chatId: message.chatId, messageId: message.id, actions: [],
        })),
        cards, activity: [], timelines: [], sources: [], access: {}, engines: [],
        automations: array(native.missions).map((mission) => ({ id: string(mission.id), name: string(mission.label), when: String(mission.intervalMs ?? ''),
          onlyIf: '', then: string(mission.body), onFailure: '', enabled: mission.enabled === true, runs: [], last: '', file: '' })),
        services: [{ id: 'core', group: 'command-center', name: 'Local core', state: 'ok', detail: 'Connected' }], log: [],
        terminals: agents.filter((agent) => ptyByAgent.has(agent.id)).map((agent) => ({ agentId: agent.id, ptyId: string(ptyByAgent.get(agent.id)?.id), cwd: string(ptyByAgent.get(agent.id)?.cwd), lines: [] })),
        audit: [],
      };
      lastSnapshot = snapshot;
      return snapshot;
    },
    async dispatch(command: Command) {
      const bridge = window.cth;
      if (!bridge) throw new Error('The desktop core is disconnected.');
      if (command.type === 'chat.send') {
        const chat = lastSnapshot?.chats.find((item) => item.id === command.chatId);
        const recipient = chat?.agentIds[0];
        if (!recipient || !command.text.trim()) throw new Error('Choose a real agent and enter a message.');
        const result = await bridge.hiveSend({ to: recipient, act: 'request', subject: 'Message from human', body: command.text.trim() }, 'human');
        if (!result.ok) throw new Error(result.error || 'Message delivery failed.');
      } else if (command.type === 'card.move') {
        if (!['todo', 'doing', 'blocked', 'done'].includes(command.status)) throw new Error('This board status is not supported by the core.');
        const result = await bridge.hivePatchTask(command.key, { status: command.status as 'todo' | 'doing' | 'blocked' | 'done' });
        if (!result.ok) throw new Error(result.error || 'Could not move the task.');
      } else if (command.type === 'terminal.input') {
        const pty = lastSnapshot?.terminals.find((item) => item.agentId === command.agentId);
        if (!pty?.ptyId) throw new Error('This agent has no live terminal.');
        const written = await bridge.writePty(pty.ptyId, command.text);
        if (!written.ok) throw new Error(written.error || 'Could not write to the terminal.');
        const submitted = await bridge.writePty(pty.ptyId, '\r');
        if (!submitted.ok) throw new Error(submitted.error || 'Could not submit terminal input.');
      } else {
        const result = await bridge.paramountDispatch(command);
        if (!result.ok) throw new Error(result.error);
        return result.event;
      }
      const event: FloorEvent = { id: `local-${Date.now()}`, at: new Date().toISOString(), actor: 'you', command };
      listeners.forEach((listener) => listener(event));
      return event;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onRefresh(listener) {
      return window.cth?.onParamountEvent((update) => {
        if ('kind' in update && update.kind === 'invalidate') listener();
        else listener();
      }) ?? (() => {});
    },
  };
}
