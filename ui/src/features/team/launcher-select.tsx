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

export function LauncherSettings({ agentId, provider, scope = 'agent', onSelectionChange }: { agentId?: string; provider?: string; scope?: 'agent' | 'temps' | 'orchestrator' | 'default'; onSelectionChange?: () => void }) {
  const api = useTeamApi(); const dispatch = useDispatch();
  const [models, setModels] = React.useState<ParamountTeamModels | null>(null);
  const [value, setValue] = React.useState<CouncilLauncherPick | null>(null);
  const [error, setError] = React.useState<BackendError | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [selectionEdited, setSelectionEdited] = React.useState(false);
  const load = React.useCallback(async () => {
    if (!api) return;
    try {
      const m = await api.models();
      setModels(m);
      // The orchestrator's saved launcher counts only when it runs the registered god's engine; a
      // mismatched one is shown as ignored below, and Save (Provider default) clears it.
      setValue(scope === 'orchestrator' ? fitLauncher(m.launcherState?.orchestrator, m.orchestratorProvider, m.launchers)
        : (scope === 'default' ? m.launcherState?.defaults?.[provider ?? ''] : scope === 'agent' ? m.launcherState?.agents[agentId ?? ''] : m.launcherState?.[scope]) ?? null);
      setSelectionEdited(false);
      setError(null);
    } catch (e) { setError(toBackendError(e, 'team.models')); }
  }, [api, agentId, scope, provider]);
  React.useEffect(() => { void load(); }, [load]);
  if (!api) return null;
  const accountSelection = scope === 'agent' ? models?.agents[agentId ?? '']?.accountSelection : undefined;
  const unresolved = accountSelection === 'stale' || accountSelection === 'unavailable' || (!!value && !models?.launchers?.choices.some((choice) => choice.id === value.id && choice.fingerprint === value.fingerprint));
  return <div className="space-y-2 rounded-md border p-3">
    <p className="text-sm">{scope === 'default' ? `${provider} default for new agents` : scope === 'temps' ? 'Default account launcher for new temps. Requests must use its provider.' : 'Session account launcher (applies at next start)'}</p>
    <p className="text-muted-foreground text-xs">Account selection: {models?.launchers?.choices.find((c) => c.id === value?.id && c.fingerprint === value.fingerprint)?.label ?? (unresolved ? 'Saved selection unavailable — refresh and explicitly choose an account or provider default' : value ? 'Unavailable — refresh and choose again' : 'Provider default')}</p>
    <LauncherSelect discovery={models?.launchers} provider={provider ?? (scope === 'orchestrator' ? models?.orchestratorProvider : undefined)} value={value} requireChoice={unresolved && !selectionEdited} onChange={(v) => { setValue(v); setSaved(false); setSelectionEdited(true); }} />
    {scope === 'orchestrator' && models?.orchestratorLauncherNote && <p className="text-xs text-amber-500" data-testid="settings-orchestrator-launcher-note">{models.orchestratorLauncherNote}</p>}
    {scope === 'orchestrator' && models?.orchestratorConfiguredProvider && <p className="text-muted-foreground text-xs" data-testid="settings-orchestrator-engine-note">This floor's orchestrator is registered on {models.orchestratorProvider}; the orchestrator engine chosen in setup ({models.orchestratorConfiguredProvider}) applies only to a new orchestrator.</p>}
    <button className="rounded border px-3 py-1 text-sm" onClick={async () => { await dispatch({ type: 'launchers.refresh' }); await load(); onSelectionChange?.(); }}>Refresh discovery</button>{' '}
    <button className="rounded border px-3 py-1 text-sm" disabled={unresolved && !selectionEdited} onClick={async () => { setSaved(false); if (await dispatch({ type: 'launchers.configure', scope, ...(scope === 'default' ? { provider } : {}), ...(agentId ? { agentId } : {}), launcher: value })) { setSaved(true); await load(); onSelectionChange?.(); } }}>Save launcher</button>
    {saved && <p role="status">Launcher saved for the next start.</p>}
    {error && <ErrorNotice error={error} />}
  </div>;
}
