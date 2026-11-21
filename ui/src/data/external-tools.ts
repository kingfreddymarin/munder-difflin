// What selected providers need from this Mac is reported on first launch; optional tools stay visible.
import type { Snapshot } from './types';
/** CLI readiness comes from main's login-PATH lookup. Only selected engines block; unselected
 *  engines remain visible as recommended. Missing lookups from older cores stay absent. */
export function externalTools(tools: Record<string, unknown>, requiredProviders = new Set(['claude'])): Snapshot['prerequisites'] {
  const found = (id: string) => {
    const t = tools[id];
    if (!t || typeof t !== 'object') return null;
    const item = t as { path?: unknown; state?: unknown };
    if (item.state === 'checking' || item.state === 'unknown') return 'unknown' as const;
    if (item.state === 'ready') return typeof item.path === 'string' && !!item.path ? 'ready' as const : 'unknown' as const;
    if (item.state === 'missing') return 'missing' as const;
    return typeof item.path === 'string' && !!item.path ? 'ready' as const : 'missing' as const;
  };
  const out: Snapshot['prerequisites'] = [];
  const labels: Record<string, string> = { claude: 'Claude Code CLI (claude)', codex: 'Codex CLI (codex)' };
  for (const engine of Object.keys(labels)) {
    const state = found(engine);
    if (state === null) continue;
    const selected = requiredProviders.has(engine);
    out.push({ id: `${engine}-cli`, name: labels[engine], level: selected ? 'required' : 'recommended', state,
      detail: state === 'ready' ? 'Found on your login PATH' : state === 'missing' ? 'Not found on your login PATH' : 'Checking the login PATH; retrying in the background',
      why: state === 'unknown' ? `Paramount is still checking whether the ${labels[engine]} command is available.` : selected ? `The selected ${engine} engine needs this command to start its agents.` : `This engine is optional until you select it for work.` });
  }
  const palace = found('mempalace');
  if (palace !== null) out.push({ id: 'mempalace', name: 'MemPalace (mempalace)', level: 'optional',
    state: palace, detail: palace === 'ready' ? 'Found on your login PATH' : palace === 'missing' ? 'Not installed' : 'Checking the login PATH; retrying in the background',
    why: palace === 'unknown' ? 'Paramount is still checking whether MemPalace is available.' : 'Optional semantic search over agent memory. Without it, agents still read and write their memory files.' });
  return out;
}

/** Engines that the current floor has selected for work. Claude remains the default when older
 *  cores do not report godProvider; active agents also make their own engine relevant. */
export function selectedSignInProviders(config: Record<string, unknown>, registry: Record<string, unknown>): Set<string> {
  const selected = new Set<string>();
  const configured = config.godProvider;
  if (typeof configured === 'string' && configured.trim()) selected.add(configured);
  else selected.add('claude');
  const agents = registry.agents && typeof registry.agents === 'object' ? registry.agents as Record<string, unknown> : {};
  for (const raw of Object.values(agents)) {
    if (!raw || typeof raw !== 'object') continue;
    const agent = raw as { provider?: unknown; archived?: unknown };
    if (agent.archived === true) continue;
    const provider = typeof agent.provider === 'string' ? agent.provider : 'claude';
    if (provider.trim()) selected.add(provider);
  }
  return selected;
}

/** Installed engines that are not signed in, with the exact command that fixes it.
 *  `mutedProviders` contains providers whose automatic login reminders have been silenced
 *  by the user via "Don't ask again". Muted providers are excluded from the returned list
 *  so they never become setup blockers; the sign-in monitor keeps running in the background
 *  and manual status checks/sign-in flows remain available from Settings › Setup. */
export function engineSignIns(signIn: Record<string, unknown>, requiredProviders = new Set(['claude']), mutedProviders: Set<string> = new Set()): Snapshot['prerequisites'] {
  const label: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
  return Object.entries(signIn).flatMap(([engine, raw]) => {
    const s = raw && typeof raw === 'object' ? raw as { state?: unknown; seen?: unknown; accountId?: unknown; accountLabel?: unknown; accountFingerprint?: unknown } : {};
    const provider = engine.split('-', 1)[0];
    if (!['signed-in', 'signed-out', 'expired', 'unknown'].includes(String(s.state)) || !label[provider]) return [];
    // A muted provider's reminder is silenced: skip it in automatic checks. The sign-in
    // monitor keeps probing in the background; Settings › Setup always shows the full picture.
    if (mutedProviders.has(provider) && s.state !== 'signed-in') return [];
    const account = typeof s.accountLabel === 'string' ? ` (${s.accountLabel})` : '';
    const idSuffix = typeof s.accountId === 'string' ? `-${s.accountId}` : '';
    const state = s.state === 'signed-in' ? 'ready' as const : s.state === 'unknown' ? 'unknown' as const : 'missing' as const;
    const detail = s.state === 'signed-in' ? 'Signed in for this launcher account' : s.state === 'unknown' ? 'Status unknown; check again for this account' : s.state === 'expired' ? `Sign-in expired${typeof s.seen === 'string' ? ` (agent failed at ${new Date(s.seen).toLocaleTimeString()})` : ''}` : 'Signed out for this launcher account';
    return [{ id: `signin-${provider}${idSuffix}`, name: `${label[provider]}${account} sign-in`, level: requiredProviders.has(provider) ? 'required' as const : 'recommended' as const, state, detail,
      why: state === 'ready' ? `Status was checked for ${s.accountLabel ?? 'the provider default'}; credentials remain in the CLI's login flow.` : `${label[provider]} status is scoped to ${s.accountLabel ?? 'the provider default'}. Use the action below for this account; no credential is copied into Paramount.`,
      signInProvider: provider as 'claude' | 'codex',
      ...(typeof s.accountId === 'string' ? { signInAccountId: s.accountId } : {}),
      ...(typeof s.accountFingerprint === 'string' ? { signInAccountFingerprint: s.accountFingerprint } : {}),
      ...(typeof s.accountLabel === 'string' ? { signInAccountLabel: s.accountLabel } : {}) }];
  });
}

/** Providers whose automatic login reminders are silenced. Reads from the
 *  `signInReminders` section of paramount-preferences.json via the snapshot. */
export function mutedSignInProviders(preferences: Record<string, unknown>): Set<string> {
  const reminders = preferences.signInReminders;
  if (!reminders || typeof reminders !== 'object' || Array.isArray(reminders)) return new Set();
  return new Set(Object.entries(reminders as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k));
}

/** "Continue anyway" covers the blockers it was pressed for; a new required one (a sign-in that
 *  expired later) opens the setup dialog again. */
export function setupDismissedFor(setup: Record<string, unknown>, prerequisites: Snapshot['prerequisites']): boolean {
  if (setup.dismissed !== true) return false;
  const covered = new Set(Array.isArray(setup.degraded) ? setup.degraded.filter((d): d is string => typeof d === 'string') : []);
  return prerequisites.every((p) => p.level !== 'required' || p.state === 'ready' || p.state === 'unknown' || covered.has(p.name));
}

/** Only confirmed, actionable failures open the startup setup dialog. Unknown stays visible in
 *  Settings, but a transient or unavailable probe must not block startup. */
export function setupBlockers(prerequisites: Snapshot['prerequisites']): Snapshot['prerequisites'] {
  return prerequisites.filter((p) => p.level === 'required' && p.state !== 'ready' && p.state !== 'unknown');
}
