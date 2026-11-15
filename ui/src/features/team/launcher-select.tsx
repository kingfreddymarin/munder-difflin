import { fitLauncher } from '@/lib/launcher-fit';
import * as React from 'react';
import type { CouncilLauncherDiscovery, CouncilLauncherPick, ParamountTeamModels } from '@/data/paramount-api';
import { useDispatch, useTeamApi } from '@/data/store';
import { toBackendError, type BackendError } from '@/data/errors';
import { ErrorNotice } from '@/components/app/error-notice';

export function LauncherSelect({ discovery, provider, value, onChange, requireChoice = false }: { discovery?: CouncilLauncherDiscovery; provider?: string; value: CouncilLauncherPick | null; onChange: (value: CouncilLauncherPick | null) => void; requireChoice?: boolean }) {
  const choices = discovery?.choices.filter((c) => !provider || c.provider === provider) ?? [];
  const selected = choices.find((c) => c.id === value?.id && c.fingerprint === value.fingerprint);
  return <div className="space-y-2 text-sm">
    <label className="block">Account launcher
      <select aria-label="Account launcher" className="bg-background mt-1 w-full rounded-md border p-2" value={value ? selected?.id ?? 'unavailable' : requireChoice ? 'resolve-selection' : ''} onChange={(e) => {
        const choice = choices.find((c) => c.id === e.target.value);
        onChange(choice ? { id: choice.id, fingerprint: choice.fingerprint } : null);
      }}>
        <option value="">Provider default</option>
        {requireChoice && !value && <option value="resolve-selection" disabled>Choose an account or provider default explicitly</option>}
        {value && !selected && <option value="unavailable" disabled>Saved selection unavailable — choose again</option>}
        {choices.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.provider})</option>)}
      </select>
    </label>
    {discovery?.status !== 'ok' && <p role="status">{discovery?.message ?? 'Launcher discovery is unavailable. Provider defaults remain available.'}</p>}
    {selected?.unrestricted && <label className="block text-amber-500"><input type="checkbox" checked={value?.allowUnrestricted === true} onChange={(e) => onChange({ ...value!, allowUnrestricted: e.target.checked })} /> This launcher disables runtime permission checks. Allow unrestricted execution for this selection.</label>}
    {selected?.provider === 'codex' && <p className="text-muted-foreground text-xs">This account keeps its existing home. Council hooks and remote daemon setup are disabled.</p>}
  </div>;
}

export function savedOrchestratorLauncher(m: ParamountTeamModels): CouncilLauncherPick | null {
  const pick = m.launcherState?.orchestrator ?? null;
  // Missing discovery is an unavailable saved account, not consent to use a default.
  if (!pick || !m.launchers?.choices.some((choice) => choice.id === pick.id)) return pick;
  return fitLauncher(m.launcherState?.orchestrator, m.orchestratorProvider, m.launchers);
}

type LauncherSettingsState = {
  models: ParamountTeamModels | null;
  value: CouncilLauncherPick | null;
  error: BackendError | null;
  saved: boolean;
  selectionEdited: boolean;
  loading: boolean;
  saving: boolean;
  retryExhausted: boolean;
};

// One controller per panel target. Requests and drafts have separate revisions so a
// late discovery response cannot erase an edit or update a different agent's panel.
export class LauncherSettingsController {
  private state: LauncherSettingsState = { models: null, value: null, error: null, saved: false, selectionEdited: false, loading: false, saving: false, retryExhausted: false };
  private listeners = new Set<() => void>();
  private active = false;
  private request = 0;
  private editRevision = 0;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly delays = [1000, 2000, 4000, 8000, 16000, 30000];
  constructor(private readonly io: {
    models: () => Promise<ParamountTeamModels>;
    persisted: (models: ParamountTeamModels) => CouncilLauncherPick | null;
    refresh: () => Promise<boolean>;
    save: (value: CouncilLauncherPick | null) => Promise<boolean>;
    changed?: () => void;
    schedule?: typeof setTimeout;
    cancel?: typeof clearTimeout;
  }) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<LauncherSettingsState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private clearTimer() { if (this.timer !== undefined) (this.io.cancel ?? clearTimeout)(this.timer); this.timer = undefined; }
  start() { this.active = true; this.retries = 0; void this.load(); }
  stop() { this.active = false; this.request++; this.clearTimer(); }
  edit(value: CouncilLauncherPick | null) { this.editRevision++; this.update({ value, selectionEdited: true, saved: false }); }
  async load() {
    if (!this.active) return;
    this.clearTimer();
    const request = ++this.request;
    this.update({ loading: true });
    try {
      const models = await this.io.models();
      if (!this.active || request !== this.request) return;
      this.update({ models, error: null, loading: false,
        ...(this.state.selectionEdited ? {} : { value: this.io.persisted(models) }) });
      if (models.launchers?.status === 'ok') { this.retries = 0; this.update({ retryExhausted: false }); }
      else this.scheduleRetry();
    } catch (e) {
      if (!this.active || request !== this.request) return;
      this.update({ error: toBackendError(e, 'team.models'), loading: false });
      this.scheduleRetry();
    }
  }
  private scheduleRetry() {
    if (this.retries >= this.delays.length) { this.update({ retryExhausted: true }); return; }
    this.timer = (this.io.schedule ?? setTimeout)(() => { this.timer = undefined; void this.load(); }, this.delays[this.retries++]);
  }
  async refresh() {
    if (!this.active || this.state.loading || this.state.saving) return;
    this.clearTimer();
    const request = ++this.request;
    this.update({ loading: true, saved: false });
    try {
      const ok = await this.io.refresh();
      if (!this.active || request !== this.request) return;
      if (!ok) { this.update({ loading: false }); return; }
      this.retries = 0;
      this.update({ retryExhausted: false });
      this.io.changed?.();
      await this.load();
    } catch (e) { if (this.active && request === this.request) this.update({ loading: false, error: toBackendError(e, 'launchers.refresh') }); }
  }
  async save() {
    if (!this.active || this.state.loading || this.state.saving || !this.state.models) return;
    this.clearTimer();
    const request = ++this.request;
    const revision = this.editRevision;
    this.update({ saving: true, saved: false });
    try {
      const ok = await this.io.save(this.state.value);
      if (!this.active || request !== this.request) return;
      this.update({ saving: false });
      if (!ok) return;
      if (revision === this.editRevision) this.update({ saved: true, selectionEdited: false });
      this.io.changed?.();
      await this.load();
    } catch (e) { if (this.active && request === this.request) this.update({ saving: false, error: toBackendError(e, 'launchers.configure') }); }
  }
}

export function LauncherSettings({ agentId, provider, scope = 'agent', onSelectionChange, refreshToken }: { agentId?: string; provider?: string; scope?: 'agent' | 'temps' | 'orchestrator' | 'default'; onSelectionChange?: () => void; refreshToken?: number }) {
  const api = useTeamApi(); const dispatch = useDispatch();
  const changed = React.useRef(onSelectionChange);
  changed.current = onSelectionChange;
  const controller = React.useMemo(() => new LauncherSettingsController({
    models: () => api!.models(),
    persisted: (m) => scope === 'orchestrator'
      ? savedOrchestratorLauncher(m)
      : (scope === 'default' ? m.launcherState?.defaults?.[provider ?? ''] : scope === 'agent' ? m.launcherState?.agents[agentId ?? ''] : m.launcherState?.[scope]) ?? null,
    refresh: () => dispatch({ type: 'launchers.refresh' }),
    save: (launcher) => dispatch({ type: 'launchers.configure', scope, ...(scope === 'default' ? { provider } : {}), ...(agentId ? { agentId } : {}), launcher }),
    changed: () => changed.current?.(),
  }), [api, dispatch, agentId, provider, scope]);
  const { models, value, error, saved, selectionEdited, loading, saving, retryExhausted } = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  React.useEffect(() => { if (!api) return; controller.start(); return () => controller.stop(); }, [api, controller]);
  React.useEffect(() => { if (api && refreshToken) void controller.load(); }, [api, controller, refreshToken]);
  if (!api) return null;
  const accountSelection = scope === 'agent' ? models?.agents[agentId ?? '']?.accountSelection : undefined;
  const unresolved = accountSelection === 'stale' || accountSelection === 'unavailable' || (!!value && !models?.launchers?.choices.some((choice) => choice.id === value.id && choice.fingerprint === value.fingerprint));
  return <div className="space-y-2 rounded-md border p-3">
    <p className="text-sm">{scope === 'default' ? `${provider} default for new agents` : scope === 'temps' ? 'Default account launcher for new temps. Requests must use its provider.' : 'Session account launcher (applies at next start)'}</p>
    <p className="text-muted-foreground text-xs">Account selection: {models?.launchers?.choices.find((c) => c.id === value?.id && c.fingerprint === value.fingerprint)?.label ?? (unresolved ? 'Saved selection unavailable — refresh and explicitly choose an account or provider default' : value ? 'Unavailable — refresh and choose again' : 'Provider default')}</p>
    <LauncherSelect discovery={models?.launchers} provider={provider ?? (scope === 'orchestrator' ? models?.orchestratorProvider : undefined)} value={value} requireChoice={unresolved && !selectionEdited} onChange={(v) => controller.edit(v)} />
    {scope === 'orchestrator' && models?.orchestratorLauncherNote && <p className="text-xs text-amber-500" data-testid="settings-orchestrator-launcher-note">{models.orchestratorLauncherNote}</p>}
    {scope === 'orchestrator' && models?.orchestratorConfiguredProvider && <p className="text-muted-foreground text-xs" data-testid="settings-orchestrator-engine-note">This floor's orchestrator is registered on {models.orchestratorProvider}; the orchestrator engine chosen in setup ({models.orchestratorConfiguredProvider}) applies only to a new orchestrator.</p>}
    <button className="rounded border px-3 py-1 text-sm" disabled={loading || saving} onClick={() => { void controller.refresh(); }}>Refresh discovery</button>{' '}
    <button className="rounded border px-3 py-1 text-sm" disabled={!models || saving || loading || (unresolved && !selectionEdited) || (!!value && !models.launchers?.choices.some((c) => c.id === value.id && c.fingerprint === value.fingerprint))} onClick={() => { void controller.save(); }}>Save launcher</button>
    {retryExhausted && <p role="status">Automatic discovery checks stopped. Refresh discovery to try again.</p>}
    {saved && <p role="status">Launcher saved for the next start.</p>}
    {error && <ErrorNotice error={error} />}
  </div>;
}
