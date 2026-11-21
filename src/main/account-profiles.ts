import { randomBytes, createHash } from 'node:crypto';
import { lstatSync, mkdirSync, rmdirSync, realpathSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type AccountProvider = 'claude' | 'codex';
type Entry = { id: string; provider: AccountProvider; label: string };
export type AccountProfile = Entry & { source: 'managed'; fingerprint: string; unrestricted: false; bin: AccountProvider; args: string[]; home: string };
export const isManagedAccountId = (id: unknown): id is string => typeof id === 'string' && /^acct_[a-f0-9]{24}$/.test(id);
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Account label must contain 1–80 printable characters.');
  return value.trim();
}
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function directory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Account storage must be a real directory.');
}
export function publicAccountProfile(profile: AccountProfile) {
  return { id: profile.id, provider: profile.provider, label: profile.label, source: profile.source, fingerprint: profile.fingerprint, unrestricted: profile.unrestricted };
}
/** Main-process only. The caller chooses an application-owned base; renderer inputs never name paths. */
export function createAccountProfileStore(baseDir: string) {
  const requested = resolve(baseDir);
  if (!present(requested)) mkdirSync(requested, { recursive: true, mode: 0o700 });
  directory(requested);
  const base = realpathSync(requested);
  const homes = join(base, 'accounts');
  if (!present(homes)) mkdirSync(homes, { mode: 0o700 });
  directory(homes);
  const file = join(base, 'account-profiles.json');
  const read = (): Entry[] => {
    directory(base); directory(homes);
    if (!present(file)) return [];
    try {
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error();
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.version !== 1 || Object.keys(data).some(k => !['version', 'profiles'].includes(k)) || !Array.isArray(data.profiles)) throw new Error();
      const ids = new Set<string>();
      for (const p of data.profiles) {
        if (!p || Object.keys(p).some(k => !['id', 'provider', 'label'].includes(k)) || !isManagedAccountId(p.id) || !['claude', 'codex'].includes(p.provider) || label(p.label) !== p.label || ids.has(p.id)) throw new Error();
        ids.add(p.id);
      }
      return data.profiles;
    } catch { throw new Error('Account catalog is unreadable or unsupported; existing accounts were preserved.'); }
  };
  const profile = (entry: Entry, checkHome = true): AccountProfile => {
    directory(homes);
    const home = join(homes, entry.id);
    if (checkHome) directory(home);
    return { ...entry, source: 'managed', home, bin: entry.provider, args: [], unrestricted: false,
      fingerprint: createHash('sha256').update(JSON.stringify([entry.id, entry.provider, home])).digest('hex') };
  };
  const save = (entries: Entry[]) => {
    // Exclusive temporary files and rename keep readers on either complete catalog revision.
    const tmp = join(base, `.accounts-${randomBytes(12).toString('hex')}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, profiles: entries }, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, file);
  };
  const mutate = <T>(action: () => T): T => {
    directory(base);
    const lock = join(base, '.catalog-write-lock');
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch { throw new Error('Account catalog is busy or needs lock recovery. No changes were made.'); }
    try { return action(); } finally { rmdirSync(lock); }
  };
  return {
    list(): AccountProfile[] {
      return read().flatMap(entry => { try { return [profile(entry)]; } catch { return []; } });
    },
    inventory() {
      return read().map(entry => {
        const p = profile(entry, false);
        let available = true;
        try { directory(p.home); } catch { available = false; }
        return { ...publicAccountProfile(p), available };
      });
    },
    create(input: unknown): AccountProfile {
      return mutate(() => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['provider', 'label'].includes(k))) throw new Error('Only provider and account label are accepted.');
      const data = input as { provider: AccountProvider; label: unknown };
      if (!['claude', 'codex'].includes(data.provider)) throw new Error('Unsupported account provider.');
      const entries = read();
      const entry: Entry = { id: `acct_${randomBytes(12).toString('hex')}`, provider: data.provider, label: label(data.label) };
      mkdirSync(join(homes, entry.id), { mode: 0o700 });
      save([...entries, entry]);
      return profile(entry);
      });
    },
    rename(id: string, value: unknown): AccountProfile {
      return mutate(() => {
      const entries = read();
      const entry = entries.find(p => p.id === id);
      if (!entry) throw new Error('Account profile is unavailable.');
      entry.label = label(value);
      const result = profile(entry);
      save(entries);
      return result;
      });
    },
  };
}
