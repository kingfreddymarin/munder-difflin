import { resolveAgentModel } from './paramount-models';
import { discoverLaunchers, publicDiscovery, launcherDisplayCommand, validateLauncher, readLauncherState, displayLauncherState, runtimeLauncher, saveLauncherPick, type LauncherPick, launcherForProvider, launcherProvider } from './council-account-launchers';
// Paramount Team screen commands (lane d-team): new cards, per-agent models and
// the Add-Agent hire form. dispatchParamount hands these over in one line; every
// failure goes through the same span, so it carries an errorId and a code.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ParamountCommand, ParamountErrorCode, ParamountEvent, ParamountHirePlan, ParamountResult, ParamountTeamModels, ParamountTeamResult } from '../preload/paramount';
import type { Span } from './paramountObservability';
import { validateHireManifest, type HireManifest } from '../shared/hire';
import { AGENT_PROVIDER_PRESETS, normalizeAgentProvider } from '../shared/agentProvider';
import type { CatalogModel, ModelCatalog } from '../shared/modelCatalogPayload';
import { isNewer } from '../shared/updateState';
import { redact } from './paramountObservability';
import { buildWorkerLaunch } from './workerLaunch';

/** What a confirmed hire hands to main, which owns the PTY layer. */
export interface TeamSpawn {
  plan: ParamountHirePlan;
  bin: string;
  args: string[];
  provider: string;
  goal?: string;
  tokenCap?: number;
  capabilities?: string[];
  isGod?: boolean;
  resume?: boolean;
  launcher?: LauncherPick | null;
}

export interface ParamountTeamDeps {
  /** The cached launcher discovery (never runs a shell after the first read). */
  launcherDiscovery?(): ReturnType<typeof discoverLaunchers>;
  /** Reruns discovery: only the setup screen and "Refresh launchers" ask for it. */
  refreshLaunchers?(): void;
  /** Takes or keeps the floor's runtime lock; false while another live process
   *  (a second Council or Munder) runs this floor, so it keeps the orchestrator. */
  claimFloor?(): boolean;
  /** The hive directory, where per-agent model picks are stored; null = hive off. */
  hiveRoot(): string | null;
  addTask(task: { id: string; title: string; description?: string; assignee?: string; status: 'todo' | 'blocked';
    dependsOn: string[]; priority: number; createdAt: string }): boolean;
  /** The model catalog the pickers use (remote copy when cached, else the baked one). */
  modelCatalog(): ModelCatalog;
  appVersion: string;
  /** config.defaultModel. */
  defaultModel(): string | undefined;
  setupComplete?(): boolean;
  orchestratorProvider(): string | undefined;
  orchestratorModel(): string | undefined;
  orchestratorId(): string | undefined;
  /** The last failed orchestrator start (main's exit watch); automatic startup does not retry it. */
  orchestratorStartFailure?(): { message: string } | null;
  hasLivePty(agentId: string): boolean;
  ticketKeyPrefix?(): string | undefined;
  /** config.defaultCommand, the fallback engine command. */
  defaultCommand(): string | undefined;
  autoMode(): boolean;
  /** Where a hire starts when the form names no folder. */
  defaultCwd(orchestrator?: boolean): string | null;
  isDirectory(path: string): boolean;
  commandAvailable(bin: string): boolean;
  spawnHire(spawn: TeamSpawn, cid: string): Promise<{ ok: boolean; error?: string }>;
}

/** The slice of ParamountDeps the team module uses. */
interface Deps {
  tasks(): { tasks?: Array<{ id: string }> };
  agents(): Record<string, unknown>;
  appendEvent(event: ParamountEvent): void;
  publish(event: ParamountEvent): void;
  logStep?(step: Record<string, unknown>): void;
  team?: ParamountTeamDeps;
}

const TEAM_TYPES = new Set(['card.create', 'team.models', 'agent.hire', 'launchers.configure', 'launchers.refresh', 'orchestrator.ensure']);
const MODELS_FILE = 'paramount-agent-models.json';
// IPC creates a new adapter per request. Keep reservations by hive so two
// windows cannot both pass the registry check while ensureAgent is awaiting IO.
const pendingOrchestrators = new Set<string>();
const OTHER_RUNTIME = 'Another Council or Munder process runs this floor, so the orchestrator stays with it. Close that app, then start the orchestrator here.';
// Reconcile success against current PTYs; only in-flight work and failures latch.
// One initial automatic launch plus one recovery per floor/process, reset by an
// explicit successful hire. Remounts can never become an unbounded retry loop.
const automaticOrchestrators = new Map<string, { inFlight?: Promise<ParamountResult>; failure?: ParamountResult; starts: number }>();

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function onlyKeys(command: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(command).every((key) => allowed.includes(key));
}

/** True when this command belongs to the team module. agent.update is ours only for a model change. */
/** The engine an orchestrator starts on. A registered one keeps the provider, model, name and
 *  role it was recorded with (its session id stays in the registry and resumes on that
 *  provider); the floor's setting applies only to a new orchestrator. Incident 2026-11-12:
 *  Council restarted a claude god as gemini (the floor setting), the resume failed and the
 *  entry was rewritten to provider gemini, role "Paramount orchestrator". */
export function orchestratorEngine(team: Pick<ParamountTeamDeps, 'orchestratorProvider' | 'orchestratorModel' | 'hiveRoot'>, raw: unknown, id: string | undefined): { provider: ReturnType<typeof normalizeAgentProvider>; model?: string; name?: string; role?: string } {
  const configured = normalizeAgentProvider(team.orchestratorProvider());
  const recorded = object(raw) && typeof raw.provider === 'string' ? normalizeAgentProvider(raw.provider) : undefined;
  if (!object(raw) || !id) return { provider: configured, model: team.orchestratorModel() };
  // A recorded entry without a provider is a legacy claude agent (AgentMeta's default).
  const provider = recorded ?? (raw.provider === undefined ? 'claude' : undefined);
  let picked: string | undefined;
  try { picked = agentModelPick(team.hiveRoot(), id); } catch { picked = undefined; }
  const model = picked ?? (provider === configured ? team.orchestratorModel() : undefined);
  return {
    provider, ...(model ? { model } : {}),
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
    ...(typeof raw.role === 'string' && raw.role.trim() ? { role: raw.role } : {}),
  };
}

/** An engine's display name ("Claude Code"), or its id when the catalog does not list it. */
function engineLabel(engines: Array<{ id: string; label: string }>, id: string): string {
  return engines.find((e) => e.id === id)?.label ?? id;
}
/** The orchestrator this floor starts: the registered god when there is one (its recorded engine,
 *  model, name and role), else the configured engine for a NEW orchestrator. The one source the
 *  hire sheet, Settings, orchestrator.ensure and agent.hire all use (owner run of ceeb4aaf: the
 *  sheet used the configured codex while the backend kept the registered claude god). */
export function currentOrchestrator(team: Pick<ParamountTeamDeps, 'orchestratorProvider' | 'orchestratorModel' | 'hiveRoot' | 'orchestratorId'>, agents: Record<string, unknown>): { id?: string; provider: ReturnType<typeof normalizeAgentProvider>; model?: string } {
  const id = team.orchestratorId() ?? Object.entries(agents).find(([, a]) => object(a) && a.isGod === true)?.[0];
  const engine = orchestratorEngine(team, id ? agents[id] : undefined, id);
  return { ...(id ? { id } : {}), provider: engine.provider, ...(engine.model ? { model: engine.model } : {}) };
}

export function isTeamCommand(command: Record<string, unknown>): boolean {
  if (TEAM_TYPES.has(command.type as string)) return true;
  return command.type === 'agent.update' && object(command.patch) && Object.hasOwn(command.patch, 'model');
}

// ── Per-agent model picks ──────────────────────────────────────────────────

type Picks = Record<string, { engine: string; model?: string }>;

/** Picks saved by Paramount. Throws when the file is unreadable, so a corrupt
 *  file is reported instead of silently resetting every agent to the default. */
export function readAgentModels(root: string | null): Picks {
  if (!root) return {};
  const path = join(root, MODELS_FILE);
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!object(parsed) || !object(parsed.agents)) throw new Error(`${MODELS_FILE} is corrupt`);
  const out: Picks = {};
  for (const [id, pick] of Object.entries(parsed.agents)) {
    if (object(pick) && typeof pick.engine === 'string') out[id] = { engine: pick.engine, ...(typeof pick.model === 'string' && pick.model ? { model: pick.model } : {}) };
  }
  return out;
}

/** The model to pass with --model when this agent next starts, if one was picked. */
export function agentModelPick(root: string | null, agentId: string): string | undefined {
  return readAgentModels(root)[agentId]?.model;
}

function writeAgentModels(root: string, picks: Picks): void {
  const path = join(root, MODELS_FILE);
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, agents: picks }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

function offered(model: CatalogModel, appVersion: string): boolean {
  if (model.minAppVersion && appVersion && isNewer(model.minAppVersion, appVersion)) return false;
  if (model.maxAppVersion && appVersion && isNewer(appVersion, model.maxAppVersion)) return false;
  return true;
}

/** Engines that take a --model flag, with the catalog entries this build offers. */
export function teamModels(catalog: ModelCatalog, appVersion: string): ParamountTeamModels['engines'] {
  return AGENT_PROVIDER_PRESETS.filter((preset) => preset.supportsModel).map((preset) => ({
    id: preset.id,
    label: preset.label,
    models: (catalog.providers[preset.id] ?? []).filter((m) => offered(m, appVersion))
      .map((m) => (m.id === undefined ? { label: m.label } : { id: m.id, label: m.label })),
  })).filter((engine) => engine.models.length > 0);
}

// ── Cards ──────────────────────────────────────────────────────────────────

/** Next key on the ledger's most used `PREFIX-n` scheme; `P-1` on an empty ledger. */
export function nextCardKey(ids: string[], selectedPrefix?: string): string {
  if (selectedPrefix) {
    const numbers = ids.map((id) => new RegExp(`^${selectedPrefix}-(\\d+)$`).exec(id)).filter((match): match is RegExpExecArray => !!match).map((match) => Number(match[1]));
    return `${selectedPrefix}-${Math.max(0, ...numbers) + 1}`;
  }
  const counts = new Map<string, { n: number; max: number }>();
  for (const id of ids) {
    const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(id);
    if (!m) continue;
    const entry = counts.get(m[1]) ?? { n: 0, max: 0 };
    entry.n += 1;
    entry.max = Math.max(entry.max, Number(m[2]));
    counts.set(m[1], entry);
  }
  let best: [string, { n: number; max: number }] | undefined;
  for (const entry of counts) if (!best || entry[1].n > best[1].n) best = entry;
  if (!best) return 'P-1';
  let next = best[1].max + 1;
  while (ids.includes(`${best[0]}-${next}`)) next += 1;
  return `${best[0]}-${next}`;
}

// ── Hire ───────────────────────────────────────────────────────────────────

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
}

/** Ids already used in the registry, archived ones included, are never reused. */
export function uniqueAgentId(name: string, taken: string[]): string {
  const base = slug(name);
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

const IGNORED_FIELDS = ['skills', 'mcpServers', 'character', 'accent', 'author', 'homepage'] as const;

// ── Dispatch ───────────────────────────────────────────────────────────────

/** Handles a team command, or returns null when the command is not one. */
export function dispatchTeam(command: Record<string, unknown>, deps: Deps, span: Span): ParamountResult | Promise<ParamountResult> | null {
  if (!isTeamCommand(command)) return null;
  const commandType = String(command.type);
  const fail = (code: ParamountErrorCode, message: string, cause?: unknown): ParamountResult => span.fail(code, message, cause, { commandType });
  const team = deps.team;
  if (!team) return fail('UNSUPPORTED', `${commandType} is not available in this build`);
  const done = (payload: Omit<ParamountTeamResult, 'ok' | 'event'>): ParamountResult => {
    const event: ParamountEvent = { id: randomUUID(), at: new Date().toISOString(), actor: 'you', command: command as unknown as ParamountCommand, correlationId: span.cid };
    deps.appendEvent(event);
    deps.publish(event);
    return { ok: true, event, ...payload } as ParamountResult;
  };
  let writeAttempted = false;
  const failCaught = (error: unknown): ParamountResult => {
    const message = error instanceof Error ? error.message : 'Command failed';
    return writeAttempted
      ? fail('UNCERTAIN_STATE', `Command may have been applied; refresh the snapshot before retrying: ${message}`, error)
      : fail('INTERNAL', message, error);
  };
  try {
    switch (commandType) {
      case 'orchestrator.ensure': {
        if (!onlyKeys(command, ['type'])) return fail('INVALID_INPUT', 'orchestrator.ensure takes no fields');
        if (!team.setupComplete?.() || !team.hiveRoot()) return fail('CONFLICT', 'Finish floor setup before starting the orchestrator');
        const root = team.hiveRoot()!;
        const state = automaticOrchestrators.get(root) ?? { starts: 0 };
        automaticOrchestrators.set(root, state);
        if (state.inFlight) return state.inFlight;
        const agentsNow = deps.agents();
        const liveId = team.orchestratorId() ?? Object.entries(agentsNow).find(([, a]) => object(a) && a.isGod === true)?.[0];
        if (liveId && team.hasLivePty(liveId)) { state.failure = undefined; return done({}); }
        // Not latched and not counted: once the other process quits, the next ensure starts it.
        if (team.claimFloor && !team.claimFloor()) return fail('CONFLICT', OTHER_RUNTIME);
        // The same failure again, with its own error id (each attempt is its own diagnostic).
        if (state.failure && !state.failure.ok) return fail(state.failure.code, state.failure.message);
        const startFailure = team.orchestratorStartFailure?.();
        if (startFailure) return fail('CONFLICT', startFailure.message);
        if (state.starts >= 2) {
          state.failure = fail('CONFLICT', 'The orchestrator stopped after bounded automatic recovery. Open Team and explicitly start it again.');
          return state.failure;
        }
        const step = (stage: string) => {
          try { deps.logStep?.({ kind: 'paramount-orchestrator', cid: span.cid, step: stage }); } catch { /* diagnostics cannot block startup */ }
        };
        // Defer all readiness checks until AFTER reserving the attempt.
        const attempt = Promise.resolve().then(async (): Promise<ParamountResult> => {
          step('setup-ready');
          const agents = deps.agents();
          const registered = team.orchestratorId() ?? Object.entries(agents).find(([, a]) => object(a) && a.isGod === true)?.[0];
          if (registered && team.hasLivePty(registered)) { step('already-running'); return done({}); }
          step('readiness-check');
          const engine = orchestratorEngine(team, registered ? agents[registered] : undefined, registered);
          const provider = engine.provider;
          const preset = AGENT_PROVIDER_PRESETS.find((p) => p.id === provider);
          if (!preset?.supportsModel || !preset.canReceiveInbox) return fail('INVALID_INPUT', 'The configured orchestrator engine is unsupported. Correct the floor engine configuration and reopen this floor');
          const model = resolveAgentModel(provider!, [engine.model], (id) => teamModels(team.modelCatalog(), team.appVersion).find((e) => e.id === id)?.models.flatMap((m) => m.id ? [m.id] : []) ?? []);
          const raw = registered ? agents[registered] : undefined;
          const name = object(raw) && typeof raw.name === 'string' ? raw.name : 'Paramount';
          step('launch-requested');
          state.starts++;
          // Reuse provisioning, executable checks, per-hive reservation, resume,
          // failed-registration rollback and the main-owned guarded inbox wake.
          return await dispatchTeam({ type: 'agent.hire', orchestrator: true, confirm: true,
            manifest: { spec: 'munder-difflin/hire@1', name, ...(model ? { model } : {}) }
          }, { ...deps, logStep: (event) => {
            try { deps.logStep?.(redact(event) as Record<string, unknown>); } catch { /* diagnostics are optional */ }
          } }, span)!;
        }).catch(failCaught).then((result) => {
          step(result.ok ? 'launch-accepted' : 'startup-failed');
          if (!result.ok) state.failure = result;
          state.inFlight = undefined;
          return result;
        });
        state.inFlight = attempt;
        return attempt;
      }
      case 'card.create': {
        if (!onlyKeys(command, ['type', 'title', 'description', 'assignee', 'priority', 'status'])) return fail('INVALID_INPUT', 'card.create accepts title, description, assignee, priority and status');
        const title = typeof command.title === 'string' ? command.title.trim() : '';
        if (!title || title.length > 200 || /[\r\n\0]/.test(title)) return fail('INVALID_INPUT', 'A card needs a one-line title of at most 200 characters');
        if (command.description !== undefined && (typeof command.description !== 'string' || command.description.length > 10_000)) return fail('INVALID_INPUT', 'description must be text of at most 10000 characters');
        if (command.priority !== undefined && ![1, 2, 3].includes(command.priority as number)) return fail('INVALID_INPUT', 'priority is 1, 2 or 3');
        if (command.status !== undefined && command.status !== 'todo' && command.status !== 'blocked') return fail('INVALID_INPUT', 'A new card starts in todo or blocked');
        const assignee = command.assignee;
        if (assignee !== undefined && (typeof assignee !== 'string' || !Object.hasOwn(deps.agents(), assignee))) return fail('NOT_FOUND', 'Assignee is not an agent on this floor');
        const key = nextCardKey((deps.tasks().tasks ?? []).map((t) => t.id), team.ticketKeyPrefix?.());
        const description = typeof command.description === 'string' && command.description.trim() ? command.description.trim() : undefined;
        writeAttempted = true;
        const added = team.addTask({
          id: key, title, ...(description ? { description } : {}), ...(assignee ? { assignee: assignee as string } : {}),
          status: (command.status as 'todo' | 'blocked' | undefined) ?? 'todo', dependsOn: [], priority: (command.priority as number | undefined) ?? 2,
          createdAt: new Date().toISOString(),
        });
        if (!added) return fail('CONFLICT', `Card ${key} was created by someone else a moment ago; retry`);
        return done({ card: { key } });
      }
      case 'launchers.refresh': {
        if (!onlyKeys(command, ['type'])) return fail('INVALID_INPUT', 'launchers.refresh takes no fields');
        team.refreshLaunchers?.();
        return done({});
      }
      case 'launchers.configure': {
        if (!onlyKeys(command, ['type', 'scope', 'agentId', 'provider', 'launcher'])) return fail('INVALID_INPUT', 'Invalid launcher settings');
        const root = team.hiveRoot();
        if (!root) return fail('UNSUPPORTED', 'Enable the Hive to save an account launcher');
        if (!['orchestrator', 'temps', 'agent', 'default'].includes(command.scope as string)) return fail('INVALID_INPUT', 'Invalid launcher scope');
        if (command.scope === 'default' && !['claude', 'codex'].includes(command.provider as string)) return fail('INVALID_INPUT', 'Choose Claude or Codex for the default launcher');
        const id = command.agentId;
        const raw = typeof id === 'string' ? deps.agents()[id] : undefined;
        if (command.scope === 'agent' && !object(raw)) return fail('NOT_FOUND', 'Agent not found');
        if (command.launcher !== null) {
          const provider = command.scope === 'default' ? String(command.provider ?? '') : command.scope === 'agent' && object(raw) ? String(raw.provider ?? 'claude') : command.scope === 'orchestrator' ? currentOrchestrator(team, deps.agents()).provider ?? 'claude' : publicDiscovery(team.launcherDiscovery?.()).choices.find((c) => c.id === (command.launcher as LauncherPick)?.id)?.provider ?? '';
          try { validateLauncher(command.launcher, provider, team.launcherDiscovery?.()); } catch (e) { return fail('INVALID_INPUT', e instanceof Error ? e.message : 'Invalid launcher'); }
        }
        writeAttempted = true;
        // A changed launcher can be what an automatic start failed on: let the next ensure try again.
        automaticOrchestrators.delete(root);
        saveLauncherPick(root, command.scope === 'agent' && (object(raw) && raw.isGod === true || id === team.orchestratorId()) ? 'orchestrator' : command.scope as 'orchestrator' | 'temps' | 'agent' | 'default', command.launcher as LauncherPick | null, command.scope === 'default' ? String(command.provider ?? '') : typeof id === 'string' ? id : undefined);
        return done({});
      }
      case 'team.models': {
        if (!onlyKeys(command, ['type'])) return fail('INVALID_INPUT', 'team.models takes no fields');
        const engines = teamModels(team.modelCatalog(), team.appVersion);
        const picks = readAgentModels(team.hiveRoot());
        const registry = deps.agents();
        const agents: ParamountTeamModels['agents'] = {};
        for (const [id, raw] of Object.entries(registry)) {
          const engine = object(raw) && typeof raw.provider === 'string' ? raw.provider : 'claude';
          agents[id] = picks[id] && picks[id].engine === engine ? picks[id] : { engine };
        }
        let launchers = publicDiscovery(team.launcherDiscovery?.());
        let launcherState;
        try { launcherState = displayLauncherState(readLauncherState(team.hiveRoot())); }
        catch { launchers = { status: 'failed', choices: [], message: 'Council launcher settings are unreadable or unsupported. Provider defaults remain available; repair the extension file before restoring saved selections.' }; }
        const current = currentOrchestrator(team, registry);
        const orchestratorProvider = current.provider ?? 'claude';
        const orchestratorModel = resolveAgentModel(orchestratorProvider, [current.model], (engine) => engines.find((e) => e.id === engine)?.models.flatMap((m) => m.id ? [m.id] : []) ?? []);
        const configured = team.orchestratorProvider() ?? 'claude';
        let orchestratorLauncherNote: string | undefined;
        try {
          const saved = readLauncherState(team.hiveRoot()).orchestrator;
          const runs = launcherProvider(saved, team.launcherDiscovery?.());
          if (saved && runs && runs !== orchestratorProvider) orchestratorLauncherNote = `The saved orchestrator launcher ${saved.id} runs ${engineLabel(engines, runs)}, but this floor's orchestrator runs ${engineLabel(engines, orchestratorProvider)}. It is ignored and ${engineLabel(engines, orchestratorProvider)}'s default account is used; choose a ${engineLabel(engines, orchestratorProvider)} launcher or Provider default to clear this.`;
        } catch { /* reported through launchers above */ }
        return done({ models: {
          engines,
          launchers,
          ...(launcherState ? { launcherState } : {}),
          ...(team.defaultModel() ? { defaultModel: team.defaultModel() } : {}),
          ...(team.orchestratorId() ? { orchestratorId: team.orchestratorId() } : {}),
          orchestratorProvider,
          ...(configured !== orchestratorProvider ? { orchestratorConfiguredProvider: configured } : {}),
          ...(orchestratorModel ? { orchestratorModel } : {}),
          ...(orchestratorLauncherNote ? { orchestratorLauncherNote } : {}),
          agents
        } });
      }
      case 'agent.update': {
        const agentId = command.agentId;
        const patch = command.patch as Record<string, unknown>;
        if (typeof agentId !== 'string' || !Object.hasOwn(deps.agents(), agentId)) return fail('NOT_FOUND', 'Agent not found');
        if (!onlyKeys(patch, ['model', 'engine'])) return fail('INVALID_INPUT', 'Change the model on its own; save other fields separately');
        const raw = deps.agents()[agentId];
        const current = object(raw) && typeof raw.provider === 'string' ? raw.provider : 'claude';
        if (patch.engine !== undefined && patch.engine !== current) {
          return fail('UNSUPPORTED', `This agent runs on ${current}; moving it to another engine means hiring it again on that engine`);
        }
        if (typeof patch.model !== 'string') return fail('INVALID_INPUT', 'model must be a model id, or empty for the default');
        const root = team.hiveRoot();
        if (!root) return fail('UNSUPPORTED', 'The hive is off (no harness home), so a model pick cannot be saved');
        const model = patch.model.trim();
        if (model) {
          const engine = teamModels(team.modelCatalog(), team.appVersion).find((e) => e.id === current);
          if (!engine) return fail('UNSUPPORTED', `${current} takes no model choice`);
          if (!engine.models.some((m) => m.id === model)) return fail('INVALID_INPUT', `${model} is not a ${engine.label} model this build offers`);
        }
        const picks = readAgentModels(root);
        if (model) picks[agentId] = { engine: current, model };
        else delete picks[agentId];
        writeAttempted = true;
        writeAgentModels(root, picks);
        return done({});
      }
      case 'agent.hire': {
        if (!onlyKeys(command, ['type', 'manifest', 'cwd', 'confirm', 'orchestrator', 'launcher'])) return fail('INVALID_INPUT', 'agent.hire accepts manifest, cwd, confirm and orchestrator');
        if (command.confirm !== undefined && typeof command.confirm !== 'boolean') return fail('INVALID_INPUT', 'confirm must be a boolean');
        if (command.orchestrator !== undefined && typeof command.orchestrator !== 'boolean') return fail('INVALID_INPUT', 'orchestrator must be a boolean');
        const isGod = command.orchestrator === true;
        const orchestratorRoot = isGod ? team.hiveRoot() : null;
        if (isGod && !orchestratorRoot) return fail('UNSUPPORTED', 'Enable the Hive before starting the Paramount orchestrator.');
        if (orchestratorRoot && pendingOrchestrators.has(orchestratorRoot)) {
          return fail('CONFLICT', 'A Paramount orchestrator is already starting. Wait for its Team and Terminal entry.');
        }
        const agents = deps.agents();
        const registeredGod = isGod ? team.orchestratorId()
          ?? Object.entries(agents).find(([, agent]) => object(agent) && agent.isGod === true)?.[0] : undefined;
        if (registeredGod && team.hasLivePty(registeredGod)) {
          return fail('CONFLICT', 'A Paramount orchestrator is already registered. Use its existing Team and Terminal entry.');
        }
        const check = validateHireManifest(command.manifest);
        if (!check.ok || !check.manifest) return fail('INVALID_INPUT', `The hire form is not valid: ${check.errors.join('; ')}`);
        const manifest: HireManifest = check.manifest;
        const cwd = typeof command.cwd === 'string' && command.cwd.trim() ? command.cwd.trim() : team.defaultCwd(isGod);
        if (!cwd) return fail('INVALID_INPUT', 'This floor is not open in this app, so an empty folder has no floor root to use. Choose the folder the agent works in');
        if (!isAbsolute(cwd) || cwd.length > 4096 || !team.isDirectory(cwd)) return fail('INVALID_INPUT', `Folder not found: ${cwd}`);
        const recorded = isGod ? orchestratorEngine(team, registeredGod ? agents[registeredGod] : undefined, registeredGod) : undefined;
        // A new orchestrator falls back to claude as before; a registered one is never switched.
        if (recorded && registeredGod && !recorded.provider) return fail('INVALID_INPUT', `The registered orchestrator "${registeredGod}" runs on an engine this app cannot start; it was left unchanged`);
        const provider = recorded
          ? recorded.provider ?? 'claude'
          : normalizeAgentProvider(manifest.provider) ?? 'claude';
        const offered = (engine: string) => teamModels(team.modelCatalog(), team.appVersion).find((e) => e.id === engine)?.models.flatMap((m) => m.id ? [m.id] : []) ?? [];
        const rawFlags = manifest.commandFlags ?? [];
        const flags: string[] = [];
        let flagModel: string | undefined;
        for (let i = 0; i < rawFlags.length; i++) {
          const flag = rawFlags[i];
          if (flag === '--model' || flag.startsWith('--model=')) {
            if (flagModel !== undefined) return fail('INVALID_INPUT', 'Choose one model');
            flagModel = flag === '--model' ? rawFlags[++i] : flag.slice('--model='.length);
            if (!flagModel || !resolveAgentModel(provider, [flagModel], offered)) return fail('INVALID_INPUT', 'Pick a model supported by this provider');
          } else flags.push(flag);
        }
        if (flagModel && manifest.model && flagModel !== manifest.model) return fail('INVALID_INPUT', 'Pick one model supported by this provider');
        const engines = teamModels(team.modelCatalog(), team.appVersion);
        const notes: string[] = [];
        // The orchestrator's model comes from saved settings: one for another engine falls back to this
        // engine's default (owner run of ceeb4aaf: a Codex model sent for the Claude god failed every
        // start). For any other hire an explicit cross-engine model is still refused (review row 16).
        if (!isGod && manifest.model && !resolveAgentModel(provider, [manifest.model], offered)) return fail('INVALID_INPUT', 'Pick one model supported by this provider');
        const manifestModel = manifest.model && !resolveAgentModel(provider, [manifest.model], offered) ? undefined : manifest.model;
        if (manifest.model && !manifestModel) notes.push(`${manifest.model} is not a ${engineLabel(engines, provider)} model; ${engineLabel(engines, provider)}'s default is used.`);
        const model = resolveAgentModel(provider, [flagModel, manifestModel, recorded ? recorded.model : team.defaultModel()], offered);
        let launcherPick: LauncherPick | null | undefined;
        let profile;
        try {
          const discovery = team.launcherDiscovery?.();
          const wanted = command.launcher === undefined ? runtimeLauncher(team.hiveRoot(), undefined, isGod, false, undefined, provider, true) : command.launcher as LauncherPick | null;
          // A launcher for another engine (saved, or preselected by the form) is ignored with a note.
          const fitted = wanted === undefined ? undefined : launcherForProvider(team.hiveRoot(), wanted, provider, discovery, !isGod);
          if (fitted?.ignored) notes.push(`Launcher ${fitted.ignored.id} runs ${engineLabel(engines, fitted.ignored.provider)}, not ${engineLabel(engines, provider)}; ${fitted.pick ? `${engineLabel(engines, provider)}'s default launcher ${fitted.pick.id}` : `${engineLabel(engines, provider)}'s default account`} is used.`);
          launcherPick = fitted === undefined ? undefined : fitted.pick;
          if (launcherPick !== undefined && launcherPick !== null) profile = validateLauncher(launcherPick, provider, discovery); }
        catch (e) { return fail('INVALID_INPUT', e instanceof Error ? e.message : 'Invalid launcher'); }
        if (profile && model && !teamModels(team.modelCatalog(), team.appVersion).find((e) => e.id === provider)?.models.some((m) => m.id === model)) return fail('INVALID_INPUT', 'Pick a model supported by this provider');
        if (profile && rawFlags.length) return fail('INVALID_INPUT', 'Account launcher hires do not accept extra command flags');
        const launch = buildWorkerLaunch({
          requestProvider: provider,
          requestModel: model,
          defaultCommand: team.defaultCommand(),
          autoMode: team.autoMode(),
        });
        const args = [...launch.args, ...flags];
        if (isGod && !registeredGod && Object.hasOwn(agents, 'god')) return fail('CONFLICT', 'The reserved god agent id is already in use; inspect the Hive registry before starting another orchestrator.');
        const agentId = isGod ? registeredGod ?? 'god' : uniqueAgentId(manifest.name, Object.keys(agents));
        const isolate = manifest.isolate === true;
        const plan: ParamountHirePlan = {
          agentId, name: recorded?.name ?? manifest.name, ...(recorded ? { role: recorded.role ?? 'Paramount orchestrator' } : manifest.description ? { role: manifest.description } : {}),
          engine: provider, ...(model ? { model } : {}), cwd, isolate,
          ...(profile ? { launcher: profile.label } : {}),
          command: profile ? launcherDisplayCommand([profile.bin, ...profile.args, ...args].join(' ')) : [launch.bin, ...args].join(' '), engineInstalled: team.commandAvailable(profile?.bin ?? launch.bin),
          confirmed: command.confirm === true, consentRequired: check.consentRequired ?? [],
          ignored: IGNORED_FIELDS.filter((f) => manifest[f] !== undefined && !(Array.isArray(manifest[f]) && (manifest[f] as unknown[]).length === 0)),
          ...(notes.length ? { notes } : {}),
        };
        deps.logStep?.({ kind: 'paramount-hire', cid: span.cid, step: plan.confirmed ? 'confirmed' : 'plan', agentId, engine: provider, command: plan.command, cwd });
        if (!plan.confirmed) return done({ hire: plan });
        if (!plan.engineInstalled) return fail('UNSUPPORTED', `${launch.bin} is not installed on this machine; install it from Health, then hire again`);
        if (isGod && team.claimFloor && !team.claimFloor()) return fail('CONFLICT', OTHER_RUNTIME);
        writeAttempted = true;
        if (orchestratorRoot) pendingOrchestrators.add(orchestratorRoot);
        return Promise.resolve().then(() => team.spawnHire({
          plan, bin: launch.bin, args, provider, launcher: launcherPick ?? null,
          ...(manifest.goal ? { goal: manifest.goal } : {}), ...(manifest.tokenCap ? { tokenCap: manifest.tokenCap } : {}), ...(isGod ? { isGod: true } : {}),
          ...(isGod ? { resume: true } : {}),
          ...(manifest.capabilities ? { capabilities: manifest.capabilities } : {}),
        }, span.cid)).then((started) => {
          deps.logStep?.({ kind: 'paramount-hire', cid: span.cid, step: started.ok ? 'spawned' : 'spawn-failed', agentId, error: started.error });
          if (started.ok && isGod && orchestratorRoot && !automaticOrchestrators.get(orchestratorRoot)?.inFlight) automaticOrchestrators.delete(orchestratorRoot);
          if (!started.ok) { writeAttempted = false; return fail('INTERNAL', `Could not start ${plan.name}: ${started.error ?? 'unknown error'}`); }
          return done({ hire: plan });
        }, failCaught).finally(() => {
          if (orchestratorRoot) pendingOrchestrators.delete(orchestratorRoot);
        });
      }
    }
    return fail('INVALID_COMMAND', `${commandType} is unknown`);
  } catch (error) {
    return failCaught(error);
  }
}
