// The real core through the Electron preload. Server-authoritative: the snapshot is projected from the
// fork's raw data, commands go to the preload, and every failure becomes a BackendError with an errorId.
import { engineSignIns, externalTools, mutedSignInProviders, selectedSignInProviders, setupDismissedFor } from './external-tools';
import { floorChoiceOf } from './floor-choice';
import { objectivesOf } from './objectives';
import { findBridge, requireBridge } from './bridge';
import type { ParamountAgentDiscovery, ParamountArtifactMap, ParamountAgentImport, ParamountCommand, ParamountDiagnostics, ParamountDiagnosticsSave, ParamountHirePlan, ParamountRawSnapshot, ParamountResult, ParamountTeamCommand, ParamountTeamModels, ParamountTeamResult } from './electron-api';
import { BackendError, checkOk, isFailure, toBackendError } from './errors';
import { askOptions, cardAsks, heartbeatUpdate, logActivity } from './projection';
import type { Command, DataProvider, FloorEvent } from './protocol';
import type { Agent, Card, CardRef, CardStatus, FloorSetup, Message, Snapshot } from './types';

type ElectronProvider = DataProvider & Required<Pick<DataProvider, 'onRefresh' | 'diagnostics' | 'saveDiagnostics' | 'saveAgentPreset' | 'unsupported' | 'discoverAgents' | 'importAgent' | 'openExternal' | 'openIn' | 'teamModels' | 'hire' | 'artifacts'>> & { kind: 'electron' };

const CORE_COLUMNS: readonly string[] = ['todo', 'doing', 'blocked', 'done'];
/** Agent fields the core's agent.update accepts (name, budget; model via the Team module). */
const CORE_AGENT_FIELDS: readonly string[] = ['name', 'tokensCap', 'model'];

function unsupported(command: Command): string | null {
  if (command.type === 'card.move' && !CORE_COLUMNS.includes(command.status)) return `The core board has no "${command.status}" column; use todo, doing, blocked or done.`;
  if (command.type === 'agent.update') {
    const keys = Object.keys(command.patch);
    if (keys.length !== 1) return 'The core changes one agent field per command.';
    if (!CORE_AGENT_FIELDS.includes(keys[0])) return `the core does not store an agent's ${keys[0]} yet.`;
  }
  return null;
}

const array = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
// An unknown time stays '' (shown as '—'), never "now": an invented time is a hardcoded value and would also
// make every refresh look changed.
const date = (value: unknown): string => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : '';

function floorLockOf(value: unknown): FloorSetup['floorLock'] {
  const v = object(value);
  if (v.state === 'open') return { state: 'open', floor: string(v.floor) };
  if (v.state === 'none') return { state: 'none' };
  if (v.state === 'error') return { state: 'error', floor: string(v.floor), detail: string(v.detail) };
  if (v.state === 'refused') {
    const r = object(v.refusal);
    return { state: 'refused', refusal: { floor: string(r.floor), owner: string(r.owner, 'Another app'), pid: typeof r.pid === 'number' ? r.pid : 0, since: string(r.since), userData: string(r.userData) } };
  }
  return undefined;
}
function hookSocketOf(value: unknown): Snapshot['hookSocket'] {
  const v = object(value);
  if (typeof v.listening !== 'boolean') return undefined;
  return { listening: v.listening, lastError: typeof v.lastError === 'string' ? v.lastError : null, attempts: typeof v.attempts === 'number' ? v.attempts : 0 };
}
function orchestratorFailureOf(value: unknown): Snapshot['orchestratorFailure'] {
  const v = object(value);
  if (typeof v.message !== 'string' || !v.message || typeof v.agentId !== 'string') return undefined;
  return { agentId: v.agentId, provider: string(v.provider), resumed: v.resumed === true, ...(typeof v.exitCode === 'number' ? { exitCode: v.exitCode } : {}), message: v.message, at: string(v.at) };
}
/** A responsive core and a registered agent do not establish a running orchestrator. */
function orchestratorService(godId: string, registered: Record<string, unknown>, local: Record<string, unknown>, live: boolean, failure: Snapshot['orchestratorFailure']): Snapshot['services'][number] {
  const service = { id: 'orchestrator', group: 'command-center' as const, name: 'Orchestrator' };
  if (failure && (!godId || failure.agentId === godId)) return { ...service, state: 'fail', detail: failure.message, fix: 'Open setup' };
  if (!godId || !Object.keys(registered).length) return { ...service, state: 'warn', detail: 'Readiness unknown — no orchestrator registered', fix: 'Open setup' };
  if (registered.archived === true) return { ...service, state: 'warn', detail: 'Stopped — orchestrator is archived', fix: 'Open setup' };
  if (live) return { ...service, state: 'ok', detail: 'Running — live terminal reported' };
  if (registered.status === 'starting' || local.status === 'starting') return { ...service, state: 'warn', detail: 'Starting — waiting for a live terminal' };
  if (registered.status === 'crashed') return { ...service, state: 'fail', detail: 'Reported crashed — no live terminal', fix: 'Open setup' };
  return { ...service, state: 'warn', detail: 'Not running — no live terminal reported', fix: 'Open setup' };
}
/** The core's first-run setup state. Absent (an older core) means the floor is already set up. */
function floorSetupOf(value: unknown): FloorSetup | undefined {
  const v = object(value);
  if (typeof v.complete !== 'boolean') return undefined;
  return {
    ...(v.launchers ? { launchers: v.launchers as FloorSetup['launchers'] } : {}),
    ...(floorLockOf(v.floorLock) ? { floorLock: floorLockOf(v.floorLock) } : {}),
    // The floor picker (launch and New Floor…); without it the window opened no floor and showed the app.
    ...(floorChoiceOf(v.choice) ? { choice: floorChoiceOf(v.choice) } : {}),
    complete: v.complete,
    harnessHome: typeof v.harnessHome === 'string' ? v.harnessHome : null,
    suggestedHome: string(v.suggestedHome),
    engines: array(v.engines).map((e) => ({
      id: string(e.id), label: string(e.label, string(e.id)), orchestrator: e.orchestrator === true, installed: e.installed === true,
      models: Array.isArray(e.models) ? e.models.filter((m): m is string => typeof m === 'string') : []
    })).filter((e) => e.id)
  };
}

const REF_KINDS: readonly string[] = ['pr', 'build', 'run', 'workitem'];
const REF_SYSTEMS: readonly string[] = ['github', 'ado'];
const httpsUrl = (value: unknown): value is string => {
  try { return typeof value === 'string' && new URL(value).protocol === 'https:'; } catch { return false; }
};
/** Same rule as the core's cardRefs: malformed refs and non-https URLs are left out. */
function refs(value: unknown): CardRef[] {
  return array(value).filter((ref) => REF_KINDS.includes(string(ref.kind)) && REF_SYSTEMS.includes(string(ref.system)) && string(ref.id) && httpsUrl(ref.url))
    .map((ref) => ({ kind: ref.kind, system: ref.system, id: string(ref.id), url: string(ref.url) }) as CardRef);
}
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()))] : [];
/** The human's saved order first, then any core column they have not placed. */
function boardColumns(saved: unknown): CardStatus[] {
  const order = strings(saved).filter((id) => CORE_COLUMNS.includes(id));
  return [...order, ...CORE_COLUMNS.filter((id) => !order.includes(id))] as CardStatus[];
}

function role(value: string, isGod: boolean): Agent['role'] {
  if (isGod) return 'paramount';
  if (value.includes('co-lead')) return 'co-lead';
  if (value.includes('lead')) return 'lead';
  if (value.includes('watch')) return 'watcher';
  if (value.includes('temp') || value.includes('ephemeral')) return 'ephemeral';
  return 'worker';
}

function status(value: string, breaker: string): Agent['status'] {
  if (breaker === 'constrain' || breaker === 'constrained' || breaker === 'stop' || breaker === 'stopped') return 'constrained';
  if (value === 'working' || value === 'busy') return 'working';
  if (value === 'blocked' || value === 'waiting') return 'waiting';
  if (value === 'crashed' || value === 'error') return 'crashed';
  return 'idle';
}

type OkResult = Extract<ParamountResult, { ok: true }> & Omit<ParamountTeamResult, 'ok' | 'event'>;
type ResultPayload = 'diagnostics' | 'saved' | 'discovery' | 'imported' | 'models' | 'hire' | 'artifacts' | 'organization' | 'delegated';

/** Sends a command whose answer is a payload on the result rather than a floor event. */
async function query<K extends ResultPayload>(command: ParamountCommand | ParamountTeamCommand, payload: K, missing: string): Promise<NonNullable<OkResult[K]>> {
  const bridge = requireBridge();
  let result: ParamountResult;
  try {
    result = await bridge.paramountDispatch(command as ParamountCommand);
  } catch (cause) {
    throw toBackendError(cause, command.type);
  }
  if (isFailure(result)) throw BackendError.fromFailure(result, command.type);
  const value = result?.ok ? (result as OkResult)[payload] : undefined;
  if (!value) throw BackendError.local('INTERNAL', missing, command.type);
  return value as NonNullable<OkResult[K]>;
}

/** Sends a command that only acts outside the floor (no snapshot change); any failure becomes a BackendError. */
async function act(command: ParamountCommand): Promise<void> {
  const bridge = requireBridge();
  let result: ParamountResult;
  try {
    result = await bridge.paramountDispatch(command);
  } catch (cause) {
    throw toBackendError(cause, command.type);
  }
  if (isFailure(result)) throw BackendError.fromFailure(result, command.type);
  if (!result?.ok) throw BackendError.local('INTERNAL', 'The core answered without a result.', command.type);
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
      const organization = object(native.organization);
      const reporting = object(organization.reportsTo);
      const orgTeams = array(organization.teams);
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
      // Current main-process ownership wins over a missing or stale legacy
      // roster. Only live PTYs are projected; exited sessions disappear.
      for (const pty of livePtys.values()) {
        if (string(pty.agentId)) ptyByAgent.set(string(pty.agentId), pty);
      }

      // Live busy/idle, last tool, tokens and context from the main process (owner use of 52051eda:
      // the registry's status stays 'idle' while agents run, so the graph never showed anyone working).
      const activity = object(native.activity);
      const registryGod = string(registry.godId);
      // NSC-222 (B1): an archived agent (an archived god included) is not drawn, so it is never a reportsTo target.
      const liveTarget = (target: string) => !!target && !(registryAgents[target] !== undefined && object(registryAgents[target]).archived);
      const agents: Agent[] = Object.entries(registryAgents).filter(([, raw]) => !object(raw).archived).map(([id, raw]) => {
        const source = object(raw);
        const local = rosterById.get(id) ?? {};
        const live = object(activity[id]);
        const name = string(source.name, string(local.name, id));
        const liveBreaker = string(live.breaker);
        const registered = status(string(source.status, string(local.status)), liveBreaker || string(source.breaker));
        const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
        const totalTokens = finite(live.tokens);
        const tokenCapConfig = object(config.agentTokenCaps);
        const configuredAgentCap = finite(tokenCapConfig[id]);
        const tokenCap = configuredAgentCap;
        const contextPct = finite(live.contextPct);
        return {
        id, name, initials: name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase(),
        role: role(string(source.role).toLowerCase(), id === registryGod),
        // Live terminal activity decides working vs idle; breaker, blocked and crashed states still win.
        status: typeof live.busy === 'boolean' && (registered === 'idle' || registered === 'working') ? (live.busy ? 'working' : 'idle') : registered,
        engine: string(local.provider, string(source.provider)), model: string(local.model), level: Number(source.level) || 0, color: string(local.accent, 'sky'),
        doing: string(local.action, string(live.doing)),
        step: 0, steps: 0, tokensUsed: (totalTokens ?? 0) / 1e6, tokensReported: totalTokens !== null,
        tokensCap: tokenCap === null ? 0 : tokenCap / 1e6,
        tokensIn: (finite(live.inputTokens) ?? 0) / 1e6,
        tokensOut: (finite(live.outputTokens) ?? 0) / 1e6,
        tokensCached: ((finite(live.cacheReadTokens) ?? 0) + (finite(live.cacheCreationTokens) ?? 0)) / 1e6,
        contextPct, costUsd: finite(live.costUsd), breaker: liveBreaker || undefined,
        bundle: '', skills: [], mcps: [], rules: [],
        ...(liveTarget(string(reporting[id])) ? { reportsTo: string(reporting[id]) } : registryGod && id !== registryGod && registryAgents[registryGod] && liveTarget(registryGod) ? { reportsTo: registryGod } : {}),
        teamIds: orgTeams.filter((team) => Array.isArray(object(team).memberIds) && (object(team).memberIds as unknown[]).includes(id)).map((team) => string(object(team).id)),
        teamNames: orgTeams.filter((team) => Array.isArray(object(team).memberIds) && (object(team).memberIds as unknown[]).includes(id)).map((team) => string(object(team).name, string(object(team).id))),
      }; });
      const agentIds = new Set(agents.map((agent) => agent.id));
      const chats = agents.map((agent) => ({ id: `agent:${agent.id}`, kind: 'agent' as const, title: agent.name, agentIds: [agent.id], pinned: agent.role === 'paramount' }));
      const godId = string(registry.godId);
      const godPty = ptyByAgent.get(godId);
      const orchestratorLive = !!string(godPty?.id) && (!string(godPty?.agentId) || godPty?.agentId === godId);
      const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id;
      const mail = array(rawMessages).filter((item) => agentIds.has(string(item.owner)));
      // A direct question is mail an agent sent to the human that needs a reply. It counts as answered
      // once the human has written in the same conversation after it.
      const humanReplies = mail.filter((item) => string(item.from) === 'human');
      const answeredBy = (item: Record<string, unknown>) => humanReplies.find((reply) => string(reply.conversation) === string(item.conversation) && string(reply.created_at) > string(item.created_at));
      const routedMessages: Message[] = mail.map((item) => {
        const subject = string(item.subject);
        const text = string(item.from) === 'human' && subject === 'Message from human'
          ? string(item.body)
          : [subject, string(item.body)].filter(Boolean).join('\n\n');
        const asks = item.requires_reply === true && string(item.to) === 'human' && string(item.from) !== 'human';
        const reply = asks ? answeredBy(item) : undefined;
        return {
          id: string(item.id), chatId: `agent:${string(item.owner)}`, from: string(item.from) === 'human' ? 'you' : string(item.from),
          at: date(item.created_at), kind: asks ? 'question' : 'text', text,
          ...(asks ? { options: askOptions(string(item.body)), answer: reply ? string(reply.body) : undefined } : {}),
          read: item.archived === true || !!reply,
          to: string(item.to) || undefined, act: string(item.act) || undefined,
          ...heartbeatUpdate(item),
        };
      });
      const questions = cardAsks(tasks, agentIds, godId);
      const messages: Message[] = [...routedMessages, ...questions];
      const cards: Card[] = tasks.map((task) => ({
        key: string(task.id), title: string(task.title, 'Untitled task'),
        status: ['todo', 'doing', 'blocked', 'done'].includes(string(task.status)) ? string(task.status) as Card['status'] : 'todo',
        priority: task.priority === 1 ? 'P1' : task.priority === 2 ? 'P2' : task.priority === 3 ? 'P3' : '',
        agentId: string(task.assignee), created: date(task.createdAt), createdBy: string(task.createdBy), updated: date(task.updatedAt ?? task.createdAt),
        description: string(task.description), dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.filter((id): id is string => typeof id === 'string').join(', ') : '', parentId: string(task.parentId) || undefined, teamId: string(task.teamId) || undefined,
        plan: [], doneMeans: [], tags: strings(task.tags), workspace: string(task.workspace) || undefined,
        dir: string(task.dir) || undefined, refs: refs(task.refs), tokens: 0, origin: 'hive', people: [],
      }));
      const skid = object(object(native.prereqs).skid);
      const skidKnown = !!string(skid.id);
      const skidReady = skid.installed === true && skid.running === true;
      const prerequisites: Snapshot['prerequisites'] = skidKnown ? [{
        id: string(skid.id), name: string(skid.label, 'Skidbladnir'), level: 'optional',
        state: skidReady ? 'ready' : skid.installed === true ? 'installed-not-running' : 'missing',
        detail: skidReady ? 'Running' : skid.installed === true ? 'Installed, not running' : 'Not installed',
        why: 'Optional local runtime for summarization and memory maintenance. Without it, standard agent work continues through your selected CLI engine.',
        ...(skid.installed === true && !skidReady && string(skid.command) ? { start: string(skid.command) } : {}),
      }] : [];
      // Outside the app (owner 2026-11-12: the .dmg is the only download): the claude CLI runs every
      // agent; MemPalace only adds semantic memory search. Resolved on the login PATH by main.
      const selectedProviders = selectedSignInProviders(object(config), object(native.registry));
      const mutedProviders = mutedSignInProviders(preferences);
      prerequisites.push(...externalTools(object(object(native.prereqs).tools), selectedProviders));
      prerequisites.push(...engineSignIns(object(object(native.prereqs).signIn), selectedProviders, mutedProviders));
      const log: Snapshot['log'] = array(native.log).map((entry, index) => {
        const kind = string(entry.kind, 'event');
        const code = string(entry.code);
        const at = typeof entry.ts === 'number' && Number.isFinite(entry.ts)
          ? new Date(entry.ts).toISOString() : date(entry.ts);
        return {
          id: string(entry.id, string(entry.errorId, `event-${index}`)), at,
          level: /error|fail|drop/i.test(kind) ? 'error' as const : /warn|bounce|degrad/i.test(kind) || string(entry.outcome) === 'archived' ? 'warn' as const : 'info' as const,
          // A note says in words what happened (an agent archived because its folder is gone).
          source: kind, text: [kind, code, string(entry.note)].filter(Boolean).join(' · '),
          correlation: string(entry.cid, string(entry.errorId)),
        };
      });
      const snapshot: Snapshot = {
        usageReported: false,
        archivedAgents: array(native.archivedAgents).map((agent) => ({ id: string(agent.id), name: string(agent.name, string(agent.id)) })),
        settings: Object.fromEntries(['codexRemoteControl', 'codexExecutionPolicy', 'defaultModel', 'godProvider', 'orchestratorMaySpawn', 'semanticMemory', 'embeddingModel', 'reflectEnabled', 'maxTurns', 'costCapTokens', 'costCapUsd', 'agentTokenCaps', 'circuitBreaker', 'providerBaseUrls', 'providerDefaultModels', 'responseStyleBrief', 'claudeOutputStyle', 'ticketKeyPrefix'].filter((key) => key in config).map((key) => [key, config[key]])),
        floorSetup: floorSetupOf(native.floorSetup), ...(hookSocketOf(native.hookSocket) ? { hookSocket: hookSocketOf(native.hookSocket) } : {}), ...(orchestratorFailureOf(native.orchestratorFailure) ? { orchestratorFailure: orchestratorFailureOf(native.orchestratorFailure) } : {}), ...(typeof native.testLabel === 'string' && native.testLabel ? { testLabel: native.testLabel } : {}), prerequisites, setupDismissed: setupDismissedFor(object(preferences.setup), prerequisites), ...(mutedProviders.size ? { mutedSignInReminders: [...mutedProviders] } : {}), objectives: objectivesOf(preferences.objectives), wins: [],
        me: { name: string(profile.name), email: '', workEmail: string(profile.workEmail), timezone: string(profile.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone),
          connections: array(native.integrations).map((item) => ({ id: string(item.id), name: string(item.label, string(item.id)), detail: string(item.kind), connected: item.enabled === true,
            kind: string(item.kind), baseUrl: string(item.baseUrl), authType: string(item.authType), hasSecret: item.hasSecret === true })),
          notify: [{ id: 'desktop', label: 'Desktop', on: config.notifications === true }], yolo: { on: config.autoMode === true, autoOffHours: null, keepHardRules: true },
          iteration: { speed: 'balanced', heartbeatSec: 0, standupMin: 0, checkpointEverySteps: 0 } },
        agents, chats, messages,
        notifications: messages.filter((message) => message.kind === 'question' && !message.read && !message.answer && !message.dismissed).map((message) => {
          const [first, ...rest] = message.text.split('\n').filter((line) => line.trim());
          return {
            id: message.id, kind: 'question' as const, from: message.from, title: (first ?? '').replace(/\*\*|`/g, '').trim(), body: rest.join('\n'),
            at: message.at, chatId: message.chatId, messageId: message.id, actions: message.options ?? [],
          };
        }),
        cards, board: { columns: boardColumns(object(preferences.board).columns) }, activity: logActivity(native.log, agentIds, nameOf), timelines: [], sources: [], access: {}, engines: [],
        automations: array(native.missions).map((mission) => ({ id: string(mission.id), name: string(mission.label), when: String(mission.intervalMs ?? ''),
          onlyIf: '', then: string(mission.body), onFailure: '', enabled: mission.enabled === true, runs: [], last: '', file: '' })),
        services: [
          { id: 'core', group: 'command-center', name: 'Local core', state: 'ok', detail: 'Snapshot received' },
          orchestratorService(godId, object(registryAgents[godId]), rosterById.get(godId) ?? {}, orchestratorLive, orchestratorFailureOf(native.orchestratorFailure)),
          ...(skidKnown ? [{ id: string(skid.id), group: 'studio' as const, name: string(skid.label, 'Skidbladnir'), state: skidReady ? 'ok' as const : 'warn' as const, detail: skidReady ? 'Running' : skid.installed === true ? 'Installed, not running' : 'Not installed', fix: skidReady ? undefined : 'Open setup' }] : []),
        ], log,
        terminals: agents.filter((agent) => ptyByAgent.has(agent.id)).map((agent) => ({ agentId: agent.id, ptyId: string(ptyByAgent.get(agent.id)?.id), cwd: string(ptyByAgent.get(agent.id)?.cwd), lines: [] })),
        audit: [],
        homeLayout: object(preferences.home),
        chatView: object(preferences.chats),
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
          // card.create's key is the core's to pick; it comes back on the result.
          const wire = command.type === 'card.create' ? (({ key: _key, ...rest }) => rest)(command) : command;
          const result = await bridge.paramountDispatch(wire as ParamountCommand);
          if (isFailure(result)) {
            // The command may have been applied; the snapshot is the only truth now.
            if (result.code === 'UNCERTAIN_STATE') refresh();
            throw BackendError.fromFailure(result, operation);
          }
          if (!result?.ok) throw BackendError.local('INTERNAL', (result as { error?: string } | undefined)?.error || 'The core answered without a result.', operation);
          const card = (result as OkResult).card;
          const event = { ...result.event, command: card && command.type === 'card.create' ? { ...command, key: card.key } : command } as FloorEvent;
          emit(event);
          if (['card.create', 'setup.complete', 'orchestrator.ensure', 'launchers.refresh', 'floor.retry', 'floor.choose-another', 'floor.open', 'floor.picker'].includes(command.type)) refresh();
          return event;
        }
      } catch (cause) {
        throw toBackendError(cause, operation);
      }
      const event: FloorEvent = { id: `local-${Date.now()}`, at: new Date().toISOString(), actor: 'you', command };
      emit(event);
      return event;
    },
    diagnostics(): Promise<ParamountDiagnostics> {
      return query({ type: 'diagnostics.bundle' }, 'diagnostics', 'The core returned no diagnostics bundle.');
    },
    saveDiagnostics(name: string): Promise<ParamountDiagnosticsSave> {
      return query({ type: 'diagnostics.save', name }, 'saved', 'The core did not say whether the file was saved.');
    },
    async saveAgentPreset(manifest: Record<string, unknown>) {
      const bridge = requireBridge();
      if (!bridge.paramountSaveHirePreset) return { canceled: false, error: 'This Paramount core cannot save agent presets.' };
      return bridge.paramountSaveHirePreset(manifest);
    },
    discoverAgents(options = {}): Promise<ParamountAgentDiscovery> {
      return query({ type: 'agents.discover', ...options }, 'discovery', 'The core returned no agent list.');
    },
    importAgent(source, id, projectDir): Promise<ParamountAgentImport> {
      return query({ type: 'agents.import', source, id, ...(projectDir ? { projectDir } : {}) }, 'imported', 'The core returned no import result.');
    },
    openExternal(url) {
      return act({ type: 'shell.openExternal', url });
    },
    openIn(app, path) {
      return act({ type: 'shell.openIn', app, path });
    },
    teamModels(): Promise<ParamountTeamModels> {
      return query({ type: 'team.models' }, 'models', 'The core returned no model list.');
    },
    async startEngineSignIn(provider: 'claude' | 'codex', accountId?: string, accountFingerprint?: string) {
      const result = await requireBridge().startEngineSignIn(provider, accountId, accountFingerprint);
      if (!result.ok || !result.ptyId) throw BackendError.local(result.error?.includes('missing') ? 'UNSUPPORTED' : 'CONFLICT', result.error ?? 'Could not open the selected account login.', 'engine-signin.start');
      return { ptyId: result.ptyId, cwd: result.cwd ?? '' };
    },
    async refreshEngineSignIn(provider: 'claude' | 'codex', accountId?: string, accountFingerprint?: string) {
      const result = await requireBridge().refreshEngineSignIn(provider, accountId, accountFingerprint);
      if (!result.ok || !result.status) throw BackendError.local('CONFLICT', result.error ?? 'Could not refresh this account status.', 'engine-signin.refresh');
      refresh();
      return result.status;
    },
    organization(): Promise<import('./paramount-api').ParamountOrganization> {
      return query({ type: 'team.org.get' }, 'organization', 'The core returned no team organization.');
    },
    saveOrganization(organization): Promise<import('./paramount-api').ParamountOrganization> {
      return query({ type: 'team.org.save', organization }, 'organization', 'The core did not save the team organization.').then((result) => { refresh(); return result; });
    },
    delegate(request): Promise<NonNullable<ParamountTeamResult['delegated']>> {
      return query(request, 'delegated', 'The core did not create delegated tasks.').then((result) => { refresh(); return result; });
    },
    async archiveAgent(id, archived) {
      const bridge = requireBridge();
      if (!bridge.hiveSetArchived) throw BackendError.local('UNSUPPORTED', 'Archive and restore need the desktop agent registry.', 'agent.archive');
      checkOk(await bridge.hiveSetArchived(id, archived), 'agent.archive', 'Could not update archive state.'); refresh();
    },
    async sendNote(id, text) {
      const bridge = requireBridge();
      checkOk(await bridge.hiveSend({ to: id, act: 'inform', subject: 'Note from human', body: text.trim() }, 'human'), 'agent.note', 'Could not send note.'); refresh();
    },
    async hire(manifest, options = {}): Promise<ParamountHirePlan> {
      const plan = await query({ type: 'agent.hire', manifest, ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.confirm ? { confirm: true } : {}), ...(options.orchestrator ? { orchestrator: true } : {}), ...(options.launcher !== undefined ? { launcher: options.launcher } : {}) }, 'hire', 'The core returned no hire plan.');
      if (plan.confirmed) refresh();
      return plan;
    },
    artifacts(agentId): Promise<ParamountArtifactMap> {
      return query({ type: 'terminal.artifacts', agentId }, 'artifacts', 'The core returned no artifact map.');
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


