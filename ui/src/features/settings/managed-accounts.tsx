import * as React from 'react';
import { useDispatch, useTeamApi } from '@/data/store';
import type { CouncilAccountProfile } from '@/data/paramount-api';
import { EngineSignInActions } from '@/components/app/engine-sign-in-actions';

export function accountSignInProps(account: CouncilAccountProfile) {
  return { provider: account.provider, accountId: account.id, accountFingerprint: account.fingerprint, accountLabel: account.label, state: 'unknown' as const, accountSelection: account.available ? 'selected' as const : 'unavailable' as const, cliAvailable: account.available };
}

export class ManagedAccountsController {
  private state = { accounts: [] as CouncilAccountProfile[], loading: false, busy: false, error: '', supported: false };
  private generation = 0;
  private active = true;
  private listeners = new Set<() => void>();
  constructor(private api: { models: () => Promise<{ accounts?: CouncilAccountProfile[] }>; dispatch: (command: { type: 'accounts.create'; provider: 'claude' | 'codex'; label: string } | { type: 'accounts.rename'; id: string; label: string }) => Promise<string | boolean>; changed: () => void }) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<typeof this.state>) { if (!this.active) return; this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  start() { this.active = true; void this.load(); }
  stop() { this.active = false; this.generation++; }
  async load() {
    const generation = ++this.generation; this.update({ loading: true, error: '' });
    try { const result = await this.api.models(); if (generation === this.generation) this.update({ accounts: result.accounts ?? [], supported: Array.isArray(result.accounts), loading: false }); return true; }
    catch (error) { if (generation === this.generation) this.update({ loading: false, error: String(error) }); return false; }
  }
  async save(command: Parameters<ManagedAccountsController['api']['dispatch']>[0]) {
    if (this.state.busy) return false;
    const label = command.label.trim();
    if (!label) { this.update({ error: 'Enter a label for this account.' }); return false; }
    this.update({ busy: true, error: '' });
    try {
      if (!await this.api.dispatch({ ...command, label })) { this.update({ error: 'Account change failed. Your input has been kept.' }); return false; }
      if (!this.active) return false;
      this.api.changed(); if (!await this.load()) this.update({ error: 'Account change was saved, but the account list could not refresh. Use Refresh accounts; do not create it again.' }); return true;
    } catch (error) { this.update({ error: String(error) }); return false; }
    finally { this.update({ busy: false }); }
  }
}

function AccountRow({ account, controller, busy }: { account: CouncilAccountProfile; controller: ManagedAccountsController; busy: boolean }) {
  const [label, setLabel] = React.useState(account.label);
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => { if (!dirty) setLabel(account.label); }, [account.label, dirty]);
  return <div className="space-y-2 rounded-md border p-3">
    <p className="text-sm font-medium">{account.provider === 'claude' ? 'Claude' : 'Codex'} · {account.label}</p>
    <p className="text-muted-foreground text-xs">{account.available ? 'Profile available · use Check to verify sign-in' : 'Profile unavailable · restore the account profile before signing in'}</p>
    <form className="flex gap-2" onSubmit={async event => { event.preventDefault(); const submitted = label; if (await controller.save({ type: 'accounts.rename', id: account.id, label: submitted })) setDirty(false); }}>
      <input aria-label={`User label for ${account.label}`} className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-sm" value={label} disabled={busy} onChange={event => { setLabel(event.target.value); setDirty(true); }} />
      <button className="rounded border px-3 py-1 text-sm" disabled={busy || !dirty || !label.trim()} type="submit">Rename</button>
    </form>
    {account.available && <EngineSignInActions key={`${account.id}:${account.fingerprint}`} {...accountSignInProps(account)} />}
  </div>;
}

export function ManagedAccounts({ onChanged }: { onChanged?: () => void }) {
  const api = useTeamApi(); const dispatch = useDispatch();
  const changed = React.useRef(onChanged); changed.current = onChanged;
  const controller = React.useMemo(() => new ManagedAccountsController({ models: () => api!.models(), dispatch, changed: () => changed.current?.() }), [api, dispatch]);
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [provider, setProvider] = React.useState<'claude' | 'codex'>('claude');
  const [label, setLabel] = React.useState('');
  React.useEffect(() => { if (!api) return; controller.start(); return () => controller.stop(); }, [api, controller]);
  if (!api) return <p>Account management needs the desktop core.</p>;
  return <div className="space-y-3">
    <p className="text-muted-foreground text-xs">Labels are names you choose, not verified email addresses. Each profile uses the provider’s own sign-in flow. Adding a profile does not select it or start an agent.</p>
    <button className="rounded border px-3 py-1 text-sm" disabled={state.loading || state.busy} onClick={() => void controller.load()}>Refresh accounts</button>
    {state.loading && <p role="status">Loading accounts…</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {!state.loading && !state.supported && <p>Managed accounts are unavailable in this connection.</p>}
    {state.supported && <form className="flex flex-wrap gap-2" onSubmit={async event => { event.preventDefault(); if (await controller.save({ type: 'accounts.create', provider, label })) setLabel(''); }}>
      <select aria-label="Account provider" className="rounded border bg-background px-2" disabled={state.busy} value={provider} onChange={event => setProvider(event.target.value as 'claude' | 'codex')}><option value="claude">Claude</option><option value="codex">Codex</option></select>
      <input aria-label="New account user label" className="rounded border bg-transparent px-2 py-1 text-sm" placeholder="Work or personal label" value={label} disabled={state.busy} onChange={event => setLabel(event.target.value)} />
      <button className="rounded border px-3 py-1 text-sm" disabled={state.busy || !label.trim()} type="submit">Add account</button>
    </form>}
    {state.supported && !state.loading && !state.accounts.length && <p className="text-sm">No managed accounts yet.</p>}
    {state.accounts.map(account => <AccountRow key={`${account.id}:${account.fingerprint}`} account={account} controller={controller} busy={state.busy} />)}
  </div>;
}
