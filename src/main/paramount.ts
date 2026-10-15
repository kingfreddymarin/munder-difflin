import { randomUUID } from 'node:crypto';
import type { ScheduledMission } from './config';

export interface ParamountEvent {
  id: string;
  at: string;
  actor: 'you';
  command: Record<string, unknown>;
}
export type ParamountUpdate = ParamountEvent | { kind: 'invalidate'; at: string; source: string };

export type ParamountResult =
  | { ok: true; event: ParamountEvent }
  | { ok: false; error: string };

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
function fail(error: string): ParamountResult { return { ok: false, error }; }

/** Only commands without a safe, direct preload equivalent are handled here. */
export function dispatchParamount(command: unknown, deps: ParamountDeps): ParamountResult {
  if (!object(command) || !id(command.type)) return fail('Invalid command');
  try {
    switch (command.type) {
      case 'question.answer':
      case 'notification.act': {
        const messageId = command.type === 'question.answer' ? command.messageId : command.notificationId;
        const option = command.type === 'question.answer' ? command.option : command.action;
        if (!id(messageId) || !text(option)) return fail('Invalid question answer');
        // The wire id is <task id>:<zero-based humanQA index>. A bare task id
        // means the first unanswered question, preserving older callers.
        const tasks = deps.tasks().tasks ?? [];
        const match = tasks.find((task) => messageId === task.id || messageId.startsWith(`${task.id}:`));
        if (!match) return fail('Question task not found');
        const suffix = messageId === match.id ? null : messageId.slice(match.id.length + 1);
        const index = suffix === null ? (match.humanQA ?? []).findIndex((qa) => !qa.a) : Number(suffix);
        const qa = match.humanQA ?? [];
        if (!Number.isInteger(index) || index < 0 || index >= qa.length || qa[index].a) return fail('Question is not open');
        const next = qa.map((item, i) => i === index ? { ...item, a: option, answeredAt: new Date().toISOString() } : item);
        if (!deps.patchTask(match.id, { humanQA: next })) return fail('Question task changed; retry');
        break;
      }
      case 'automation.toggle': {
        if (!id(command.id) || typeof command.enabled !== 'boolean') return fail('Invalid automation toggle');
        const missions = deps.missions();
        if (!missions.some((m) => m.id === command.id)) return fail('Automation not found');
        deps.saveMissions(missions.map((m) => m.id === command.id ? { ...m, enabled: command.enabled as boolean } : m));
        break;
      }
      case 'agent.update': {
        if (!id(command.agentId) || !object(command.patch) || !deps.agents()[command.agentId]) return fail('Agent not found');
        const keys = Object.keys(command.patch);
        if (keys.length !== 1) return fail('Update one supported agent field at a time');
        if (keys[0] === 'name' && text(command.patch.name)) {
          const result = deps.renameAgent(command.agentId, command.patch.name);
          if (!result.ok) return fail(result.error ?? 'Agent rename failed');
        } else if (keys[0] === 'tokensCap' && typeof command.patch.tokensCap === 'number' &&
          Number.isFinite(command.patch.tokensCap) && command.patch.tokensCap > 0 &&
          Number.isSafeInteger(command.patch.tokensCap * 1_000_000)) {
          // Paramount's Agent.tokensCap is in millions; fork config uses tokens.
          deps.setAgentTokenCap(command.agentId, command.patch.tokensCap * 1_000_000);
        } else return fail('Agent field is not supported by the fork');
        break;
      }
      case 'account.notify':
        if (command.id !== 'desktop' || typeof command.on !== 'boolean') return fail('Only desktop notifications are supported');
        deps.setNotifications(command.on);
        break;
      case 'account.profile': {
        if (!object(command.patch)) return fail('Invalid account profile');
        const patch = command.patch;
        const allowed = ['name', 'workEmail', 'timezone'];
        if (Object.keys(patch).length === 0 || Object.keys(patch).some((k) => !allowed.includes(k) || !text(patch[k]))) {
          return fail('Invalid account profile fields');
        }
        deps.savePreference('profile', patch);
        break;
      }
      case 'setup.dismiss':
        if (!Array.isArray(command.degraded) || command.degraded.some((v) => !id(v))) return fail('Invalid degraded service list');
        deps.savePreference('setup', { dismissed: true, degraded: command.degraded });
        break;
      case 'access.set':
      case 'floor.yolo':
      case 'floor.iteration':
      case 'account.connection':
      case 'prereq.install':
      case 'prereq.start':
        return fail(`${command.type} is not supported by the fork's enforcement or trusted launcher`);
      case 'layout.panels':
        return fail('Team panel layout is a renderer-local preference');
      default:
        return fail(`${command.type} uses an existing preload call or is unknown`);
    }
    const event: ParamountEvent = { id: randomUUID(), at: new Date().toISOString(), actor: 'you', command };
    deps.appendEvent(event);
    deps.publish(event);
    return { ok: true, event };
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Command failed');
  }
}
