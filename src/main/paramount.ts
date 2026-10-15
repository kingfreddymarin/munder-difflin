import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { ScheduledMission } from './config';
import type { ParamountAgentDiscovery, ParamountAgentImport, ParamountAgentSource, ParamountDiagnostics, ParamountErrorCode, ParamountEvent, ParamountResult, ParamountCommand, ParamountPrereqReport, ParamountSourceWarning } from '../preload/paramount';
import { createSpan, type Span } from './paramountObservability';
import { dispatchHomeChats, type HomeChatsDeps } from './paramount-home-chats';
import type { ParamountHomeChatsCommand } from '../preload/paramount';
import { normalizeWeekly } from '../shared/weeklySchedule';
import { AGENT_SOURCES, discoverAgents, findAgents, toHireManifest, type AgentSourceRoots } from './agentSources';
import type { HireManifest } from '../shared/hire';
import { dispatchBoard, isBoardCommand, type ParamountBoardDeps } from './paramount-board';
import { runShellCommand, type ParamountShellDeps } from './paramount-shell';
import { runTerminalCommand, type ParamountTerminalDeps } from './paramount-terminal';
import type { ParamountArtifactMap } from '../preload/paramount';

export interface ParamountDeps extends Partial<Pick<HomeChatsDeps, 'send' | 'message' | 'godId'>> {
  tasks(): { tasks?: Array<{ id: string; humanQA?: Array<{ q: string; a?: string; answeredAt?: string }> }> };
  patchTask(id: string, patch: Record<string, unknown>): boolean;
  missions(): ScheduledMission[];
  saveMissions(missions: ScheduledMission[]): void;
  agents(): Record<string, unknown>;
  renameAgent(id: string, name: string): { ok: boolean; error?: string };
  setAgentTokenCap(id: string, cap: number): void;
  setNotifications(on: boolean): void;
  savePreference(key: 'profile' | 'setup' | 'home' | 'chats', value: Record<string, unknown>): void;
  appendEvent(event: ParamountEvent): void;
  publish(event: ParamountEvent): void;
  /** Redacted support bundle for `diagnostics.bundle`; absent means unsupported. */
  diagnostics?(options: { logLines?: number; cid: string }): ParamountDiagnostics;
  /** Floor-wide YOLO: persisted as config `autoMode` (new agents spawn with the
   *  engine's bypass-permissions stance). Absent means unsupported. */
  setFloorAutoMode?(on: boolean, expiresAt?: string): void;
  /** Connect/disconnect a registered integration by toggling its `enabled` flag.
   *  Never receives or returns a secret. `needs_secret` = the record requires a
   *  credential that has not been stored through the integrations flow. */
  setIntegrationConnected?(id: string, connected: boolean): 'ok' | 'not_found' | 'needs_secret';
  /** Vetted engine-CLI installers only. `plan` is read-only. `run` starts a
   *  VISIBLE terminal that runs the plan's trusted command and returns its pty id. */
  prereqInstall?: {
    plan(id: string): ParamountPrereqPlan | null;
    run(plan: ParamountPrereqPlan, cid: string): { ok: boolean; ptyId?: string; error?: string };
  };
  /** Persist one cell of the access matrix (atomic config write). 'rw' is the
   *  default, so it clears the cell. Enforcement lives in the integration broker. */
  setAccess?(agentId: string, sourceId: string, access: 'rw' | 'r' | 'none'): void;
  /** Vetted service starters only (Skidbladnir). `plan` is read-only; `run` starts a
   *  VISIBLE terminal that runs the plan's trusted command and returns its pty id. */
  prereqStart?: {
    plan(id: string): ParamountPrereqStartPlan | null;
    run(plan: ParamountPrereqStartPlan, cid: string): { ok: boolean; ptyId?: string; error?: string };
  };
  /** One audit line per step of a prerequisite action, tagged with the correlation id. */
  logStep?(step: Record<string, unknown>): void;
  /** Read-only agent discovery (agentSources.ts). `roots` resolves the source
   *  dirs; `deliverHire` opens the Add-Agent form pre-filled and never spawns. */
  agentSources?: {
    roots(): AgentSourceRoots;
    deliverHire(manifest: HireManifest): void;
  };
  /** Board commands (paramount-board.ts); absent means unsupported. */
  board?: ParamountBoardDeps;
  /** Opens allow-listed links and folders (paramount-shell.ts); absent means unsupported. */
  shell?: ParamountShellDeps;
  /** Artifact map behind each agent's terminal (paramount-terminal.ts); absent means unsupported. */
  terminal?: ParamountTerminalDeps;
}

export interface ParamountPrereqPlan {
  id: string;
  label: string;
  installed: boolean;
  kind: 'npm' | 'node-then-npm' | 'native' | 'manual';
  /** Trusted constant from the provider preset; absent for the manual rung. */
  command?: string;
}

export interface ParamountPrereqStartPlan {
  id: string;
  label: string;
  installed: boolean;
  /** A start terminal this app opened is still alive. */
  running: boolean;
  /** Trusted constant; never built from the command. */
  command: string;
}

/** YOLO auto-off window, in hours. */
export const YOLO_OFF_HOURS = { min: 0.1, max: 168 };
/** True when a persisted YOLO expiry has passed (or is unreadable, which fails safe). */
export function autoModeExpired(expiresAt: string | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return !Number.isFinite(at) || at <= now;
}

/** Iteration limits. The heartbeat mission and the ops standup are the only
 *  cadences the fork schedules, so they are the only iteration knobs offered. */
const HEARTBEAT_SEC = { min: 30, max: 86_400 };
const STANDUP_MIN = { min: 1, max: 1_440 };
const HEARTBEAT_MISSION_ID = 'heartbeat';
const STANDUP_MISSION_ID = 'ops-standup';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
}
/** Commands that touch credentials or installers accept an exact key set, so an
 *  extra field (for example a pasted token) is rejected instead of being
 *  persisted into the audit event. The error never echoes the rejected values. */
function onlyKeys(command: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(command).every((key) => allowed.includes(key));
}
function agentSource(value: unknown): value is ParamountAgentSource {
  return typeof value === 'string' && (AGENT_SOURCES as readonly string[]).includes(value);
}
/** projectDir is optional; when given it must be an absolute path. */
function projectDir(value: unknown): value is string | undefined {
  return value === undefined || (id(value) && value.length <= 4096 && isAbsolute(value));
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 10_000;
}
/** Only commands without a safe, direct preload equivalent are handled here.
 *  Every failure goes through `span.fail`, so it carries an errorId and code
 *  and is logged with its context under the span's correlation id. */
export function dispatchParamount(command: unknown, deps: ParamountDeps, span: Span = createSpan('paramount.dispatch')): ParamountResult | Promise<ParamountResult> {
  const commandType = object(command) && typeof command.type === 'string' ? command.type.slice(0, 80) : undefined;
  const fail = (code: ParamountErrorCode, message: string, cause?: unknown): ParamountResult =>
    span.fail(code, message, cause, { commandType });
  if (!object(command) || !id(command.type)) return fail('INVALID_COMMAND', 'Invalid command');
  if (isBoardCommand(command.type)) return dispatchBoard(command, deps, span);
  let writeAttempted = false;
  let diagnostics: ParamountDiagnostics | undefined;
  let prereq: ParamountPrereqReport | undefined;
  let discovery: ParamountAgentDiscovery | undefined;
  let imported: ParamountAgentImport | undefined;
  let artifacts: ParamountArtifactMap | undefined;
  // Every unreadable or malformed source file is logged under its own errorId,
  // the same one returned to the caller in `warnings`.
  const logWarnings = (warnings: ParamountSourceWarning[]) => {
    for (const w of warnings) deps.logStep?.({ kind: 'paramount-agent-source', cid: span.cid, errorId: w.errorId, path: w.path, message: w.message });
  };
  try {
    switch (command.type) {
      case 'question.answer':
      case 'notification.act': {
        const messageId = command.type === 'question.answer' ? command.messageId : command.notificationId;
        const option = command.type === 'question.answer' ? command.option : command.action;
        if (!id(messageId) || !text(option)) return fail('INVALID_INPUT', 'Invalid question answer');
        // The wire id is <task id>:<zero-based humanQA index>. A bare task id
        // means the first unanswered question, preserving older callers.
        const tasks = deps.tasks().tasks ?? [];
        const match = tasks.find((task) => messageId === task.id || messageId.startsWith(`${task.id}:`));
        if (!match) return fail('NOT_FOUND', 'Question task not found');
        const suffix = messageId === match.id ? null : messageId.slice(match.id.length + 1);
        const index = suffix === null ? (match.humanQA ?? []).findIndex((qa) => !qa.a)
          : /^(0|[1-9]\d*)$/.test(suffix) ? Number(suffix) : -1;
        const qa = match.humanQA ?? [];
        if (!Number.isInteger(index) || index < 0 || index >= qa.length || qa[index].a) return fail('CONFLICT', 'Question is not open');
        const next = qa.map((item, i) => i === index ? { ...item, a: option, answeredAt: new Date().toISOString() } : item);
        writeAttempted = true;
        if (!deps.patchTask(match.id, { humanQA: next })) return fail('CONFLICT', 'Question task changed; retry');
        break;
      }
      case 'automation.toggle': {
        if (!id(command.id) || typeof command.enabled !== 'boolean') return fail('INVALID_INPUT', 'Invalid automation toggle');
        const missions = deps.missions();
        if (!missions.some((m) => m.id === command.id)) return fail('NOT_FOUND', 'Automation not found');
        writeAttempted = true;
        deps.saveMissions(missions.map((m) => m.id === command.id ? { ...m, enabled: command.enabled as boolean } : m));
        break;
      }
      case 'agent.update': {
        if (!id(command.agentId) || !object(command.patch) || !Object.hasOwn(deps.agents(), command.agentId)) return fail('NOT_FOUND', 'Agent not found');
        const keys = Object.keys(command.patch);
        if (keys.length !== 1) return fail('INVALID_INPUT', 'Update one supported agent field at a time');
        if (keys[0] === 'name' && text(command.patch.name)) {
          writeAttempted = true;
          const result = deps.renameAgent(command.agentId, command.patch.name);
          if (!result.ok) return fail('CONFLICT', result.error ?? 'Agent rename failed');
        } else if (keys[0] === 'tokensCap' && typeof command.patch.tokensCap === 'number' &&
          Number.isFinite(command.patch.tokensCap) && command.patch.tokensCap > 0 &&
          Number.isSafeInteger(command.patch.tokensCap * 1_000_000)) {
          // Paramount's Agent.tokensCap is in millions; fork config uses tokens.
          writeAttempted = true;
          deps.setAgentTokenCap(command.agentId, command.patch.tokensCap * 1_000_000);
        } else return fail('UNSUPPORTED', 'Agent field is not supported by the fork');
        break;
      }
      case 'account.notify':
        if (command.id !== 'desktop' || typeof command.on !== 'boolean') return fail('UNSUPPORTED', 'Only desktop notifications are supported');
        writeAttempted = true;
        deps.setNotifications(command.on);
        break;
      case 'account.profile': {
        if (!object(command.patch)) return fail('INVALID_INPUT', 'Invalid account profile');
        const patch = command.patch;
        const allowed = ['name', 'workEmail', 'timezone'];
        if (Object.keys(patch).length === 0 || Object.keys(patch).some((k) => !allowed.includes(k) || !text(patch[k]))) {
          return fail('INVALID_INPUT', 'Invalid account profile fields');
        }
        writeAttempted = true;
        deps.savePreference('profile', patch);
        break;
      }
      case 'setup.dismiss':
        if (!Array.isArray(command.degraded) || command.degraded.length > 100 || command.degraded.some((v) => !id(v))) return fail('INVALID_INPUT', 'Invalid degraded service list');
        writeAttempted = true;
        deps.savePreference('setup', { dismissed: true, degraded: command.degraded });
        break;
      case 'diagnostics.bundle': {
        if (command.logLines !== undefined && (typeof command.logLines !== 'number' || !Number.isInteger(command.logLines) ||
          command.logLines < 1 || command.logLines > 2000)) return fail('INVALID_INPUT', 'logLines must be an integer from 1 to 2000');
        if (!deps.diagnostics) return fail('UNSUPPORTED', 'Diagnostics are not available in this build');
        diagnostics = deps.diagnostics({ logLines: command.logLines as number | undefined, cid: span.cid });
        break;
      }
      case 'access.set': {
        if (!id(command.agentId) || !id(command.sourceId) || !['rw', 'r', 'none'].includes(command.access as string)
          || command.agentId.includes(':') || command.sourceId.includes(':') || !onlyKeys(command, ['type', 'agentId', 'sourceId', 'access'])) {
          return fail('INVALID_INPUT', 'Invalid access grant; ids must not contain ":" and access is rw, r or none');
        }
        if (!deps.setAccess) return fail('UNSUPPORTED', 'Access grants are not available in this build');
        writeAttempted = true;
        deps.setAccess(command.agentId, command.sourceId, command.access as 'rw' | 'r' | 'none');
        break;
      }
      case 'floor.yolo': {
        const patch = command.patch;
        if (!object(patch) || Object.keys(patch).length === 0) return fail('INVALID_INPUT', 'Invalid floor yolo patch');
        const unsupported = Object.keys(patch).filter((k) => k !== 'on' && k !== 'autoOffHours');
        if (unsupported.length) return fail('UNSUPPORTED', `floor.yolo fields without a fork mechanism: ${unsupported.join(', ')}; "on" and "autoOffHours" are supported`);
        if (typeof patch.on !== 'boolean') return fail('INVALID_INPUT', 'floor.yolo "on" must be a boolean');
        const hours = patch.autoOffHours;
        if (hours !== undefined && hours !== null) {
          if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < YOLO_OFF_HOURS.min || hours > YOLO_OFF_HOURS.max) {
            return fail('INVALID_INPUT', `autoOffHours must be a number from ${YOLO_OFF_HOURS.min} to ${YOLO_OFF_HOURS.max}, or null for no expiry`);
          }
          if (!patch.on) return fail('INVALID_INPUT', 'autoOffHours only applies when "on" is true');
        }
        if (!deps.setFloorAutoMode) return fail('UNSUPPORTED', 'Floor YOLO is not available in this build');
        const expiresAt = patch.on && typeof hours === 'number' ? new Date(Date.now() + hours * 3_600_000).toISOString() : undefined;
        writeAttempted = true;
        deps.setFloorAutoMode(patch.on, expiresAt);
        break;
      }
      case 'floor.iteration': {
        const patch = command.patch;
        if (!object(patch) || Object.keys(patch).length === 0) return fail('INVALID_INPUT', 'Invalid floor iteration patch');
        const unsupported = Object.keys(patch).filter((k) => k !== 'heartbeatSec' && k !== 'standupMin');
        if (unsupported.length) return fail('UNSUPPORTED', `floor.iteration fields not supported in v1 (no backing mechanism): ${unsupported.join(', ')}; heartbeatSec and standupMin are supported`);
        const within = (v: unknown, r: { min: number; max: number }): v is number =>
          typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max;
        if (patch.heartbeatSec !== undefined && !within(patch.heartbeatSec, HEARTBEAT_SEC)) return fail('INVALID_INPUT', `heartbeatSec must be an integer from ${HEARTBEAT_SEC.min} to ${HEARTBEAT_SEC.max}`);
        if (patch.standupMin !== undefined && !within(patch.standupMin, STANDUP_MIN)) return fail('INVALID_INPUT', `standupMin must be an integer from ${STANDUP_MIN.min} to ${STANDUP_MIN.max}`);
        const missions = deps.missions();
        const beat = patch.heartbeatSec === undefined ? undefined : missions.find((m) => m.id === HEARTBEAT_MISSION_ID);
        const standup = patch.standupMin === undefined ? undefined : missions.find((m) => m.id === STANDUP_MISSION_ID);
        if (patch.heartbeatSec !== undefined && !beat) return fail('NOT_FOUND', 'Heartbeat mission not found');
        if (patch.standupMin !== undefined && !standup) return fail('NOT_FOUND', 'Ops standup mission not found');
        // A valid weekly schedule replaces intervalMs in the scheduler (heartbeats excepted),
        // so changing the interval would report ok while the cadence stays the same.
        const weekly = [beat, standup].find((m) => m && m.kind !== 'heartbeat' && normalizeWeekly(m.weekly));
        if (weekly) return fail('UNSUPPORTED', `Mission "${weekly.label}" runs on a weekly schedule; change its days and time in Missions instead`);
        // One write for both cadences, so a partial update never reaches the scheduler.
        writeAttempted = true;
        deps.saveMissions(missions.map((m) =>
          m === beat ? { ...m, intervalMs: (patch.heartbeatSec as number) * 1000 }
            : m === standup ? { ...m, intervalMs: (patch.standupMin as number) * 60_000 } : m));
        break;
      }
      case 'account.connection': {
        if (!id(command.id) || typeof command.connected !== 'boolean' || !onlyKeys(command, ['type', 'id', 'connected'])) return fail('INVALID_INPUT', 'Invalid account connection; only id and connected are accepted, never credentials');
        if (!deps.setIntegrationConnected) return fail('UNSUPPORTED', 'Account connections are not available in this build');
        writeAttempted = true;
        const outcome = deps.setIntegrationConnected(command.id, command.connected);
        if (outcome === 'not_found') { writeAttempted = false; return fail('NOT_FOUND', 'Connection is not registered; add it through Integrations'); }
        if (outcome === 'needs_secret') { writeAttempted = false; return fail('CONFLICT', 'Connection has no stored credential; enter it through Integrations first'); }
        break;
      }
      case 'prereq.install': {
        if (!id(command.id) || !onlyKeys(command, ['type', 'id', 'confirm'])) return fail('INVALID_INPUT', 'Invalid prerequisite install request');
        if (command.confirm !== undefined && typeof command.confirm !== 'boolean') return fail('INVALID_INPUT', 'confirm must be a boolean');
        if (!deps.prereqInstall) return fail('UNSUPPORTED', 'Prerequisite install is not available in this build');
        const plan = deps.prereqInstall.plan(command.id);
        if (!plan) return fail('UNSUPPORTED', `No vetted installer for "${command.id}"; only engine CLIs (claude, codex, opencode) can be installed`);
        deps.logStep?.({ kind: 'paramount-prereq', cid: span.cid, step: 'plan', id: plan.id, installed: plan.installed, rung: plan.kind, command: plan.command });
        if (plan.installed) return fail('CONFLICT', `${plan.label} is already installed`);
        if (!plan.command) return fail('UNSUPPORTED', `${plan.label} has no automatic installer on this machine; install it manually`);
        const report: ParamountPrereqReport = { id: plan.id, label: plan.label, installed: false, kind: plan.kind, command: plan.command, confirmed: command.confirm === true };
        if (command.confirm !== true) {
          // Read-only by default: show exactly what would run and run nothing.
          deps.logStep?.({ kind: 'paramount-prereq', cid: span.cid, step: 'confirm-required', id: plan.id });
          prereq = report;
          break;
        }
        deps.logStep?.({ kind: 'paramount-prereq', cid: span.cid, step: 'confirmed', id: plan.id });
        writeAttempted = true;
        const started = deps.prereqInstall.run(plan, span.cid);
        if (!started.ok) {
          writeAttempted = false;
          deps.logStep?.({ kind: 'paramount-prereq', cid: span.cid, step: 'spawn-failed', id: plan.id, error: started.error });
          return fail('INTERNAL', `Could not start the installer terminal: ${started.error ?? 'unknown error'}`);
        }
        deps.logStep?.({ kind: 'paramount-prereq', cid: span.cid, step: 'spawned', id: plan.id, ptyId: started.ptyId });
        prereq = { ...report, ptyId: started.ptyId };
        break;
      }
      case 'prereq.start': {
        if (!id(command.id) || !onlyKeys(command, ['type', 'id', 'confirm'])) return fail('INVALID_INPUT', 'Invalid prerequisite start request');
        if (command.confirm !== undefined && typeof command.confirm !== 'boolean') return fail('INVALID_INPUT', 'confirm must be a boolean');
        if (!deps.prereqStart) return fail('UNSUPPORTED', 'Prerequisite start is not available in this build');
        const plan = deps.prereqStart.plan(command.id);
        if (!plan) return fail('UNSUPPORTED', `No vetted start command for "${command.id}"`);
        deps.logStep?.({ kind: 'paramount-prereq', cid: span.cid, step: 'start-plan', id: plan.id, installed: plan.installed, running: plan.running, command: plan.command });
        if (!plan.installed) return fail('UNSUPPORTED', `${plan.label} is not installed; install it first`);
        if (plan.running) return fail('CONFLICT', `${plan.label} is already running`);
        const report: ParamountPrereqReport = { id: plan.id, label: plan.label, installed: true, kind: 'start', command: plan.command, confirmed: command.confirm === true };
        if (command.confirm !== true) {
          deps.logStep?.({ kind: 'paramount-prereq', cid: span.cid, step: 'start-confirm-required', id: plan.id });
          prereq = report;
          break;
        }
        deps.logStep?.({ kind: 'paramount-prereq', cid: span.cid, step: 'start-confirmed', id: plan.id });
        writeAttempted = true;
        const started = deps.prereqStart.run(plan, span.cid);
        if (!started.ok) {
          writeAttempted = false;
          deps.logStep?.({ kind: 'paramount-prereq', cid: span.cid, step: 'start-spawn-failed', id: plan.id, error: started.error });
          return fail('INTERNAL', `Could not start the ${plan.label} terminal: ${started.error ?? 'unknown error'}`);
        }
        deps.logStep?.({ kind: 'paramount-prereq', cid: span.cid, step: 'start-spawned', id: plan.id, ptyId: started.ptyId });
        prereq = { ...report, ptyId: started.ptyId };
        break;
      }
      case 'agents.discover': {
        const sources = command.sources;
        if (!onlyKeys(command, ['type', 'sources', 'projectDir']) || !projectDir(command.projectDir)
          || (sources !== undefined && (!Array.isArray(sources) || sources.length > AGENT_SOURCES.length || !sources.every(agentSource)))) {
          return fail('INVALID_INPUT', `Invalid agent discovery; sources is a list of ${AGENT_SOURCES.join(', ')} and projectDir an absolute path`);
        }
        if (!deps.agentSources) return fail('UNSUPPORTED', 'Agent discovery is not available in this build');
        discovery = discoverAgents(deps.agentSources.roots(), { sources: sources as ParamountAgentSource[] | undefined, projectDir: command.projectDir as string | undefined });
        logWarnings([...discovery.warnings, ...discovery.agents.flatMap((a) => a.warnings)]);
        break;
      }
      case 'agents.import': {
        if (!onlyKeys(command, ['type', 'source', 'id', 'projectDir']) || !agentSource(command.source) || !id(command.id) || !projectDir(command.projectDir)) {
          return fail('INVALID_INPUT', `Invalid agent import; source is one of ${AGENT_SOURCES.join(', ')}, id comes from agents.discover`);
        }
        if (!deps.agentSources) return fail('UNSUPPORTED', 'Agent import is not available in this build');
        const scan = findAgents(deps.agentSources.roots(), { sources: [command.source], projectDir: command.projectDir as string | undefined });
        const found = scan.found.find((f) => f.agent.id === command.id);
        if (!found) {
          logWarnings(scan.warnings);
          return fail('NOT_FOUND', `No ${command.source} agent "${command.id}"; run agents.discover again (pass the same projectDir for project agents)`);
        }
        const warnings: ParamountSourceWarning[] = [...found.agent.warnings];
        const hire = toHireManifest(found, warnings);
        logWarnings(warnings);
        if (!hire.ok || !hire.manifest) return fail('INVALID_INPUT', `Agent cannot be expressed as a hire manifest: ${hire.errors.join('; ')}`);
        writeAttempted = true;
        deps.agentSources.deliverHire(hire.manifest);
        imported = { agent: { ...found.agent, warnings }, manifest: hire.manifest as unknown as Record<string, unknown>, adjustments: hire.adjustments };
        break;
      }
      case 'ask.reply': case 'ask.dismiss': case 'home.layout': case 'chats.view': { const r = dispatchHomeChats(command as unknown as ParamountHomeChatsCommand, deps, fail, () => { writeAttempted = true; }); if (r) return r; break; }
      case 'shell.openExternal': case 'shell.openIn': return runShellCommand(command, deps.shell, span.cid, fail);
      case 'terminal.artifacts': { const r = runTerminalCommand(command, deps.terminal, deps.agents(), span.cid, fail); if (!('artifacts' in r)) return r; artifacts = r.artifacts; break; }
      case 'layout.panels':
        return fail('UNSUPPORTED', 'Team panel layout is a renderer-local preference');
      default:
        return fail('INVALID_COMMAND', `${command.type} uses an existing preload call or is unknown`);
    }
    const event: ParamountEvent = { id: randomUUID(), at: new Date().toISOString(), actor: 'you', command: command as ParamountCommand, correlationId: span.cid };
    deps.appendEvent(event);
    deps.publish(event);
    return { ok: true, event, ...(diagnostics ? { diagnostics } : {}), ...(prereq ? { prereq } : {}),
      ...(discovery ? { discovery } : {}), ...(imported ? { imported } : {}), ...(artifacts ? { artifacts } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Command failed';
    return writeAttempted
      ? fail('UNCERTAIN_STATE', `Command may have been applied; refresh the snapshot before retrying: ${message}`, error)
      : fail('INTERNAL', message, error);
  }
}
