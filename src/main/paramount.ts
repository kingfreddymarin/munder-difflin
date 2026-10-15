import { randomUUID } from 'node:crypto';
import type { ScheduledMission } from './config';
import type { ParamountDiagnostics, ParamountErrorCode, ParamountEvent, ParamountResult, ParamountCommand } from '../preload/paramount';
import { createSpan, type Span } from './paramountObservability';

export interface ParamountDeps {
  tasks(): { tasks?: Array<{ id: string; humanQA?: Array<{ q: string; a?: string; answeredAt?: string }> }> };
  patchTask(id: string, patch: Record<string, unknown>): boolean;
  missions(): ScheduledMission[];
  saveMissions(missions: ScheduledMission[]): void;
  agents(): Record<string, unknown>;
  renameAgent(id: string, name: string): { ok: boolean; error?: string };
  setAgentTokenCap(id: string, cap: number): void;
  setNotifications(on: boolean): void;
  savePreference(key: 'profile' | 'setup', value: Record<string, unknown>): void;
  appendEvent(event: ParamountEvent): void;
  publish(event: ParamountEvent): void;
  /** Redacted support bundle for `diagnostics.bundle`; absent means unsupported. */
  diagnostics?(options: { logLines?: number; cid: string }): ParamountDiagnostics;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 10_000;
}
/** Only commands without a safe, direct preload equivalent are handled here.
 *  Every failure goes through `span.fail`, so it carries an errorId and code
 *  and is logged with its context under the span's correlation id. */
export function dispatchParamount(command: unknown, deps: ParamountDeps, span: Span = createSpan('paramount.dispatch')): ParamountResult {
  const commandType = object(command) && typeof command.type === 'string' ? command.type.slice(0, 80) : undefined;
  const fail = (code: ParamountErrorCode, message: string, cause?: unknown): ParamountResult =>
    span.fail(code, message, cause, { commandType });
  if (!object(command) || !id(command.type)) return fail('INVALID_COMMAND', 'Invalid command');
  let writeAttempted = false;
  let diagnostics: ParamountDiagnostics | undefined;
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
      case 'access.set':
      case 'floor.yolo':
      case 'floor.iteration':
      case 'account.connection':
      case 'prereq.install':
      case 'prereq.start':
        return fail('UNSUPPORTED', `${command.type} is not supported by the fork's enforcement or trusted launcher`);
      case 'layout.panels':
        return fail('UNSUPPORTED', 'Team panel layout is a renderer-local preference');
      default:
        return fail('INVALID_COMMAND', `${command.type} uses an existing preload call or is unknown`);
    }
    const event: ParamountEvent = { id: randomUUID(), at: new Date().toISOString(), actor: 'you', command: command as ParamountCommand, correlationId: span.cid };
    deps.appendEvent(event);
    deps.publish(event);
    return diagnostics ? { ok: true, event, diagnostics } : { ok: true, event };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Command failed';
    return writeAttempted
      ? fail('UNCERTAIN_STATE', `Command may have been applied; refresh the snapshot before retrying: ${message}`, error)
      : fail('INTERNAL', message, error);
  }
}
