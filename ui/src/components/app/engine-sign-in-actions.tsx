import * as React from 'react';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { PtyTerminalView } from '@/components/app/terminal/pty-terminal-view';
import { useTeamApi } from '@/data/store';
import type { PrereqState } from '@/data/types';

export function EngineSignInActions({ provider, state, accountId, accountFingerprint, accountLabel }: {
  provider: 'claude' | 'codex'; state: PrereqState; accountId?: string; accountFingerprint?: string; accountLabel?: string;
}) {
  const api = useTeamApi();
  const [terminal, setTerminal] = React.useState<{ ptyId: string; cwd: string } | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [fresh, setFresh] = React.useState<PrereqState | null>(null);
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const current = fresh ?? state;
  const signInAllowed = current === 'missing';
  React.useEffect(() => { setFresh(null); }, [provider, state, accountId, accountFingerprint]);
  React.useEffect(() => {
    if (!terminal) return;
    return window.paramount?.onPtyExit(terminal.ptyId, () => setTerminal(null));
  }, [terminal?.ptyId]);

  const checkAgain = async () => {
    if (!api?.refreshEngineSignIn) { setError('Account status refresh is unavailable in this build.'); return; }
    setChecking(true); setError(''); setMessage('');
    try {
      const result = await api.refreshEngineSignIn(provider, accountId, accountFingerprint);
      const next = result.state === 'signed-in' ? 'ready' : result.state === 'unknown' ? 'unknown' : 'missing';
      setFresh(next);
      setMessage(next === 'ready' ? `Sign-in confirmed for ${accountLabel ?? 'the selected account'}.` : next === 'unknown' ? `Status is still unknown for ${accountLabel ?? 'the selected account'}.` : `Sign-in is still required for ${accountLabel ?? 'the selected account'}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check this account.'); }
    finally { setChecking(false); }
  };

  const startSignIn = async () => {
    if (!api?.startEngineSignIn) { setError('Sign-in is unavailable in this build.'); return; }
    setError(''); setMessage('');
    try { setTerminal(await api.startEngineSignIn(provider, accountId, accountFingerprint)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open the selected account sign-in.'); }
  };

  const stop = async () => {
    if (!terminal) return;
    const result = await window.paramount?.killPty?.(terminal.ptyId);
    if (result && !result.ok) setError(result.error ?? 'Could not stop the sign-in terminal.');
    else setTerminal(null);
  };

  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      {signInAllowed && <Button size="sm" onClick={() => void startSignIn()} disabled={!!terminal}>Sign in{accountLabel ? ` · ${accountLabel}` : ''}</Button>}
      {current !== 'ready' && <Button size="sm" variant="outline" onClick={() => void checkAgain()} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</Button>}
      {terminal && <Button size="sm" variant="outline" onClick={() => void stop()}>Stop sign-in</Button>}
    </div>
    {message && <p className="text-muted-foreground text-xs" role="status">{message}</p>}
    {error && <p className="text-destructive text-xs" role="alert">{error}</p>}
    {terminal && <div className="h-64 overflow-hidden rounded-lg border"><PtyTerminalView ptyId={terminal.ptyId} cwd={terminal.cwd} label={`${accountLabel ?? provider} sign-in terminal`} /></div>}
  </div>;
}
