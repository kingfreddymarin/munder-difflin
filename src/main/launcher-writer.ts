/** Council extension (NSC-227, PRODUCT-STANDARD-IN-APP-RECOVERY): a least-privilege writer for
 *  account launchers defined in shell startup files outside the workspace.
 *
 *  - Scope: the one file that holds the one plain `alias <launcher>='…'` line for a known launcher.
 *    Anything ambiguous (several definitions, a function, a conditional or unsupported line) fails closed.
 *  - Edits: append or remove an allowlisted flag only. No free text.
 *  - Consent: `preview` returns the exact before/after line and a grant for that one change. The grant
 *    lives in memory, is used once and expires. Nothing is remembered per file.
 *  - Safety: the file must be a regular file at its real path, unchanged since the preview. The new
 *    content is syntax-checked in a temp file, a backup is written, the temp file replaces the original
 *    with a rename, and the result is read back. A mismatch restores the backup.
 *  - Privacy: a definition that names a credential variable is refused, and refusals never echo it. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { LAUNCHER_AUTH_ENV } from './council-account-launchers';

/** The exact owner-approved Claude Telegram channel flag that discovery already accepts. */
export const LAUNCHER_WRITER_FLAGS = [{ provider: 'claude', flag: '--channels plugin:telegram@claude-plugins-official' }] as const;
const LAUNCHERS = ['dc', 'dcm', 'dcx', 'dcxm'] as const;
const GRANT_TTL_MS = 5 * 60_000;

export type LauncherWriterCode = 'INVALID_INPUT' | 'INVALID_FLAG' | 'NOT_FOUND' | 'AMBIGUOUS' | 'UNSUPPORTED_DEFINITION'
  | 'CREDENTIAL_IN_DEFINITION' | 'SYMLINK' | 'PATH_CHANGED' | 'NO_CHANGE' | 'GRANT_INVALID' | 'GRANT_EXPIRED'
  | 'FILE_CHANGED' | 'SYNTAX_FAILED' | 'VERIFY_FAILED' | 'WRITE_FAILED';
export type LauncherWriterRefusal = { ok: false; code: LauncherWriterCode; message: string; restored?: boolean; backup?: string };
export type LauncherPreview = { ok: true; grantId: string; file: string; alias: string; before: string; after: string; expiresAt: number };
export type LauncherApplied = { ok: true; file: string; backup: string };
export interface LauncherChangeRequest { alias: string; op: 'append' | 'remove'; flag: string }

interface WriterFs {
  lstatSync(path: string): { isSymbolicLink(): boolean; isFile(): boolean; dev: number; ino: number; mode: number };
  realpathSync(path: string): string;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string, options: { mode: number; flag: string }): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  chmodSync?(path: string, mode: number): void;
}
export interface LauncherWriterDeps {
  /** Absolute paths of the shell startup files that may define launchers (e.g. ~/.zshrc). */
  candidates(): string[];
  /** Parse-only syntax check of a file (zsh/bash `-n`); never runs it. */
  syntaxCheck(file: string): { ok: boolean };
  now(): number;
  randomId(): string;
  fs?: WriterFs;
}

interface Grant { file: string; dev: number; ino: number; mode: number; originalHash: string; newContent: string; newHash: string; alias: string; after: string; expiresAt: number }

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const refuse = (code: LauncherWriterCode, message: string, extra: Partial<LauncherWriterRefusal> = {}): LauncherWriterRefusal => ({ ok: false, code, message, ...extra });
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One plain alias line; the value is single- or double-quoted with nothing after it. */
function plainAlias(line: string, alias: string): { head: string; quote: string; value: string } | null {
  const m = new RegExp(`^(\\s*alias\\s+${alias}=)(['"])([^'"\\n]*)\\2\\s*$`).exec(line);
  return m ? { head: m[1], quote: m[2], value: m[3] } : null;
}

/** Literal words only: no substitution, chaining, redirection or escapes; `$HOME` is the one variable. */
function literalValue(value: string): boolean {
  return !/[`\n\r\0;&|<>\\]/.test(value) && !/\$(?!HOME\b|\{HOME\})/.test(value);
}

function launcherProvider(value: string): string | null {
  const command = value.trim().split(/\s+/).find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  return command ? basename(command) : null;
}

export function createLauncherWriter(deps: LauncherWriterDeps) {
  const fs: WriterFs = deps.fs ?? { lstatSync, realpathSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync };
  const grants = new Map<string, Grant>();

  /** The one file and line defining `alias`, or a refusal. Never returns a definition with credentials. */
  function locate(alias: string): { file: string; content: string; index: number; line: string; value: string; quote: string; head: string } | LauncherWriterRefusal {
    const mention = new RegExp(`\\balias\\s+${alias}=`);
    const fn = new RegExp(`^\\s*(?:function\\s+${alias}\\b|${alias}\\s*\\(\\s*\\))`);
    const hits: Array<{ file: string; content: string; index: number; line: string }> = [];
    let functions = 0;
    for (const file of deps.candidates()) {
      let content: string;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
      content.split('\n').forEach((line, index) => {
        if (mention.test(line)) hits.push({ file, content, index, line });
        if (fn.test(line)) functions += 1;
      });
    }
    if (functions || hits.length > 1) return refuse('AMBIGUOUS', `More than one definition of ${alias} was found. Edit it by hand.`);
    if (!hits.length) return refuse('NOT_FOUND', `No alias definition of ${alias} was found in the shell startup files.`);
    const hit = hits[0];
    const parsed = plainAlias(hit.line, alias);
    if (!parsed || !literalValue(parsed.value)) return refuse('UNSUPPORTED_DEFINITION', `The definition of ${alias} is not a plain alias line Paramount can edit safely.`);
    if (LAUNCHER_AUTH_ENV.some((name) => new RegExp(`\\b${name}\\b`).test(parsed.value))) {
      return refuse('CREDENTIAL_IN_DEFINITION', `The definition of ${alias} sets a credential variable. Paramount will not show or edit it.`);
    }
    return { ...hit, ...parsed };
  }

  /** A regular file at its real path; the identity the grant is bound to. */
  function checkPath(file: string): { dev: number; ino: number; mode: number } | LauncherWriterRefusal {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return refuse('SYMLINK', 'The launcher file is a symbolic link. Paramount edits only regular files.');
    if (!stat.isFile() || fs.realpathSync(file) !== file) return refuse('PATH_CHANGED', 'The launcher file path changed.');
    return { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777 };
  }

  function preview(request: LauncherChangeRequest): LauncherPreview | LauncherWriterRefusal {
    if (!request || !(LAUNCHERS as readonly string[]).includes(request.alias) || (request.op !== 'append' && request.op !== 'remove')) {
      return refuse('INVALID_INPUT', 'Choose a known launcher and append or remove.');
    }
    const allowed = LAUNCHER_WRITER_FLAGS.find((entry) => entry.flag === request.flag);
    if (!allowed) return refuse('INVALID_FLAG', 'That flag is not on the list Paramount may change.');
    const found = locate(request.alias);
    if ('ok' in found) return found;
    if (launcherProvider(found.value) !== allowed.provider) return refuse('INVALID_FLAG', `That flag is for ${allowed.provider} launchers only.`);
    let path: ReturnType<typeof checkPath>;
    try { path = checkPath(found.file); } catch { return refuse('PATH_CHANGED', 'The launcher file could not be checked.'); }
    if ('ok' in path) return path;
    const present = new RegExp(`(^|\\s)${escape(allowed.flag).replace(' ', '\\s+')}(?=\\s|$)`, 'g');
    const matches = found.value.match(present)?.length ?? 0;
    let value: string;
    if (request.op === 'append') {
      if (matches) return refuse('NO_CHANGE', 'The launcher already has that flag.');
      if (/(^|\s)--channels(\s|$)/.test(found.value)) return refuse('UNSUPPORTED_DEFINITION', 'The launcher already sets another channel. Edit it by hand.');
      value = `${found.value.trimEnd()} ${allowed.flag}`;
    } else {
      if (!matches) return refuse('NO_CHANGE', 'The launcher does not have that flag.');
      if (matches > 1) return refuse('AMBIGUOUS', 'The flag appears more than once. Edit it by hand.');
      value = found.value.replace(present, '').trimEnd();
    }
    const after = `${found.head}${found.quote}${value}${found.quote}`;
    const lines = found.content.split('\n');
    lines[found.index] = after;
    const newContent = lines.join('\n');
    const grantId = deps.randomId();
    const expiresAt = deps.now() + GRANT_TTL_MS;
    grants.set(grantId, { file: found.file, ...path, originalHash: sha(found.content), newContent, newHash: sha(newContent), alias: request.alias, after, expiresAt });
    return { ok: true, grantId, file: found.file, alias: request.alias, before: found.line, after, expiresAt };
  }

  /** The file is still the one previewed: same identity and the same bytes. */
  function unchanged(grant: Grant): LauncherWriterRefusal | null {
    const path = checkPath(grant.file);
    if ('ok' in path) return refuse('PATH_CHANGED', 'The launcher file path changed since the preview. Nothing was written.');
    if (path.dev !== grant.dev || path.ino !== grant.ino) return refuse('PATH_CHANGED', 'The launcher file was replaced since the preview. Nothing was written.');
    if (sha(fs.readFileSync(grant.file, 'utf8')) !== grant.originalHash) return refuse('FILE_CHANGED', 'The launcher file changed since the preview. Preview again.');
    return null;
  }

  function writeReplacing(file: string, content: string, mode: number): void {
    const temp = join(dirname(file), `.${basename(file)}.paramount-${deps.randomId()}.tmp`);
    fs.writeFileSync(temp, content, { mode, flag: 'wx' });
    try { fs.chmodSync?.(temp, mode); fs.renameSync(temp, file); }
    catch (error) { try { fs.unlinkSync(temp); } catch { /* already gone */ } throw error; }
  }

  function apply(grantId: string): LauncherApplied | LauncherWriterRefusal {
    const grant = grants.get(grantId);
    grants.delete(grantId);
    if (!grant) return refuse('GRANT_INVALID', 'This change was not previewed, or was already used. Preview it again.');
    if (deps.now() > grant.expiresAt) return refuse('GRANT_EXPIRED', 'The preview expired. Preview it again.');
    const dir = dirname(grant.file);
    const name = basename(grant.file);
    let temp: string | null = null;
    let backup: string | null = null;
    try {
      const changed = unchanged(grant);
      if (changed) return changed;
      const original = fs.readFileSync(grant.file, 'utf8');
      temp = join(dir, `.${name}.paramount-${deps.randomId()}.tmp`);
      fs.writeFileSync(temp, grant.newContent, { mode: grant.mode, flag: 'wx' });
      fs.chmodSync?.(temp, grant.mode);
      if (!deps.syntaxCheck(temp).ok) return refuse('SYNTAX_FAILED', 'The edited file failed the shell syntax check. Nothing was written.');
      backup = join(dir, `${name}.paramount-backup-${deps.now()}-${deps.randomId()}`);
      fs.writeFileSync(backup, original, { mode: 0o600, flag: 'wx' });
      // Last check right before the swap: nothing changed while the temp file was checked.
      const late = unchanged(grant);
      if (late) { fs.unlinkSync(backup); backup = null; return late; }
      fs.renameSync(temp, grant.file);
      temp = null;
    } catch {
      if (backup) { try { fs.unlinkSync(backup); } catch { /* keep going */ } }
      return refuse('WRITE_FAILED', 'The launcher file could not be written. Nothing was changed.');
    } finally {
      if (temp) { try { fs.unlinkSync(temp); } catch { /* already gone */ } }
    }
    // Read back: the bytes written, at the same real path, with the expected line.
    let verified = false;
    try {
      const stat = fs.lstatSync(grant.file);
      const content = fs.readFileSync(grant.file, 'utf8');
      verified = !stat.isSymbolicLink() && sha(content) === grant.newHash && content.split('\n').includes(grant.after);
    } catch { verified = false; }
    if (verified) return { ok: true, file: grant.file, backup: backup! };
    let restored = false;
    try {
      const saved = fs.readFileSync(backup!, 'utf8');
      writeReplacing(grant.file, saved, grant.mode);
      restored = sha(fs.readFileSync(grant.file, 'utf8')) === grant.originalHash;
    } catch { restored = false; }
    return refuse('VERIFY_FAILED', restored
      ? 'The written file did not match what was previewed. The backup was restored.'
      : 'The written file did not match what was previewed, and the backup could not be restored. Restore it from the backup file.', { restored, backup: backup! });
  }

  return { preview, apply, discard: (grantId: string) => { grants.delete(grantId); } };
}

/** Parse-only syntax checks; startup files are not read (-f) and nothing is executed (-n). */
export function zshSyntaxCheck(file: string): { ok: boolean } {
  const result = spawnSync('/bin/zsh', ['-f', '-n', file], { timeout: 5000, stdio: 'ignore' });
  return { ok: result.status === 0 };
}
export function bashSyntaxCheck(file: string): { ok: boolean } {
  const result = spawnSync('/bin/bash', ['--norc', '--noprofile', '-n', file], { timeout: 5000, stdio: 'ignore' });
  return { ok: result.status === 0 };
}
