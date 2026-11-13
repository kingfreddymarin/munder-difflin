import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { PtyTerminalView } from '@/components/app/terminal/pty-terminal-view';
import { useTeamApi } from '@/data/store';
import type { PrereqState } from '@/data/types';

export function EngineSignInActions({ provider, state, accountId, accountFingerprint, accountLabel, accountSelection, onResolveAccount, cliAvailable = true }: {
  provider: 'claude' | 'codex'; state: PrereqState; accountId?: string; accountFingerprint?: string; accountLabel?: string;
  accountSelection?: 'default' | 'selected' | 'stale' | 'unavailable'; onResolveAccount?: () => void; cliAvailable?: boolean;
}) {
  const api = useTeamApi();
  const [terminal, setTerminal] = React.useState<{ ptyId: string; cwd: string } | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [fresh, setFresh] = React.useState<PrereqState | null>(null);
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const current = fresh ?? state;
  const signInAllowed = current === 'missing';
  const unresolvedAccount = accountSelection === 'stale' || accountSelection === 'unavailable';
  // Keep even an unreadable selection explicitly scoped so an accidental action
  // cannot fall through to the provider-default account in the main process.
  const scopedAccountId = accountSelection === 'unavailable' ? '__unavailable__' : accountId;
  React.useEffect(() => { setFresh(null); }, [provider, state, accountSelection, accountId, accountFingerprint]);
  React.useEffect(() => {
    if (!terminal) return;
    return window.paramount?.onPtyExit(terminal.ptyId, () => setTerminal(null));
  }, [terminal?.ptyId]);

  const checkAgain = async () => {
    if (!cliAvailable) { setError(`${provider} CLI is missing. Install it from Settings › Setup, then check again.`); return; }
    if (!api?.refreshEngineSignIn) { setError('Account status refresh is unavailable in this build.'); return; }
    setChecking(true); setError(''); setMessage('');
    try {
      const result = await api.refreshEngineSignIn(provider, scopedAccountId, accountFingerprint);
      const next = result.state === 'signed-in' ? 'ready' : result.state === 'unknown' ? 'unknown' : 'missing';
      setFresh(next);
      setMessage(next === 'ready' ? `Sign-in confirmed for ${accountLabel ?? 'the selected account'}.` : next === 'unknown' ? `Status is still unknown for ${accountLabel ?? 'the selected account'}.` : `Sign-in is still required for ${accountLabel ?? 'the selected account'}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check this account.'); }
    finally { setChecking(false); }
  };

  const startSignIn = async () => {
    if (!cliAvailable) { setError(`${provider} CLI is missing. Install it from Settings › Setup before signing in.`); return; }
    if (!api?.startEngineSignIn) { setError('Sign-in is unavailable in this build.'); return; }
    setError(''); setMessage('');
    try { setTerminal(await api.startEngineSignIn(provider, scopedAccountId, accountFingerprint)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open the selected account sign-in.'); }
  };

  const stop = async () => {
    if (!terminal) return;
    const result = await window.paramount?.killPty?.(terminal.ptyId);
    if (result && !result.ok) setError(result.error ?? 'Could not stop the sign-in terminal.');
    else setTerminal(null);
  };

  return <div className="flex flex-col gap-2">
    {unresolvedAccount && <div role="alert" className="text-amber-600 text-xs">{accountSelection === 'stale' ? `The saved ${accountLabel ?? 'account'} selection changed or is no longer available.` : 'The saved account selection could not be read.'} Refresh launcher discovery and explicitly select an account before checking sign-in or opening a login flow.{onResolveAccount && <Button size="sm" variant="outline" className="mt-2" onClick={onResolveAccount}>Refresh and reselect account</Button>}</div>}
    {cliAvailable && <div className="flex flex-wrap items-center gap-2">
      {!unresolvedAccount && signInAllowed && <Button size="sm" onClick={() => void startSignIn()} disabled={!!terminal}>Sign in{accountLabel ? ` · ${accountLabel}` : ''}</Button>}
      {!unresolvedAccount && current !== 'ready' && <Button size="sm" variant="outline" onClick={() => void checkAgain()} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</Button>}
      {terminal && <Button size="sm" variant="outline" onClick={() => void stop()}>Stop sign-in</Button>}
    </div>}
    {!cliAvailable && <p className="text-muted-foreground text-xs" role="status">The {provider} command is missing. Install it in Settings › Setup, then return and check again.</p>}
    {message && <p className="text-muted-foreground text-xs" role="status">{message}</p>}
    {error && <p className="text-destructive text-xs" role="alert">{error}</p>}
    {terminal && <div className="h-64 overflow-hidden rounded-lg border"><PtyTerminalView ptyId={terminal.ptyId} cwd={terminal.cwd} label={`${accountLabel ?? provider} sign-in terminal`} /></div>}
  </div>;
}
