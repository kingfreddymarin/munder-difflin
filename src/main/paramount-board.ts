// Board commands for the Paramount UI (lane c-board): the human's column order,
// opening a card's working directory in Warp or VS Code, and opening a link the
// card carries. Registered with one line in paramount.ts; every failure goes
// through `span.fail`, so it carries an errorId and code and is logged.
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { ParamountBoardCommand, ParamountBoardPreferences, ParamountCardRef, ParamountCardStatus, ParamountCommand, ParamountErrorCode, ParamountEvent, ParamountOpenApp, ParamountResult } from '../preload/paramount';
import type { ParamountDeps } from './paramount';
import type { Span } from './paramountObservability';

export const BOARD_COMMANDS = ['board.columns', 'card.open', 'card.link'] as const;
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
      default:
        return fail('INVALID_COMMAND', `${String(command.type)} is not a board command`);
    }
    const event: ParamountEvent = { id: randomUUID(), at: new Date().toISOString(), actor: 'you', command: command as unknown as ParamountCommand, correlationId: span.cid };
    deps.appendEvent(event);
    deps.publish(event);
    return { ok: true, event };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Command failed';
    return writeAttempted && command.type === 'board.columns'
      ? fail('UNCERTAIN_STATE', `Column order may have been saved; refresh the snapshot before retrying: ${message}`, error)
      : fail('INTERNAL', message, error);
  }
}
