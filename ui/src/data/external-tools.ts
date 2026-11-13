// Owner 2026-11-12: the .dmg is the only download. What Paramount still needs from this Mac is
// reported on first launch (the setup dialog lists required pieces that are not ready).
import type { Snapshot } from './types';
/** The tools Paramount needs outside its own bundle, from main's login-PATH lookup. Missing from
 *  older cores (no `tools`): nothing is reported rather than a false "missing". */
export function externalTools(tools: Record<string, unknown>): Snapshot['prerequisites'] {
  const found = (id: string) => { const t = tools[id]; return t && typeof t === 'object' ? typeof (t as { path?: unknown }).path === 'string' && !!(t as { path: string }).path : null; };
  const out: Snapshot['prerequisites'] = [];
  const claude = found('claude');
  if (claude !== null) out.push({ id: 'claude-cli', name: 'Claude Code CLI (claude)', level: 'required',
    state: claude ? 'ready' : 'missing', detail: claude ? 'Found on your login PATH' : 'Not found on your login PATH',
    why: claude ? 'Paramount starts every agent with it.' : 'Paramount starts every agent with the claude command and cannot run agents without it. Install Claude Code, sign in once in Terminal, then reopen Paramount.' });
  const codexRaw = tools.codex && typeof tools.codex === 'object' ? tools.codex as { path?: unknown; required?: unknown } : null;
  const codex = codexRaw ? typeof codexRaw.path === 'string' && !!codexRaw.path : null;
  if (codex !== null) out.push({ id: 'codex-cli', name: 'Codex CLI (codex)', level: codexRaw?.required === true ? 'required' : 'recommended', state: codex ? 'ready' : 'missing', detail: codex ? 'Found on your login PATH' : 'Not found on your login PATH', why: 'Codex agents need this command. Paramount reports account sign-in independently for each selected Codex launcher.' });
  const palace = found('mempalace');
  if (palace !== null) out.push({ id: 'mempalace', name: 'MemPalace (mempalace)', level: 'optional',
    state: palace ? 'ready' : 'missing', detail: palace ? 'Found on your login PATH' : 'Not installed',
    why: 'Optional semantic search over agent memory. Without it, agents still read and write their memory files.' });
  return out;
}

/** Installed engines that are not signed in, with the exact command that fixes it. */
export function engineSignIns(signIn: Record<string, unknown>): Snapshot['prerequisites'] {
  const label: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
  return Object.entries(signIn).flatMap(([engine, raw]) => {
    const s = raw && typeof raw === 'object' ? raw as { state?: unknown; seen?: unknown; accountId?: unknown; accountLabel?: unknown; accountFingerprint?: unknown } : {};
    const provider = engine.split('-', 1)[0];
    if (!['signed-in', 'signed-out', 'expired', 'unknown'].includes(String(s.state)) || !label[provider]) return [];
    const account = typeof s.accountLabel === 'string' ? ` (${s.accountLabel})` : '';
    const idSuffix = typeof s.accountId === 'string' ? `-${s.accountId}` : '';
    const state = s.state === 'signed-in' ? 'ready' as const : s.state === 'unknown' ? 'unknown' as const : 'missing' as const;
    const detail = s.state === 'signed-in' ? 'Signed in for this launcher account' : s.state === 'unknown' ? 'Status unknown; check again for this account' : s.state === 'expired' ? `Sign-in expired${typeof s.seen === 'string' ? ` (agent failed at ${new Date(s.seen).toLocaleTimeString()})` : ''}` : 'Signed out for this launcher account';
    return [{ id: `signin-${provider}${idSuffix}`, name: `${label[provider]}${account} sign-in`, level: 'required' as const, state, detail,
      why: state === 'ready' ? `Status was checked for ${s.accountLabel ?? 'the provider default'}; credentials remain in the CLI's login flow.` : `${label[provider]} status is scoped to ${s.accountLabel ?? 'the provider default'}. Use the action below for this account; no credential is copied into Paramount.`,
      signInProvider: provider as 'claude' | 'codex',
      ...(typeof s.accountId === 'string' ? { signInAccountId: s.accountId } : {}),
      ...(typeof s.accountFingerprint === 'string' ? { signInAccountFingerprint: s.accountFingerprint } : {}),
      ...(typeof s.accountLabel === 'string' ? { signInAccountLabel: s.accountLabel } : {}) }];
  });
}

/** "Continue anyway" covers the blockers it was pressed for; a new required one (a sign-in that
 *  expired later) opens the setup dialog again. */
export function setupDismissedFor(setup: Record<string, unknown>, prerequisites: Snapshot['prerequisites']): boolean {
  if (setup.dismissed !== true) return false;
  const covered = new Set(Array.isArray(setup.degraded) ? setup.degraded.filter((d): d is string => typeof d === 'string') : []);
  return prerequisites.every((p) => p.level !== 'required' || p.state === 'ready' || covered.has(p.name));
}
