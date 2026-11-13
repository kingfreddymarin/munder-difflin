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
    const s = raw && typeof raw === 'object' ? raw as { state?: unknown; fix?: unknown; seen?: unknown } : {};
    if ((s.state !== 'signed-out' && s.state !== 'expired') || typeof s.fix !== 'string' || !label[engine]) return [];
    return [{ id: `signin-${engine}`, name: `${label[engine]} sign-in`, level: 'required' as const, state: 'missing' as const,
      detail: s.state === 'expired' ? `Sign-in expired${typeof s.seen === 'string' ? ` (an agent stopped on it at ${new Date(s.seen).toLocaleTimeString()})` : ''}` : 'Installed but not signed in',
      why: `${label[engine]} agents cannot start until you sign in again. ${s.fix}` }];
  });
}

/** "Continue anyway" covers the blockers it was pressed for; a new required one (a sign-in that
 *  expired later) opens the setup dialog again. */
export function setupDismissedFor(setup: Record<string, unknown>, prerequisites: Snapshot['prerequisites']): boolean {
  if (setup.dismissed !== true) return false;
  const covered = new Set(Array.isArray(setup.degraded) ? setup.degraded.filter((d): d is string => typeof d === 'string') : []);
  return prerequisites.every((p) => p.level !== 'required' || p.state === 'ready' || covered.has(p.name));
}
