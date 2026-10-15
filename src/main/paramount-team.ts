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
}

export interface ParamountTeamDeps {
  /** The hive directory, where per-agent model picks are stored; null = hive off. */
  hiveRoot(): string | null;
  addTask(task: { id: string; title: string; description?: string; assignee?: string; status: 'todo' | 'blocked';
    dependsOn: string[]; priority: number; createdAt: string }): boolean;
  /** The model catalog the pickers use (remote copy when cached, else the baked one). */
  modelCatalog(): ModelCatalog;
  appVersion: string;
  /** config.defaultModel. */
  defaultModel(): string | undefined;
  /** config.defaultCommand, the fallback engine command. */
  defaultCommand(): string | undefined;
  autoMode(): boolean;
  /** Where a hire starts when the form names no folder. */
  defaultCwd(): string | null;
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

const TEAM_TYPES = new Set(['card.create', 'team.models', 'agent.hire']);
const MODELS_FILE = 'paramount-agent-models.json';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function onlyKeys(command: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(command).every((key) => allowed.includes(key));
}

/** True when this command belongs to the team module. agent.update is ours only for a model change. */
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
export function nextCardKey(ids: string[]): string {
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
      case 'card.create': {
        if (!onlyKeys(command, ['type', 'title', 'description', 'assignee', 'priority', 'status'])) return fail('INVALID_INPUT', 'card.create accepts title, description, assignee, priority and status');
        const title = typeof command.title === 'string' ? command.title.trim() : '';
        if (!title || title.length > 200 || /[\r\n\0]/.test(title)) return fail('INVALID_INPUT', 'A card needs a one-line title of at most 200 characters');
        if (command.description !== undefined && (typeof command.description !== 'string' || command.description.length > 10_000)) return fail('INVALID_INPUT', 'description must be text of at most 10000 characters');
        if (command.priority !== undefined && ![1, 2, 3].includes(command.priority as number)) return fail('INVALID_INPUT', 'priority is 1, 2 or 3');
        if (command.status !== undefined && command.status !== 'todo' && command.status !== 'blocked') return fail('INVALID_INPUT', 'A new card starts in todo or blocked');
        const assignee = command.assignee;
        if (assignee !== undefined && (typeof assignee !== 'string' || !Object.hasOwn(deps.agents(), assignee))) return fail('NOT_FOUND', 'Assignee is not an agent on this floor');
        const key = nextCardKey((deps.tasks().tasks ?? []).map((t) => t.id));
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
        return done({ models: { engines, ...(team.defaultModel() ? { defaultModel: team.defaultModel() } : {}), agents } });
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
        if (!onlyKeys(command, ['type', 'manifest', 'cwd', 'confirm'])) return fail('INVALID_INPUT', 'agent.hire accepts manifest, cwd and confirm');
        if (command.confirm !== undefined && typeof command.confirm !== 'boolean') return fail('INVALID_INPUT', 'confirm must be a boolean');
        const check = validateHireManifest(command.manifest);
        if (!check.ok || !check.manifest) return fail('INVALID_INPUT', `The hire form is not valid: ${check.errors.join('; ')}`);
        const manifest: HireManifest = check.manifest;
        const cwd = typeof command.cwd === 'string' && command.cwd.trim() ? command.cwd.trim() : team.defaultCwd();
        if (!cwd) return fail('INVALID_INPUT', 'Choose the folder the agent works in');
        if (!isAbsolute(cwd) || cwd.length > 4096 || !team.isDirectory(cwd)) return fail('INVALID_INPUT', `Folder not found: ${cwd}`);
        const provider = normalizeAgentProvider(manifest.provider) ?? 'claude';
        const flags = manifest.commandFlags ?? [];
        const launch = buildWorkerLaunch({
          requestProvider: provider,
          requestModel: flags.includes('--model') ? undefined : manifest.model,
          defaultCommand: team.defaultCommand(),
          autoMode: team.autoMode(),
        });
        const args = [...launch.args, ...flags];
        const agentId = uniqueAgentId(manifest.name, Object.keys(deps.agents()));
        const isolate = manifest.isolate === true;
        const plan: ParamountHirePlan = {
          agentId, name: manifest.name, ...(manifest.description ? { role: manifest.description } : {}),
          engine: provider, ...(manifest.model ? { model: manifest.model } : {}), cwd, isolate,
          command: [launch.bin, ...args].join(' '), engineInstalled: team.commandAvailable(launch.bin),
          confirmed: command.confirm === true, consentRequired: check.consentRequired ?? [],
          ignored: IGNORED_FIELDS.filter((f) => manifest[f] !== undefined && !(Array.isArray(manifest[f]) && (manifest[f] as unknown[]).length === 0)),
        };
        deps.logStep?.({ kind: 'paramount-hire', cid: span.cid, step: plan.confirmed ? 'confirmed' : 'plan', agentId, engine: provider, command: plan.command, cwd });
        if (!plan.confirmed) return done({ hire: plan });
        if (!plan.engineInstalled) return fail('UNSUPPORTED', `${launch.bin} is not installed on this machine; install it from Health, then hire again`);
        writeAttempted = true;
        return team.spawnHire({
          plan, bin: launch.bin, args, provider,
          ...(manifest.goal ? { goal: manifest.goal } : {}), ...(manifest.tokenCap ? { tokenCap: manifest.tokenCap } : {}),
          ...(manifest.capabilities ? { capabilities: manifest.capabilities } : {}),
        }, span.cid).then((started) => {
          deps.logStep?.({ kind: 'paramount-hire', cid: span.cid, step: started.ok ? 'spawned' : 'spawn-failed', agentId, error: started.error });
          if (!started.ok) { writeAttempted = false; return fail('INTERNAL', `Could not start ${plan.name}: ${started.error ?? 'unknown error'}`); }
          return done({ hire: plan });
        }, failCaught);
      }
    }
    return fail('INVALID_COMMAND', `${commandType} is unknown`);
  } catch (error) {
    return failCaught(error);
  }
}
