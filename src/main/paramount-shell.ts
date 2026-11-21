/**
 * Paramount lane a-shell: open an external reference (GitHub, Azure DevOps) in
 * the browser, or open a folder in Warp or a local file or folder in VS Code.
 *
 * Both are refused unless the input is exactly what they claim to be:
 * - a link must be http(s), carry no credentials, and point at an allow-listed host;
 * - a folder must be an absolute path to an existing directory.
 * A folder is handed to `open -a <App> <dir>` as an argument array (execFile, no
 * shell), so nothing inside a path is ever interpreted.
 *
 * No Electron import: index.ts injects `openExternal`, tests inject fakes.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ParamountCommand, ParamountErrorCode, ParamountEvent, ParamountResult } from '../preload/paramount';

/** Hosts a link may open. `*.x` matches any subdomain of x, not x itself. */
export const PARAMOUNT_LINK_HOSTS: readonly string[] = ['github.com', 'dev.azure.com', '*.visualstudio.com'];
/** Apps a folder may open in, by command id, with their macOS application names. */
export const PARAMOUNT_OPEN_IN_APPS = { warp: 'Warp', vscode: 'Visual Studio Code' } as const;
export type ParamountOpenInApp = keyof typeof PARAMOUNT_OPEN_IN_APPS;

const MAX_INPUT = 4096;
const LAUNCH_TIMEOUT_MS = 15_000;

export interface ParamountShellDeps {
  /** Electron `shell.openExternal`. */
  openExternal(url: string): Promise<void>;
  /** Opens `dir` in the named macOS application. */
  launch(appName: string, dir: string): Promise<{ ok: boolean; error?: string; missingApp?: boolean }>;
  platform: NodeJS.Platform;
  /** One audit line per opened target, tagged with the correlation id. */
  logStep?(step: Record<string, unknown>): void;
}

type Fail = (code: ParamountErrorCode, message: string, cause?: unknown) => ParamountResult;
type Check<T> = { ok: true; value: T } | { ok: false; code: ParamountErrorCode; message: string };

function plainString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_INPUT && !/[\0-\x1f\x7f]/.test(value);
}

export function hostAllowed(hostname: string, hosts: readonly string[] = PARAMOUNT_LINK_HOSTS): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return hosts.some((rule) => rule.startsWith('*.') ? host.endsWith(rule.slice(1)) && host.length > rule.length - 1 : host === rule);
}

/** The normalised URL to open, or why it is refused. */
export function checkLink(raw: unknown, hosts: readonly string[] = PARAMOUNT_LINK_HOSTS): Check<string> {
  if (!plainString(raw)) return { ok: false, code: 'INVALID_INPUT', message: `A link must be a single-line string of at most ${MAX_INPUT} characters` };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, code: 'INVALID_INPUT', message: 'Not a valid URL' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, code: 'INVALID_INPUT', message: `Only http and https links open; refused ${url.protocol.replace(/:$/, '')}` };
  if (url.username || url.password) return { ok: false, code: 'INVALID_INPUT', message: 'Links with credentials in them are refused' };
  if (!hostAllowed(url.hostname, hosts)) return { ok: false, code: 'INVALID_INPUT', message: `${url.hostname} is not an allowed host; allowed: ${hosts.join(', ')}` };
  return { ok: true, value: url.href };
}

/** The real directory to open, or why it is refused. */
export function checkFolder(raw: unknown): Check<string> {
  return checkLocalPath(raw, false);
}

function checkLocalPath(raw: unknown, allowFile: boolean): Check<string> {
  const label = allowFile ? 'Path' : 'Folder';
  if (!plainString(raw) || !isAbsolute(raw)) return { ok: false, code: 'INVALID_INPUT', message: `${label} must be absolute` };
  let real: string;
  try {
    real = realpathSync(raw);
    const target = statSync(real);
    if (!target.isDirectory() && !(allowFile && target.isFile())) return { ok: false, code: 'INVALID_INPUT', message: allowFile ? 'Path is neither a file nor a directory' : 'Path is not a directory' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { ok: false, code: 'NOT_FOUND', message: `${label} does not exist` }
      : { ok: false, code: 'INTERNAL', message: `${label} cannot be read (${code ?? 'unknown error'})` };
  }
  return { ok: true, value: real };
}

/** `open -a <App> <dir>` with an argument array. macOS only. `dir` is a resolved
 *  absolute path, so it always starts with "/" and cannot be read as an option. */
export function launchWithOpen(appName: string, dir: string): Promise<{ ok: boolean; error?: string; missingApp?: boolean }> {
  return new Promise((resolve) => {
    execFile('open', ['-a', appName, dir], { timeout: LAUNCH_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (!error) return resolve({ ok: true });
      const detail = String(stderr || error.message).trim().slice(0, 500);
      resolve({ ok: false, error: detail, missingApp: /unable to find application/i.test(detail) });
    });
  });
}

export function paramountShellDeps(openExternal: (url: string) => Promise<void>, logStep?: (step: Record<string, unknown>) => void): ParamountShellDeps {
  return { openExternal, launch: launchWithOpen, platform: process.platform, logStep };
}

/** Handles `shell.openExternal` and `shell.openIn`. Every refusal goes through `fail`, so it carries an errorId. */
export async function runShellCommand(command: Record<string, unknown>, deps: ParamountShellDeps | undefined, cid: string, fail: Fail): Promise<ParamountResult> {
  if (!deps) return fail('UNSUPPORTED', 'Opening links and folders is not available in this build');
  const keys = Object.keys(command);
  const done = (target: Record<string, unknown>): ParamountResult => {
    deps.logStep?.({ kind: 'paramount-shell', cid, step: 'opened', type: command.type, ...target });
    const event: ParamountEvent = { id: randomUUID(), at: new Date().toISOString(), actor: 'you', command: command as ParamountCommand, correlationId: cid };
    return { ok: true, event };
  };
  if (command.type === 'shell.openExternal') {
    if (!keys.every((k) => k === 'type' || k === 'url')) return fail('INVALID_INPUT', 'shell.openExternal accepts only url');
    const link = checkLink(command.url);
    if (!link.ok) return fail(link.code, link.message);
    try {
      await deps.openExternal(link.value);
    } catch (error) {
      return fail('INTERNAL', `The browser did not open the link: ${error instanceof Error ? error.message : String(error)}`, error);
    }
    return done({ url: link.value });
  }
  if (!keys.every((k) => k === 'type' || k === 'app' || k === 'path')) return fail('INVALID_INPUT', 'shell.openIn accepts only app and path');
  if (typeof command.app !== 'string' || !Object.hasOwn(PARAMOUNT_OPEN_IN_APPS, command.app)) {
    return fail('INVALID_INPUT', `app must be one of ${Object.keys(PARAMOUNT_OPEN_IN_APPS).join(', ')}`);
  }
  if (deps.platform !== 'darwin') return fail('UNSUPPORTED', 'Opening a folder in Warp or VS Code is only available on macOS');
  const appName = PARAMOUNT_OPEN_IN_APPS[command.app as ParamountOpenInApp];
  const target = command.app === 'vscode' ? checkLocalPath(command.path, true) : checkFolder(command.path);
  if (!target.ok) return fail(target.code, target.message);
  const launched = await deps.launch(appName, target.value);
  if (!launched.ok) {
    return launched.missingApp
      ? fail('NOT_FOUND', `${appName} is not installed on this Mac`, launched.error)
      : fail('INTERNAL', `${appName} did not open the path: ${launched.error ?? 'unknown error'}`, launched.error);
  }
  return done({ app: command.app, path: target.value });
}
