// The real core through the Electron preload. Server-authoritative: the snapshot is projected from the
// fork's raw data, commands go to the preload, and every failure becomes a BackendError with an errorId.
import { findBridge, requireBridge } from './bridge';
import type { ParamountCommand, ParamountDiagnostics, ParamountRawSnapshot } from './electron-api';
import { BackendError, checkOk, isFailure, toBackendError } from './errors';
import type { Command, DataProvider, FloorEvent } from './protocol';
import type { Agent, Card, Message, Snapshot } from './types';

type ElectronProvider = DataProvider & Required<Pick<DataProvider, 'onRefresh' | 'diagnostics' | 'unsupported'>> & { kind: 'electron' };

const CORE_COLUMNS: readonly string[] = ['todo', 'doing', 'blocked', 'done'];

function unsupported(command: Command): string | null {
  if (command.type === 'card.move' && !CORE_COLUMNS.includes(command.status)) return `The core board has no "${command.status}" column; use todo, doing, blocked or done.`;
  return null;
}

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

export function createElectronProvider(): ElectronProvider {
  const listeners = new Set<(event: FloorEvent) => void>();
  const refreshers = new Set<() => void>();
  // Ids of events already applied, so the push of an event we dispatched is not applied twice.
  const seen = new Set<string>();
  let lastSnapshot: Snapshot | null = null;
  const emit = (event: FloorEvent) => {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    if (seen.size > 500) seen.delete(seen.values().next().value as string);
    listeners.forEach((listener) => listener(event));
  };
  const refresh = () => refreshers.forEach((listener) => listener());

  return {
    kind: 'electron',
    async snapshot() {
      const bridge = requireBridge();
      let raw: ParamountRawSnapshot;
      try {
        raw = await bridge.paramountSnapshot();
      } catch (cause) {
        throw toBackendError(cause, 'snapshot');
      }
      const native = object(raw);
      if (!object(native.registry).agents || !Array.isArray(object(native.tasks).tasks) || !Array.isArray(native.ptys) || !Array.isArray(native.messages)) {
        throw BackendError.local('INTERNAL', 'The local core returned an incomplete snapshot.', 'snapshot');
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
          connections: [], notify: [{ id: 'desktop', label: 'Desktop', on: config.notifications === true }], yolo: { on: config.autoMode === true, autoOffHours: null, keepHardRules: true },
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
    unsupported,
    async dispatch(command: Command) {
      const bridge = requireBridge();
      const operation = command.type;
      try {
        if (command.type === 'chat.send') {
          const chat = lastSnapshot?.chats.find((item) => item.id === command.chatId);
          const recipient = chat?.agentIds[0];
          if (!recipient || !command.text.trim()) throw BackendError.local('INVALID_INPUT', 'Choose a real agent and enter a message.', operation);
          checkOk(await bridge.hiveSend({ to: recipient, act: 'request', subject: 'Message from human', body: command.text.trim() }, 'human'), operation, 'Message delivery failed.');
        } else if (command.type === 'card.move') {
          const reason = unsupported(command);
          if (reason) throw BackendError.local('UNSUPPORTED', reason, operation);
          checkOk(await bridge.hivePatchTask(command.key, { status: command.status }), operation, 'Could not move the task.');
        } else if (command.type === 'terminal.input') {
          const pty = lastSnapshot?.terminals.find((item) => item.agentId === command.agentId);
          if (!pty?.ptyId) throw BackendError.local('NOT_FOUND', 'This agent has no live terminal.', operation);
          checkOk(await bridge.writePty(pty.ptyId, command.text), operation, 'Could not write to the terminal.');
          checkOk(await bridge.writePty(pty.ptyId, '\r'), operation, 'Could not submit terminal input.');
        } else {
          const result = await bridge.paramountDispatch(command as ParamountCommand);
          if (isFailure(result)) {
            // The command may have been applied; the snapshot is the only truth now.
            if (result.code === 'UNCERTAIN_STATE') refresh();
            throw BackendError.fromFailure(result, operation);
          }
          if (!result?.ok) throw BackendError.local('INTERNAL', (result as { error?: string } | undefined)?.error || 'The core answered without a result.', operation);
          const event = { ...result.event, command } as FloorEvent;
          emit(event);
          return event;
        }
      } catch (cause) {
        throw toBackendError(cause, operation);
      }
      const event: FloorEvent = { id: `local-${Date.now()}`, at: new Date().toISOString(), actor: 'you', command };
      emit(event);
      return event;
    },
    async diagnostics(): Promise<ParamountDiagnostics> {
      const bridge = requireBridge();
      let result;
      try {
        result = await bridge.paramountDispatch({ type: 'diagnostics.bundle' });
      } catch (cause) {
        throw toBackendError(cause, 'diagnostics.bundle');
      }
      if (isFailure(result)) throw BackendError.fromFailure(result, 'diagnostics.bundle');
      if (!result?.ok || !result.diagnostics) throw BackendError.local('INTERNAL', 'The core returned no diagnostics bundle.', 'diagnostics.bundle');
      return result.diagnostics;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onRefresh(listener) {
      refreshers.add(listener);
      // Pushed events are applied in place; anything else (invalidate) means re-read the snapshot.
      const off = findBridge()?.onParamountEvent((update) => {
        if ('kind' in update) listener();
        else emit(update as unknown as FloorEvent);
      });
      return () => { refreshers.delete(listener); off?.(); };
    },
  };
}

