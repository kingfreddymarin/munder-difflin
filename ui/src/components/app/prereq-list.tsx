// The prerequisites this machine needs. Used by the first-run setup dialog and Settings › Setup.
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { CopyButton } from '@/components/animate-ui/components/buttons/copy';
import { cn } from '@/lib/utils';
import type { Prerequisite } from '@/data/types';
import { useDispatch, useFloor, useUnsupported } from '@/data/store';
import { UnsupportedReason } from './error-notice';
import { EngineSignInActions } from './engine-sign-in-actions';

const stateLook = {
  ready: ['Ready', 'success'],
  'installed-not-running': ['Installed · not running', 'warning'],
  missing: ['Missing', 'danger'],
  outdated: ['Outdated', 'warning'],
  unknown: ['Unknown', 'warning'],
} as const;
const levelLook = { required: 'danger', recommended: 'info', optional: 'secondary' } as const;

function Row({ p, featured }: { p: Prerequisite; featured?: boolean }) {
  const dispatch = useDispatch();
  const unsupported = useUnsupported();
  const [label, variant] = stateLook[p.state];
  const cmd = p.state === 'installed-not-running' ? p.start : p.install;
  const command = { type: p.state === 'installed-not-running' ? 'prereq.start' : 'prereq.install', id: p.id, confirm: true } as const;
  const reason = unsupported(command);
  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border p-3', featured && p.state !== 'ready' && 'border-amber-500/50 bg-amber-500/5')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.name}</span>
        <Badge variant={levelLook[p.level]}>{p.level}</Badge>
        <Badge variant={variant}>{label}</Badge>
        <span className="text-muted-foreground ml-auto text-xs">{p.detail}</span>
      </div>
      {(featured || p.state !== 'ready') && <p className="text-muted-foreground text-xs leading-relaxed">{p.why}</p>}
      {p.state !== 'ready' && cmd && (
        <div className="flex items-center gap-2">
          <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 font-mono text-xs">{cmd}</code>
          <CopyButton content={cmd} size="sm" variant="outline" aria-label="Copy command" />
          <Button size="sm" disabled={!!reason} onClick={() => dispatch(command)}>
            {p.state === 'installed-not-running' ? 'Start it' : 'Install'}
          </Button>
        </div>
      )}
      {p.signInProvider && <EngineSignInActions provider={p.signInProvider} state={p.state} accountSelection={p.signInAccountId ? 'selected' : 'default'} accountId={p.signInAccountId} accountFingerprint={p.signInAccountFingerprint} accountLabel={p.signInAccountLabel ?? (p.signInAccountId ? undefined : `${p.name} provider default`)} />}
      {p.id === 'claude-cli' && p.state === 'ready' && <ClaudeTelegramChannelAction />}
      <UnsupportedReason reason={!p.signInProvider && p.state !== 'ready' ? reason : null} />
    </div>
  );
}

function ClaudeTelegramChannelAction() {
  const [plan, setPlan] = React.useState<{ id: string; changed: string[] } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const prepare = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await window.paramount?.prepareClaudeTelegramChannels();
      if (!result) throw new Error('This desktop build cannot prepare a scoped launcher update.');
      if (result.canceled) return;
      if (!result.ok) throw new Error(result.error ?? 'Could not prepare the launcher update.');
      if (result.alreadyConfigured) { setMessage('Claude, dc and dcm already include the Telegram channel.'); return; }
      if (!result.planId || !result.changed) throw new Error('The prepared change is incomplete.');
      setPlan({ id: result.planId, changed: result.changed });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not prepare the launcher update.'); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!plan) return;
    setBusy(true); setError('');
    try {
      const result = await window.paramount?.applyClaudeTelegramChannels(plan.id);
      if (!result) throw new Error('This desktop build cannot apply the launcher update.');
      if (!result.ok) {
        setError(`${result.error ?? 'The launcher update failed.'}${result.backup ? ` Backup: ${result.backup}.` : ''}`);
        setPlan(null);
        return;
      }
      setMessage(`Updated ${result.changed?.join(', ')} in ${result.target}; backup saved to ${result.backup}.`);
      setPlan(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not apply the launcher update.'); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-2 rounded border border-dashed p-2">
    <p className="text-muted-foreground text-xs">Add the official Telegram channel to the Claude, dc and dcm launchers. Paramount opens access to <code>~/.minion-aliases.sh</code> only for this change, checks the shell syntax, saves a backup and verifies the write.</p>
    {!plan && <Button size="sm" variant="outline" className="self-start" disabled={busy} onClick={() => void prepare()}>{busy ? 'Preparing…' : 'Review Telegram launcher update'}</Button>}
    {plan && <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Review Claude channel update">
      <span className="text-xs">Proposed file: <code>~/.minion-aliases.sh</code> · aliases: {plan.changed.join(', ')}</span>
      <Button size="sm" disabled={busy} onClick={() => void apply()}>{busy ? 'Applying…' : 'Apply reviewed change'}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPlan(null)}>Cancel</Button>
    </div>}
    {message && <p role="status" className="text-xs">{message}</p>}
    {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
  </div>;
}

export function PrereqList({ compact }: { compact?: boolean }) {
  const prereqs = useFloor((s) => s.prerequisites);
  const featured = prereqs.find((p) => p.level === 'required' && p.state !== 'ready') ?? prereqs.find((p) => p.level === 'required');
  const rest = prereqs.filter((p) => p !== featured && (!compact || p.state !== 'ready' || p.level === 'required'));
  return (
    <div className="flex flex-col gap-2">
      {featured && <Row p={featured} featured />}
      <div className={cn('grid gap-2', !compact && 'md:grid-cols-2')}>{rest.map((p) => <Row key={p.id} p={p} />)}</div>
      {!prereqs.length && <p className="text-muted-foreground text-sm">No prerequisite checks were reported by the core.</p>}
    </div>
  );
}

export function useSetupBlockers() {
  const prereqs = useFloor((s) => s.prerequisites);
  return prereqs.filter((p) => p.level === 'required' && p.state !== 'ready');
}
