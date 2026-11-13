import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export const TELEGRAM_CHANNEL = 'plugin:telegram@claude-plugins-official';
export interface ClaudeChannelPlan { original: string; updated: string; changed: string[]; sha256: string }
export interface ClaudeChannelFileInfo { isFile(): boolean; isSymbolicLink(): boolean; mode: number; dev?: number; ino?: number }
export interface ClaudeChannelFileOps {
  lstat(path: string): ClaudeChannelFileInfo;
  readFile(path: string): string;
  copyFile(source: string, target: string): void;
  writeFile(path: string, text: string, mode: number, exclusive: boolean): void;
  chmod(path: string, mode: number): void;
  rename(source: string, target: string): void;
  unlink(path: string): void;
}
export interface ClaudeChannelUpdateResult {
  ok: boolean;
  canceled?: boolean;
  alreadyConfigured?: boolean;
  planId?: string;
  target?: string;
  changed?: string[];
  backup?: string;
  recovery?: 'unchanged' | 'restored' | 'manual-restore';
  error?: string;
}

/** Prepare a narrowly scoped edit to the three documented Claude launcher functions. */
export function prepareClaudeTelegramChannel(original: string, syntaxCheck: (text: string) => boolean): ClaudeChannelPlan {
  let updated = original;
  const changed: string[] = [];
  for (const name of ['claude', 'dc', 'dcm']) {
    const pattern = new RegExp(`^function ${name}\\(\\)\\s*\\{[\\s\\S]*?^\\}`, 'm');
    const match = pattern.exec(updated);
    if (!match) throw new Error(`Missing launcher ${name}; no changes made.`);
    const body = match[0];
    if (body.includes(`--channels ${TELEGRAM_CHANNEL}`)) continue;
    if (body.includes('--channels')) throw new Error(`${name} already configures channels; no changes made.`);
    const line = /^(\s*(?:CLAUDE_CONFIG_DIR="\$HOME\/\.claude-minion"\s+)?command claude[^\n]*?)\s+"\$@"\s*$/m;
    const replacement = body.replace(line, (_all, prefix: string) => `${prefix} --channels ${TELEGRAM_CHANNEL} "$@"`);
    if (replacement === body) throw new Error(`Unexpected ${name} definition; no changes made.`);
    updated = updated.slice(0, match.index) + replacement + updated.slice(match.index + body.length);
    changed.push(name);
  }
  if (!syntaxCheck(updated)) throw new Error('The proposed shell configuration failed syntax checking; no changes made.');
  return { original, updated, changed, sha256: createHash('sha256').update(original).digest('hex') };
}

interface PendingPlan { plan: ClaudeChannelPlan; mode: number; dev?: number; ino?: number; expiresAt: number }
const modeOf = (info: ClaudeChannelFileInfo): number => info.mode & 0o777;
const sameIdentity = (left: ClaudeChannelFileInfo, right: Pick<PendingPlan, 'dev' | 'ino'>): boolean =>
  (right.dev === undefined || left.dev === right.dev) && (right.ino === undefined || left.ino === right.ino);
const isRegularFile = (info: ClaudeChannelFileInfo): boolean => info.isFile() && !info.isSymbolicLink();
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * One-use, fixed-target writer. The injected file boundary makes the exact
 * prepare/apply/restore state machine testable with temporary files and faults.
 */
export function createClaudeChannelUpdater(options: {
  targetPath: string;
  file: ClaudeChannelFileOps;
  syntaxCheck(text: string): boolean;
  now?: () => number;
  token?: () => string;
}) {
  const now = options.now ?? Date.now;
  const token = options.token ?? (() => randomBytes(24).toString('hex'));
  const pending = new Map<string, PendingPlan>();
  const displayPath = (path: string) => `~/${basename(path)}`;

  const checkTarget = (record?: PendingPlan): ClaudeChannelFileInfo => {
    const info = options.file.lstat(options.targetPath);
    if (!isRegularFile(info)) throw new Error('The launcher file must remain a regular file, not a link.');
    if (record && !sameIdentity(info, record)) throw new Error('The launcher file was replaced after review. Prepare the update again.');
    return info;
  };

  const verifyPath = (path: string, expectedHash: string, expectedMode: number): boolean => {
    const info = options.file.lstat(path);
    return isRegularFile(info) && modeOf(info) === expectedMode
      && digest(options.file.readFile(path)) === expectedHash
      && options.syntaxCheck(options.file.readFile(path));
  };

  const restoreBackup = (backup: string, record: PendingPlan, restoreTemp: string): { ok: boolean; error?: string } => {
    try {
      options.file.copyFile(backup, restoreTemp);
      options.file.chmod(restoreTemp, record.mode);
      if (!verifyPath(restoreTemp, record.plan.sha256, record.mode)) throw new Error('The restoration copy did not match the verified backup.');
      options.file.rename(restoreTemp, options.targetPath);
      if (!verifyPath(options.targetPath, record.plan.sha256, record.mode)) throw new Error('Restored file verification failed.');
      return { ok: true };
    } catch (error) {
      try { options.file.unlink(restoreTemp); } catch { /* absent or already renamed */ }
      return { ok: false, error: error instanceof Error ? error.message : 'Restore failed.' };
    }
  };

  return {
    prepare(selectedPath: string): ClaudeChannelUpdateResult {
      if (selectedPath !== options.targetPath) return { ok: false, error: 'Choose ~/.minion-aliases.sh so Paramount changes only the documented Claude launcher file.' };
      try {
        const info = checkTarget();
        const original = options.file.readFile(options.targetPath);
        const plan = prepareClaudeTelegramChannel(original, options.syntaxCheck);
        if (!plan.changed.length) return { ok: true, alreadyConfigured: true, target: displayPath(options.targetPath) };
        const planId = token();
        pending.set(planId, { plan, mode: modeOf(info), dev: info.dev, ino: info.ino, expiresAt: now() + 5 * 60_000 });
        return { ok: true, planId, target: displayPath(options.targetPath), changed: plan.changed };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Could not prepare the launcher update.' }; }
    },

    apply(planId: unknown): ClaudeChannelUpdateResult {
      if (typeof planId !== 'string' || !/^[a-f0-9]{48}$/.test(planId)) return { ok: false, error: 'The prepared update is invalid; prepare it again.', recovery: 'unchanged' };
      const record = pending.get(planId);
      pending.delete(planId);
      if (!record || record.expiresAt < now()) return { ok: false, error: 'The prepared update expired; prepare it again.', recovery: 'unchanged' };

      let backup: string | undefined;
      let temporary: string | undefined;
      let replaced = false;
      const backupDisplay = () => backup ? displayPath(backup) : undefined;
      const restoreAfterFailure = (cause: unknown): ClaudeChannelUpdateResult => {
        if (!replaced || !backup) return { ok: false, error: cause instanceof Error ? cause.message : 'Could not safely update the launcher file.', recovery: 'unchanged', ...(backupDisplay() ? { backup: backupDisplay() } : {}) };
        const restoreTemp = join(dirname(options.targetPath), `.minion-aliases-restore-${token().slice(0, 16)}.tmp`);
        const restored = restoreBackup(backup, record, restoreTemp);
        if (restored.ok) return { ok: false, error: `Update verification failed; the original file was restored from ${backupDisplay()}.`, recovery: 'restored', backup: backupDisplay() };
        return { ok: false, error: `Update verification or restoration failed (${restored.error ?? 'unknown error'}). The target may contain unverified content; restore the verified backup manually from ${backupDisplay()}.`, recovery: 'manual-restore', backup: backupDisplay() };
      };

      try {
        const before = checkTarget(record);
        if (modeOf(before) !== record.mode || digest(options.file.readFile(options.targetPath)) !== record.plan.sha256) {
          return { ok: false, error: 'The launcher file changed after review. No changes were made; prepare it again.', recovery: 'unchanged' };
        }
        if (!options.syntaxCheck(record.plan.updated)) return { ok: false, error: 'The shell syntax check failed; no changes were made.', recovery: 'unchanged' };

        const suffix = `${now()}-${token().slice(0, 12)}`;
        backup = `${options.targetPath}.backup-${suffix}`;
        options.file.copyFile(options.targetPath, backup);
        options.file.chmod(backup, record.mode);
        if (!verifyPath(backup, record.plan.sha256, record.mode)) {
          return { ok: false, error: `Backup verification failed; no changes were made. Inspect or remove ${displayPath(backup)}.`, recovery: 'unchanged', backup: displayPath(backup) };
        }

        temporary = join(dirname(options.targetPath), `.minion-aliases-${token().slice(0, 16)}.tmp`);
        options.file.writeFile(temporary, record.plan.updated, record.mode, true);
        options.file.chmod(temporary, record.mode);
        if (!verifyPath(temporary, digest(record.plan.updated), record.mode)) throw new Error('The temporary update failed content, mode, or syntax verification.');

        // Minimize the non-cooperating-editor race: compare both inode identity
        // and bytes immediately before replacing the reviewed directory entry.
        const finalInfo = checkTarget(record);
        if (modeOf(finalInfo) !== record.mode || digest(options.file.readFile(options.targetPath)) !== record.plan.sha256) {
          return { ok: false, error: 'The launcher file changed during preparation. No changes were made; prepare it again.', recovery: 'unchanged', backup: displayPath(backup) };
        }
        options.file.rename(temporary, options.targetPath);
        temporary = undefined;
        replaced = true;
        if (!verifyPath(options.targetPath, digest(record.plan.updated), record.mode)) return restoreAfterFailure(new Error('The updated launcher failed content, mode, or syntax verification.'));
        return { ok: true, target: displayPath(options.targetPath), backup: displayPath(backup), changed: record.plan.changed, recovery: 'unchanged' };
      } catch (error) {
        return restoreAfterFailure(error);
      } finally {
        if (temporary) try { options.file.unlink(temporary); } catch { /* absent or already removed */ }
      }
    },
  };
}
