// Is each installed engine CLI signed in? (Owner run of ceeb4aaf: Codex was installed but its refresh
// token had been revoked, and nothing said so; agents just died.) Two sources:
//  - the CLI's own status command (`claude auth status`, `codex login status`), run in the
//    background at most every STATUS_TTL_MS so the 4-second snapshot never waits on it or spawns it;
//  - an agent that exits abnormally with a sign-in error in its last output (a revoked refresh
//    token is only seen when the CLI tries to use it). This one stays until the app restarts,
//    because a status command can still report signed in with a revoked token.
// Each result names the exact fix. Exit 0 means signed in; any other exit means signed out; a
// timeout or a spawn error is "unknown" and is not flagged.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LAUNCHER_AUTH_ENV } from './council-account-launchers';

export type SignInEngine = 'claude' | 'codex';
export type SignInAccount = { id: string; label: string; home: string; fingerprint?: string; bin?: string };
export type SignInState = { state: 'signed-in' | 'unknown'; accountId?: string; accountLabel?: string; accountFingerprint?: string } | { state: 'signed-out' | 'expired'; fix: string; seen?: string; accountId?: string; accountLabel?: string; accountFingerprint?: string };

export const SIGN_IN_FIX: Record<SignInEngine, string> = {
  claude: 'Run `claude auth login` in Terminal, then start the agent again.',
  codex: 'Run `codex login` in Terminal, then start the agent again.',
};
const STATUS_ARGS: Record<SignInEngine, string[]> = { claude: ['auth', 'status'], codex: ['login', 'status'] };
export const STATUS_TTL_MS = 5 * 60_000;
const SIGN_IN_ERROR = /refresh token (?:was |has been )?revoked|not logged in|please (?:log|sign) ?in|(?:run|use) `?(?:codex login|claude auth login|\/login)|invalid api key|authentication (?:failed|required)|401 unauthorized/i;

/** The fix for an agent whose last output shows a sign-in failure, else null. */
export function signInFailure(engine: string, tail: string | undefined): string | null {
  if (engine !== 'claude' && engine !== 'codex') return null;
  return tail && SIGN_IN_ERROR.test(tail) ? SIGN_IN_FIX[engine] : null;
}

type Run = (bin: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv) => Promise<{ code: number | null; error?: boolean }>;
const runStatus: Run = (bin, args, timeoutMs, env) => new Promise((done) => {
  execFile(bin, args, { timeout: timeoutMs, windowsHide: true, ...(env ? { env } : {}) }, (error) => {
    if (!error) return done({ code: 0 });
    const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
    done(typeof e.code === 'number' && !e.killed ? { code: e.code } : { code: null, error: true });
  });
});

/** Shared by status probes and interactive login: never silently switch default homes. */
export function resolveSignInAccountHome(engine: SignInEngine, account?: SignInAccount, env: NodeJS.ProcessEnv = process.env): string {
  return account?.home ?? (env[engine === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']?.trim() || join(homedir(), engine === 'codex' ? '.codex' : '.claude'));
}
export function signInAccountKey(engine: SignInEngine, account?: SignInAccount, env: NodeJS.ProcessEnv = process.env): string {
  return createHash('sha256').update(JSON.stringify([engine, account?.id ?? 'default', account?.fingerprint ?? '', resolveSignInAccountHome(engine, account, env), account?.bin ?? engine])).digest('hex');
}

export function createSignInMonitor(opts: { path: (engine: SignInEngine) => string | null; resolvePath?: (engine: SignInEngine) => Promise<string | null>; now?: () => number; run?: Run }) {
  const now = opts.now ?? Date.now;
  const run = opts.run ?? runStatus;
  const keyFor = signInAccountKey;
  const probed = new Map<string, { at: number; state: 'signed-in' | 'signed-out' | 'unknown' }>();
  const pending = new Map<string, Promise<void>>();
  const expired = new Map<string, string>();
  const environment = (engine: SignInEngine, account?: SignInAccount): NodeJS.ProcessEnv | undefined => {
    const env = { ...process.env };
    for (const name of LAUNCHER_AUTH_ENV) delete env[name];
    env[engine === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = resolveSignInAccountHome(engine, account);
    return env;
  };
  const probe = (engine: SignInEngine, account?: SignInAccount): void => {
    const key = keyFor(engine, account);
    const bin = account?.bin ?? opts.path(engine);
    const last = probed.get(key);
    if (!bin || pending.has(key) || (last && now() - last.at < STATUS_TTL_MS)) return;
    const check = run(bin, STATUS_ARGS[engine], 8000, environment(engine, account)).then((r) => {
      probed.set(key, { at: now(), state: r.error || r.code === null ? 'unknown' : r.code === 0 ? 'signed-in' : 'signed-out' });
    }).catch(() => { probed.set(key, { at: now(), state: 'unknown' }); }).finally(() => pending.delete(key));
    pending.set(key, check);
  };
  const fields = (account?: SignInAccount) => account ? { accountId: account.id, accountLabel: account.label, ...(account.fingerprint ? { accountFingerprint: account.fingerprint } : {}) } : {};
  const stateFor = (engine: SignInEngine, account?: SignInAccount, key = keyFor(engine, account)): SignInState => {
    const accountFields = fields(account);
    const seen = expired.get(key);
    if (seen) return { state: 'expired', fix: account ? `Sign in to the ${account.label} account in Settings, then start the agent again.` : SIGN_IN_FIX[engine], seen, ...accountFields };
    const p = probed.get(key)?.state ?? 'unknown';
    return p === 'signed-out' ? { state: 'signed-out', fix: account ? `Sign in to the ${account.label} account in Settings, then start the agent again.` : SIGN_IN_FIX[engine], ...accountFields } : { state: p, ...accountFields };
  };
  return {
    /** Current knowledge for an installed engine; starts a background status check when stale. */
    status(engine: SignInEngine, account?: SignInAccount): SignInState {
      probe(engine, account);
      return stateFor(engine, account);
    },
    /** Force a status check for this exact account and return the refreshed result. */
    async refresh(engine: SignInEngine, account?: SignInAccount): Promise<SignInState> {
      const key = keyFor(engine, account);
      const env = environment(engine, account);
      const bin = account?.bin ?? (opts.resolvePath ? await opts.resolvePath(engine) : opts.path(engine));
      if (!bin) return { state: 'unknown', ...fields(account) };
      expired.delete(key);
      probed.set(key, { at: now(), state: 'unknown' });
      const running = pending.get(key);
      if (running) await running;
      const check = (async () => {
      try {
        const result = await run(bin, STATUS_ARGS[engine], 8000, env);
        probed.set(key, { at: now(), state: result.error || result.code === null ? 'unknown' : result.code === 0 ? 'signed-in' : 'signed-out' });
      } catch { probed.set(key, { at: now(), state: 'unknown' }); }
      })().finally(() => pending.delete(key));
      pending.set(key, check);
      await check;
      return stateFor(engine, account, key);
    },
    /** An agent on `engine` exited abnormally with this output tail. */
    agentExited(engine: string, tail: string | undefined, account?: SignInAccount): void {
      if ((engine === 'claude' || engine === 'codex') && signInFailure(engine, tail)) {
        const key = keyFor(engine, account);
        expired.set(key, new Date(now()).toISOString());
        probed.delete(key);
      }
    },
  };
}
