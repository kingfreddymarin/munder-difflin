import { resolveAgentModel } from './paramount-models';
// First-run floor setup (Munder parity). A fresh profile has no floor: harnessHome
// stays null and no hive services run until the human finishes setup, exactly as
// Munder's onboarding gates them on `onboardingComplete`. Setup writes the floor
// folder, the orchestrator engine/model and `onboardingComplete` in ONE config
// write; the caller's existing config path then bootstraps the hive.
import { discoverLaunchers, publicDiscovery, validateLauncher, saveLauncherPick, type LauncherDiscovery, type LauncherPick } from './council-account-launchers';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import type { ParamountCommand, ParamountErrorCode, ParamountEvent, ParamountResult } from '../preload/paramount';
import type { FloorGateState } from './floor-lock';

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
  launchers?: LauncherDiscovery;
  /** Whether this process holds the floor (Munder's .floor-lock); 'refused' names the app that does. */
  floorLock?: FloorGateState;
  /** The launch floor chooser: pending until the human opens a floor in this run. */
  choice?: FloorChoice;
}

/** The floor picker (owner requests 2026-11-12, Munder 0.5.7 parity). `pending`: no floor is open in
 *  this process yet (launch); `newFloor`: New Floor… asked for a floor to start as its own process.
 *  Each recent floor carries its state (floors.ts probeFloor); `last` is preselected. */
export interface FloorChoice {
  pending: boolean;
  newFloor: boolean;
  last: string | null;
  recents: Array<{ path: string; exists: boolean; state: 'free' | 'held' | 'missing' | 'current' | 'data-folder'; heldBy?: string }>;
}

export interface FloorSetupDeps {
  launcherDiscovery?(): ReturnType<typeof discoverLaunchers>;
  /** The floor lock gate (floor-lock.ts): current state, a retry, and a way back to setup. */
  floor?: {
    state(): FloorGateState; claim(home: string): FloorGateState; retry(): FloorGateState; chooseAnother(): void;
    /** The launch chooser's state; absent before setup. */
    choice?(): FloorChoice;
    /** Claim and open a floor in this process (the launch picker); a held floor is refused untouched. */
    open?(home: string): FloorGateState;
    /** New Floor…: start the floor as its own app process (Munder's floor:open). */
    openProcess?(home: string): Promise<{ ok: true; home: string } | { ok: false; error: string; refusal?: string }>;
    /** A floor process's own home (null in the main process): the only floor it opens itself. */
    ownHome?(): string | null;
    /** Show or close the New Floor… picker. */
    picker?(open: boolean): void;
    /** Stop this floor's agents as quit does and restart at the launch picker. */
    switchFloor?(): void;
    /** Why a folder cannot be a floor (it is or holds the app's data folder), else null. */
    dataFolderRefusal?(home: string): string | null;
  };
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
  const complete = config.onboardingComplete === true && !!config.harnessHome;
  return {
    complete,
    harnessHome: config.harnessHome ?? null,
    suggestedHome: deps.suggestedHome(),
    // Every snapshot builds this state, so launchers are read only while the setup
    // screen shows, and only from the injected (cached) discovery: never a shell here.
    ...(!complete && deps.launcherDiscovery ? { launchers: publicDiscovery(deps.launcherDiscovery()) } : {}),
    ...(deps.floor ? { floorLock: deps.floor.state() } : {}),
    ...(complete && deps.floor?.choice ? { choice: deps.floor.choice() } : {}),
    engines: deps.engines()
  };
}

const ALLOWED = ['type', 'home', 'engine', 'model', 'autoMode', 'launcher', 'launcherDefaults', 'tempLauncher'];
const oneLine = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\r\n\0]/.test(v);

/** `setup.complete`; null for any other command. */
export function dispatchFloorSetup(command: Record<string, unknown>, deps: FloorSetupDeps | undefined, span: Span): ParamountResult | Promise<ParamountResult> | null {
  if (command.type === 'floor.retry' || command.type === 'floor.choose-another') return dispatchFloorLock(command, deps, span);
  if (command.type === 'floor.open' || command.type === 'floor.picker' || command.type === 'floor.switch') return dispatchFloorChoice(command, deps, span);
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
  const wantedModel = command.model === undefined || command.model === '' ? undefined : command.model;
  const model = resolveAgentModel(engine.id, [typeof wantedModel === 'string' ? wantedModel : undefined], () => engine.models);
  if (wantedModel !== undefined && (typeof wantedModel !== 'string' || model !== wantedModel)) return fail('INVALID_INPUT', `Pick a model ${engine.label} supports`);
  try { if (command.launcher !== undefined && command.launcher !== null) validateLauncher(command.launcher, engine.id, deps.launcherDiscovery?.()); }
  catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : 'Invalid account launcher'); }
  const defaults = command.launcherDefaults;
  try {
    if (defaults !== undefined) {
      if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults) || Object.keys(defaults).some((k) => !['claude', 'codex'].includes(k))) throw new Error('Default launchers must be keyed by Claude or Codex provider');
      for (const [provider, pick] of Object.entries(defaults)) if (pick !== null) validateLauncher(pick, provider, deps.launcherDiscovery?.());
    }
    if (command.tempLauncher !== undefined && command.tempLauncher !== null) {
      const pick = command.tempLauncher as LauncherPick;
      const discovery = deps.launcherDiscovery?.();
      const choice = discovery?.choices.find((c) => c.id === pick.id);
      validateLauncher(pick, choice?.provider ?? '', discovery);
    }
  } catch (e) { return fail('INVALID_INPUT', e instanceof Error ? e.message : 'Invalid default launcher'); }
  const home = command.home.trim();
  const ownData = deps.floor?.dataFolderRefusal?.(home);
  if (ownData) return fail('INVALID_INPUT', ownData);
  // Munder's floor lock before anything is written there (launcher picks, the hive itself).
  const claimed = deps.floor?.claim(home);
  if (claimed?.state === 'refused') return fail('CONFLICT', `${claimed.refusal.owner} (pid ${claimed.refusal.pid}) has this floor open. Quit it, or choose another floor.`);
  if (claimed?.state === 'error') return fail('INTERNAL', `The floor lock could not be written: ${claimed.detail}`);
  const made = deps.ensureHome(home);
  if (!made.ok) return fail('INVALID_INPUT', made.error || 'The floor folder could not be created');
  try {
    for (const [provider, pick] of Object.entries(defaults ?? {})) saveLauncherPick(join(home, 'hive'), 'default', pick as LauncherPick | null, provider);
    if (command.tempLauncher !== undefined) saveLauncherPick(join(home, 'hive'), 'temps', command.tempLauncher as LauncherPick | null);
    if (command.launcher !== undefined) saveLauncherPick(join(home, 'hive'), 'orchestrator', command.launcher as LauncherPick | null);
    deps.complete({ harnessHome: home, godProvider: engine.id, godModel: model || '', ...(typeof command.autoMode === 'boolean' ? { autoMode: command.autoMode } : {}), onboardingComplete: true });
  } catch (error) {
    return fail('UNCERTAIN_STATE', `Setup may be partly saved; reopen Paramount before retrying: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  const event: ParamountEvent = { id: randomUUID(), at: new Date().toISOString(), actor: 'you', command: command as unknown as ParamountCommand, correlationId: span.cid };
  deps.appendEvent(event);
  deps.publish(event);
  return { ok: true, event } as ParamountResult;
}

/** `floor.retry` (the other app quit: claim the floor now) and `floor.choose-another`
 *  (back to setup to pick a different folder). Neither touches the refused floor. */
function dispatchFloorLock(command: Record<string, unknown>, deps: FloorSetupDeps | undefined, span: Span): ParamountResult {
  const type = String(command.type);
  const fail = (code: ParamountErrorCode, message: string): ParamountResult => span.fail(code, message, undefined, { commandType: type });
  if (!deps?.floor) return fail('UNSUPPORTED', `${type} is not available in this build`);
  if (Object.keys(command).some((k) => k !== 'type')) return fail('INVALID_INPUT', `${type} takes no fields`);
  if (type === 'floor.retry') {
    const state = deps.floor.retry();
    if (state.state === 'refused') return fail('CONFLICT', `${state.refusal.owner} (pid ${state.refusal.pid}) still has this floor open. Quit it, or choose another floor.`);
    if (state.state === 'error') return fail('INTERNAL', `The floor lock could not be written: ${state.detail}`);
  } else deps.floor.chooseAnother();
  const event: ParamountEvent = { id: randomUUID(), at: new Date().toISOString(), actor: 'you', command: command as unknown as ParamountCommand, correlationId: span.cid };
  // The refused floor's log is not ours to write: publish to the window only.
  deps.publish(event);
  return { ok: true, event } as ParamountResult;
}

/** `floor.open {home}`: from the launch picker, open the floor in this process; with a floor already
 *  open (New Floor…), start it as its own app process. `floor.picker {open}` shows or closes the
 *  New Floor… picker; `floor.switch` stops this floor's agents and restarts at the launch picker. A refused floor is left exactly as it is. */
function dispatchFloorChoice(command: Record<string, unknown>, deps: FloorSetupDeps | undefined, span: Span): ParamountResult | Promise<ParamountResult> {
  const type = String(command.type);
  const fail = (code: ParamountErrorCode, message: string): ParamountResult => span.fail(code, message, undefined, { commandType: type });
  const floor = deps?.floor;
  if (!deps || !floor?.open || !floor.openProcess || !floor.picker || !floor.choice) return fail('UNSUPPORTED', `${type} is not available in this build`);
  if (!floorSetupState(deps).complete) return fail('CONFLICT', 'Finish setting up a floor first');
  const done = (): ParamountResult => {
    const event: ParamountEvent = { id: randomUUID(), at: new Date().toISOString(), actor: 'you', command: command as unknown as ParamountCommand, correlationId: span.cid };
    // To the window only: an opened floor's log is written by its own services.
    deps.publish(event);
    return { ok: true, event } as ParamountResult;
  };
  if (type === 'floor.switch') {
    if (Object.keys(command).some((k) => k !== 'type')) return fail('INVALID_INPUT', 'floor.switch takes no fields');
    if (!floor.switchFloor) return fail('UNSUPPORTED', 'floor.switch is not available in this build');
    floor.switchFloor();
    return done();
  }
  if (type === 'floor.picker') {
    if (Object.keys(command).some((k) => k !== 'type' && k !== 'open') || typeof command.open !== 'boolean') return fail('INVALID_INPUT', 'floor.picker takes open: true or false');
    floor.picker(command.open);
    return done();
  }
  if (Object.keys(command).some((k) => k !== 'type' && k !== 'home')) return fail('INVALID_INPUT', 'floor.open takes home');
  if (!oneLine(command.home, 1024) || !isAbsolute(command.home.trim())) return fail('INVALID_INPUT', 'Choose a full folder path for the floor');
  const home = command.home.trim();
  // A floor process opens only its own home; any other floor starts as that floor's own process.
  const own = floor.ownHome?.() ?? null;
  if (!floor.choice().pending || (own && resolve(home) !== resolve(own))) {
    return floor.openProcess(home).then((r) => r.ok ? done() : fail(r.refusal === 'held' ? 'CONFLICT' : r.refusal === 'data-folder' || r.refusal === 'invalid' || r.refusal === 'current' ? 'INVALID_INPUT' : 'INTERNAL', r.error));
  }
  const state = floor.open(home);
  if (state.state === 'refused') return fail('CONFLICT', `${state.refusal.owner} (pid ${state.refusal.pid}) has this floor open. Quit it, or choose another floor.`);
  if (state.state === 'error') return fail('INTERNAL', `The floor could not be opened: ${state.detail}`);
  if (state.state !== 'open') return fail('INTERNAL', 'The floor could not be opened');
  return done();
}
