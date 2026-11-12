// First-run floor setup (Munder parity). A fresh profile has no floor: harnessHome
// stays null and no hive services run until the human finishes setup, exactly as
// Munder's onboarding gates them on `onboardingComplete`. Setup writes the floor
// folder, the orchestrator engine/model and `onboardingComplete` in ONE config
// write; the caller's existing config path then bootstraps the hive.
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { ParamountCommand, ParamountErrorCode, ParamountEvent, ParamountResult } from '../preload/paramount';

export interface FloorSetupEngine {
  id: string;
  label: string;
  /** Can run the orchestrator (supports a model and can drain hive mail). */
  orchestrator: boolean;
  /** The engine's CLI was found on this Mac. */
  installed: boolean;
  /** Supported models from the configured catalog; empty means "engine default only". */
  models: string[];
}

export interface FloorSetupState {
  complete: boolean;
  harnessHome: string | null;
  suggestedHome: string;
  engines: FloorSetupEngine[];
}

export interface FloorSetupDeps {
  config(): { onboardingComplete?: boolean; harnessHome?: string | null };
  suggestedHome(): string;
  engines(): FloorSetupEngine[];
  ensureHome(path: string): { ok: boolean; error?: string };
  /** One atomic config write plus the hive bootstrap that follows a new harnessHome. */
  complete(patch: { harnessHome: string; godProvider: string; godModel?: string; autoMode?: boolean; onboardingComplete: true }): void;
  appendEvent(event: ParamountEvent): void;
  publish(event: ParamountEvent): void;
}

interface Span {
  cid: string;
  fail(code: ParamountErrorCode, message: string, cause?: unknown, context?: Record<string, unknown>): ParamountResult;
}

export function floorSetupState(deps: FloorSetupDeps): FloorSetupState {
  const config = deps.config();
  return {
    complete: config.onboardingComplete === true && !!config.harnessHome,
    harnessHome: config.harnessHome ?? null,
    suggestedHome: deps.suggestedHome(),
    engines: deps.engines()
  };
}

const ALLOWED = ['type', 'home', 'engine', 'model', 'autoMode'];
const oneLine = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\r\n\0]/.test(v);

/** `setup.complete`; null for any other command. */
export function dispatchFloorSetup(command: Record<string, unknown>, deps: FloorSetupDeps | undefined, span: Span): ParamountResult | null {
  if (command.type !== 'setup.complete') return null;
  const fail = (code: ParamountErrorCode, message: string, cause?: unknown): ParamountResult => span.fail(code, message, cause, { commandType: 'setup.complete' });
  if (!deps) return fail('UNSUPPORTED', 'setup.complete is not available in this build');
  if (Object.keys(command).some((k) => !ALLOWED.includes(k))) return fail('INVALID_INPUT', `setup.complete accepts ${ALLOWED.slice(1).join(', ')}`);
  if (floorSetupState(deps).complete) return fail('CONFLICT', 'This floor is already set up');
  if (!oneLine(command.home, 1024) || !isAbsolute(command.home.trim())) return fail('INVALID_INPUT', 'Choose a full folder path for the floor');
  if (command.autoMode !== undefined && typeof command.autoMode !== 'boolean') return fail('INVALID_INPUT', 'autoMode must be true or false');
  const engine = deps.engines().find((e) => e.id === command.engine);
  if (!engine) return fail('INVALID_INPUT', 'Unknown engine');
  if (!engine.orchestrator) return fail('INVALID_INPUT', `${engine.label} can work as an agent but cannot run the orchestrator`);
  if (!engine.installed) return fail('CONFLICT', `${engine.label} is not installed on this Mac. Install it, then check again`);
  const model = command.model === undefined || command.model === '' ? undefined : command.model;
  if (model !== undefined && (typeof model !== 'string' || !engine.models.includes(model))) return fail('INVALID_INPUT', `Pick a model ${engine.label} supports`);
  const home = command.home.trim();
  const made = deps.ensureHome(home);
  if (!made.ok) return fail('INVALID_INPUT', made.error || 'The floor folder could not be created');
  try {
    deps.complete({ harnessHome: home, godProvider: engine.id, ...(model ? { godModel: model } : {}), ...(typeof command.autoMode === 'boolean' ? { autoMode: command.autoMode } : {}), onboardingComplete: true });
  } catch (error) {
    return fail('UNCERTAIN_STATE', `Setup may be partly saved; reopen Paramount before retrying: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  const event: ParamountEvent = { id: randomUUID(), at: new Date().toISOString(), actor: 'you', command: command as unknown as ParamountCommand, correlationId: span.cid };
  deps.appendEvent(event);
  deps.publish(event);
  return { ok: true, event } as ParamountResult;
}
