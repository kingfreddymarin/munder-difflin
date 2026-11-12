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
