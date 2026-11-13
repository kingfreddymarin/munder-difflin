// Is each installed engine CLI signed in? (Owner run of ceeb4aaf: Codex was installed but its refresh
// token had been revoked, and nothing said so; agents just died.) Two sources:
//  - the CLI's own status command (`claude auth status`, `codex login status`), run in the
//    background at most every STATUS_TTL_MS so the 4-second snapshot never waits on it or spawns it;
//  - an agent that exits abnormally with a sign-in error in its last output (a revoked refresh
//    token is only seen when the CLI tries to use it). This one stays until the app restarts,
//    because a status command can still report signed in with a revoked token.
// Each result names the exact fix. Exit 0 means signed in; any other exit means signed out; a
// timeout or a spawn error is "unknown" and is not flagged.
import { execFile } from 'node:child_process';

export type SignInEngine = 'claude' | 'codex';
export type SignInState = { state: 'signed-in' | 'unknown' } | { state: 'signed-out' | 'expired'; fix: string; seen?: string };

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

type Run = (bin: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; error?: boolean }>;
const runStatus: Run = (bin, args, timeoutMs) => new Promise((done) => {
  execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (error) => {
    if (!error) return done({ code: 0 });
    const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
    done(typeof e.code === 'number' && !e.killed ? { code: e.code } : { code: null, error: true });
  });
});

export function createSignInMonitor(opts: { path: (engine: SignInEngine) => string | null; now?: () => number; run?: Run }) {
  const now = opts.now ?? Date.now;
  const run = opts.run ?? runStatus;
  const probed = new Map<SignInEngine, { at: number; state: 'signed-in' | 'signed-out' | 'unknown' }>();
  const pending = new Set<SignInEngine>();
  const expired = new Map<SignInEngine, string>();
  const probe = (engine: SignInEngine): void => {
    const bin = opts.path(engine);
    const last = probed.get(engine);
    if (!bin || pending.has(engine) || (last && now() - last.at < STATUS_TTL_MS)) return;
    pending.add(engine);
    void run(bin, STATUS_ARGS[engine], 8000).then((r) => {
      probed.set(engine, { at: now(), state: r.error || r.code === null ? 'unknown' : r.code === 0 ? 'signed-in' : 'signed-out' });
    }).finally(() => pending.delete(engine));
  };
  return {
    /** Current knowledge for an installed engine; starts a background status check when stale. */
    status(engine: SignInEngine): SignInState {
      probe(engine);
      const seen = expired.get(engine);
      if (seen) return { state: 'expired', fix: SIGN_IN_FIX[engine], seen };
      const p = probed.get(engine)?.state ?? 'unknown';
      return p === 'signed-out' ? { state: 'signed-out', fix: SIGN_IN_FIX[engine] } : { state: p };
    },
    /** An agent on `engine` exited abnormally with this output tail. */
    agentExited(engine: string, tail: string | undefined): void {
      if ((engine === 'claude' || engine === 'codex') && signInFailure(engine, tail)) {
        expired.set(engine, new Date(now()).toISOString());
        probed.delete(engine);
      }
    },
  };
}
