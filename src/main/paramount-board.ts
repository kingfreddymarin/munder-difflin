// Board commands for the Paramount UI. Failures carry an errorId and code.
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { ParamountBoardCommand, ParamountBoardPreferences, ParamountCardPatch, ParamountCardRef, ParamountCardStatus, ParamountCommand, ParamountErrorCode, ParamountEvent, ParamountOpenApp, ParamountResult } from '../preload/paramount';
import type { ParamountDeps } from './paramount';
import type { Span } from './paramountObservability';

export const BOARD_COMMANDS = ['board.columns', 'card.open', 'card.link', 'card.update', 'card.archive'] as const;
const STATUSES: readonly ParamountCardStatus[] = ['backlog', 'todo', 'doing', 'blocked', 'review', 'done'];
const OPEN_APPS: readonly ParamountOpenApp[] = ['warp', 'vscode'];
const REF_KINDS: readonly ParamountCardRef['kind'][] = ['pr', 'build', 'run', 'workitem'];
const REF_SYSTEMS: readonly ParamountCardRef['system'][] = ['github', 'ado'];

/** Host calls the board needs; absent means the build cannot run board commands. */
export interface ParamountBoardDeps {
  savePreference(value: ParamountBoardPreferences): void;
  isDirectory(path: string): boolean;
  /** Opens `dir` in the app. Returns an error when the app is not installed. */
  openInApp(app: ParamountOpenApp, dir: string): { ok: true } | { ok: false; error: string };
  /** Opens an https URL in the default browser. */
  openUrl(url: string): void;
}

const APP_LABEL: Record<ParamountOpenApp, string> = { warp: 'Warp', vscode: 'VS Code' };

/** The documented URL scheme that opens a directory in each app. */
export function openAppUrl(app: ParamountOpenApp, dir: string): string {
  return app === 'warp'
    ? `warp://action/new_tab?path=${encodeURIComponent(dir)}`
    : `vscode://file${encodeURI(dir.startsWith('/') ? dir : `/${dir}`)}`;
}

/** Board deps on top of Electron. `handlerFor` is app.getApplicationNameForProtocol;
 *  `open` is shell.openExternal, whose late rejection goes to `onOpenError`. */
export function createBoardDeps(host: {
  savePreference(value: ParamountBoardPreferences): void;
  isDirectory(path: string): boolean;
  handlerFor(url: string): string;
  open(url: string): Promise<void>;
  onOpenError(url: string, error: unknown): void;
}): ParamountBoardDeps {
  const open = (url: string) => { host.open(url).catch((error) => host.onOpenError(url, error)); };
  return {
    savePreference: host.savePreference,
    isDirectory: host.isDirectory,
    openInApp(app, dir) {
      const url = openAppUrl(app, dir);
      if (!host.handlerFor(url)) return { ok: false, error: `${APP_LABEL[app]} is not installed (nothing handles ${url.split(':')[0]}: links)` };
      open(url);
      return { ok: true };
    },
    openUrl: open,
  };
}

export function isBoardCommand(type: unknown): type is ParamountBoardCommand['type'] {
  return typeof type === 'string' && (BOARD_COMMANDS as readonly string[]).includes(type);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function onlyKeys(command: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(command).every((key) => allowed.includes(key));
}
function key(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
}
export function isBoardOwnerSender(sender: { knownWindow: boolean; mainFrame: boolean; url: string }, uiUrl: string): boolean {
  if (!sender.knownWindow || !sender.mainFrame) return false;
  try {
    const actual = new URL(sender.url);
    const expected = new URL(uiUrl);
    return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname
      && actual.username === expected.username && actual.password === expected.password;
  } catch {
    return false;
  }
}

function cardPatch(value: unknown, agents: () => Record<string, unknown>): ParamountCardPatch | null {
  if (!object(value) || !onlyKeys(value, ['title', 'description', 'assignee', 'priority', 'parentId']) || !Object.keys(value).length) return null;
  const patch: ParamountCardPatch = {};
  if ('title' in value) {
    if (!key(value.title) || !value.title.trim()) return null;
    patch.title = value.title.trim();
  }
  if ('description' in value) {
    if (typeof value.description !== 'string' || value.description.length > 10_000 || value.description.includes('\0')) return null;
    patch.description = value.description;
  }
  if ('assignee' in value) {
    if (value.assignee !== '' && (!key(value.assignee) || !Object.hasOwn(agents(), value.assignee))) return null;
    patch.assignee = value.assignee;
  }
  if ('priority' in value) {
    if (value.priority !== 1 && value.priority !== 2 && value.priority !== 3) return null;
    patch.priority = value.priority;
  }
  if ('parentId' in value) {
    // '' clears the parent; the parent's existence and cycles are checked against the ledger by parentError.
    if (value.parentId !== '' && !key(value.parentId)) return null;
    patch.parentId = value.parentId;
  }
  return patch;
}

/** Why `parent` cannot be the parent of card `key`, or null when it can: it must be another
 *  active card, and `key` must not be among its ancestors (no cycles). */
export function parentError(tasks: readonly unknown[], key: string, parent: string): { code: 'INVALID_INPUT' | 'NOT_FOUND'; message: string } | null {
  if (parent === key) return { code: 'INVALID_INPUT', message: 'A card cannot be its own parent' };
  const byId = new Map<string, Record<string, unknown>>();
  for (const task of tasks) if (object(task) && typeof task.id === 'string' && !byId.has(task.id)) byId.set(task.id, task);
  const target = byId.get(parent);
  if (!target || target.boardArchivedAt) return { code: 'NOT_FOUND', message: `No active Board card ${parent} to be the parent` };
  const seen = new Set<string>();
  for (let at: unknown = parent; typeof at === 'string' && at && !seen.has(at); at = byId.get(at)?.parentId) {
    if (at === key) return { code: 'INVALID_INPUT', message: `${parent} is already under ${key}; a parent cannot be its own descendant` };
    seen.add(at);
  }
  return null;
}

export function httpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The valid refs stored on a raw hive task; anything malformed is left out. */
export function cardRefs(task: Record<string, unknown>): ParamountCardRef[] {
  if (!Array.isArray(task.refs)) return [];
  return task.refs.filter((ref): ref is ParamountCardRef => object(ref)
    && REF_KINDS.includes(ref.kind as ParamountCardRef['kind']) && REF_SYSTEMS.includes(ref.system as ParamountCardRef['system'])
    && key(ref.id) && httpsUrl(ref.url));
}

export function dispatchBoard(command: Record<string, unknown>, deps: ParamountDeps, span: Span): ParamountResult {
  const fail = (code: ParamountErrorCode, message: string, cause?: unknown): ParamountResult =>
    span.fail(code, message, cause, { commandType: command.type });
  const board = deps.board;
  if (!board) return fail('UNSUPPORTED', 'Board commands are not available in this build');
  const task = () => (deps.tasks().tasks ?? []).find((item) => item?.id === command.key) as Record<string, unknown> | undefined;
  let writeAttempted = false;
  let applied = command;
  let at = new Date().toISOString();
  const cardMutation = command.type === 'card.update' || command.type === 'card.archive';
  if (cardMutation && !deps.canMutateBoard?.()) return fail('FORBIDDEN', 'Only the floor owner can edit or archive cards from the Board');

  try {
    switch (command.type) {
      case 'board.columns': {
        const order = command.order;
        if (!onlyKeys(command, ['type', 'order']) || !Array.isArray(order) || order.length === 0 || order.length > STATUSES.length
          || !order.every((s) => STATUSES.includes(s as ParamountCardStatus)) || new Set(order).size !== order.length) {
          return fail('INVALID_INPUT', `Invalid column order; list each of ${STATUSES.join(', ')} at most once`);
        }
        writeAttempted = true;
        board.savePreference({ columns: order as ParamountCardStatus[] });
        break;
      }
      case 'card.open': {
        if (!onlyKeys(command, ['type', 'key', 'app']) || !key(command.key) || !OPEN_APPS.includes(command.app as ParamountOpenApp)) {
          return fail('INVALID_INPUT', `Invalid card.open; app is one of ${OPEN_APPS.join(', ')}`);
        }
        const card = task();
        if (!card) return fail('NOT_FOUND', `No card ${command.key}`);
        const dir = card.dir;
        if (typeof dir !== 'string' || !isAbsolute(dir)) return fail('NOT_FOUND', `Card ${command.key} has no working directory; its owner sets "dir" on the card`);
        if (!board.isDirectory(dir)) return fail('NOT_FOUND', `The card's working directory does not exist: ${dir}`);
        writeAttempted = true;
        const opened = board.openInApp(command.app as ParamountOpenApp, dir);
        // NOT_FOUND, not UNSUPPORTED: the UI learns UNSUPPORTED per command type and would then disable the other app too.
        if (!opened.ok) return fail('NOT_FOUND', opened.error);
        break;
      }
      case 'card.link': {
        if (!onlyKeys(command, ['type', 'key', 'url']) || !key(command.key) || !httpsUrl(command.url)) {
          return fail('INVALID_INPUT', 'Invalid card.link; url must be an https link stored on the card');
        }
        const card = task();
        if (!card) return fail('NOT_FOUND', `No card ${command.key}`);
        // Only a URL the card already carries is opened, so the renderer cannot open arbitrary links here.
        if (!cardRefs(card).some((ref) => ref.url === command.url)) return fail('NOT_FOUND', `Card ${command.key} has no link to that URL; refresh the board`);
        writeAttempted = true;
        board.openUrl(command.url as string);
        break;
      }
      case 'card.update': {
        const patch = cardPatch(command.patch, deps.agents);
        if (!onlyKeys(command, ['type', 'key', 'patch']) || !key(command.key) || !patch) {
          return fail('INVALID_INPUT', 'Provide a valid title, description, priority, assignee or parent');
        }
        const card = task();
        if (!card || card.boardArchivedAt) return fail('NOT_FOUND', `No active Board card ${command.key}`);
        const parentProblem = patch.parentId ? parentError(deps.tasks().tasks ?? [], command.key, patch.parentId) : null;
        if (parentProblem) return fail(parentProblem.code, parentProblem.message);
        applied = { type: command.type, key: command.key, patch };
        writeAttempted = true;
        // An empty parentId removes the field from tasks.json (undefined is dropped when the ledger is saved).
        const write = patch.parentId === '' ? { ...patch, parentId: undefined } : patch;
        if (!deps.patchTask(command.key, { ...write, updatedAt: at })) return fail('CONFLICT', 'Card changed; refresh the Board');
        break;
      }
      case 'card.archive': {
        if (!onlyKeys(command, ['type', 'key']) || !key(command.key)) return fail('INVALID_INPUT', 'Provide a card key');
        const card = task();
        if (!card) return fail('NOT_FOUND', `No card ${command.key}`);
        if (typeof card.boardArchivedAt === 'string' && card.boardArchivedAt) {
          // Reconcile a retry to the original archive date without a second write or audit.
          at = card.boardArchivedAt;
          return { ok: true, event: { id: randomUUID(), at, actor: 'you', command: { type: 'card.archive', key: command.key }, correlationId: span.cid } };
        }
        writeAttempted = true;
        if (!deps.patchTask(command.key, { boardArchivedAt: at })) return fail('CONFLICT', 'Card changed; refresh the Board');
        break;
      }
      default:
        return fail('INVALID_COMMAND', `${String(command.type)} is not a board command`);
    }
    const event: ParamountEvent = { id: randomUUID(), at, actor: 'you', command: applied as unknown as ParamountCommand, correlationId: span.cid };
    deps.appendEvent(event);
    deps.publish(event);
    return { ok: true, event };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Command failed';
    if (cardMutation && writeAttempted) return fail('UNCERTAIN_STATE', `Card may have been saved; refresh the Board before retrying: ${message}`, error);
    return writeAttempted && command.type === 'board.columns'
      ? fail('UNCERTAIN_STATE', `Column order may have been saved; refresh the snapshot before retrying: ${message}`, error)
      : fail('INTERNAL', message, error);
  }
}
