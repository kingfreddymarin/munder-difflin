import * as React from 'react';
import type { CouncilLauncherDiscovery, CouncilLauncherPick, ParamountTeamModels } from '@/data/paramount-api';
import { useDispatch, useTeamApi } from '@/data/store';
import { toBackendError, type BackendError } from '@/data/errors';
import { ErrorNotice } from '@/components/app/error-notice';

export function LauncherSelect({ discovery, provider, value, onChange }: { discovery?: CouncilLauncherDiscovery; provider?: string; value: CouncilLauncherPick | null; onChange: (value: CouncilLauncherPick | null) => void }) {
  const choices = discovery?.choices.filter((c) => !provider || c.provider === provider) ?? [];
  const selected = choices.find((c) => c.id === value?.id && c.fingerprint === value.fingerprint);
  return <div className="space-y-2 text-sm">
    <label className="block">Account launcher
      <select aria-label="Account launcher" className="bg-background mt-1 w-full rounded-md border p-2" value={value ? selected?.id ?? 'unavailable' : ''} onChange={(e) => {
        const choice = choices.find((c) => c.id === e.target.value);
        onChange(choice ? { id: choice.id, fingerprint: choice.fingerprint } : null);
      }}>
        <option value="">Provider default</option>
        {value && !selected && <option value="unavailable" disabled>Saved selection unavailable — choose again</option>}
        {choices.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.provider})</option>)}
      </select>
    </label>
    {discovery?.status !== 'ok' && <p role="status">{discovery?.message ?? 'Launcher discovery is unavailable. Provider defaults remain available.'}</p>}
    {selected?.unrestricted && <label className="block text-amber-500"><input type="checkbox" checked={value?.allowUnrestricted === true} onChange={(e) => onChange({ ...value!, allowUnrestricted: e.target.checked })} /> This launcher disables runtime permission checks. Allow unrestricted execution for this selection.</label>}
    {selected?.provider === 'codex' && <p className="text-muted-foreground text-xs">This account keeps its existing home. Council hooks and remote daemon setup are disabled.</p>}
  </div>;
}

export function LauncherSettings({ agentId, provider, scope = 'agent' }: { agentId?: string; provider?: string; scope?: 'agent' | 'temps' | 'orchestrator' | 'default' }) {
  const api = useTeamApi(); const dispatch = useDispatch();
  const [models, setModels] = React.useState<ParamountTeamModels | null>(null);
  const [value, setValue] = React.useState<CouncilLauncherPick | null>(null);
  const [error, setError] = React.useState<BackendError | null>(null);
  const [saved, setSaved] = React.useState(false);
  const load = React.useCallback(() => {
    api?.models().then((m) => { setModels(m); setValue((scope === 'default' ? m.launcherState?.defaults?.[provider ?? ''] : scope === 'agent' ? m.launcherState?.agents[agentId ?? ''] : m.launcherState?.[scope]) ?? null); setError(null); }, (e) => setError(toBackendError(e, 'team.models')));
  }, [api, agentId, scope, provider]);
  React.useEffect(load, [load]);
  if (!api) return null;
  return <div className="space-y-2 rounded-md border p-3">
    <p className="text-sm">{scope === 'default' ? `${provider} default for new agents` : scope === 'temps' ? 'Default account launcher for new temps. Requests must use its provider.' : 'Session account launcher (applies at next start)'}</p>
    <p className="text-muted-foreground text-xs">Account selection: {models?.launchers?.choices.find((c) => c.id === value?.id && c.fingerprint === value.fingerprint)?.label ?? (value ? 'Unavailable — refresh and choose again' : 'Provider default')}</p>
    <LauncherSelect discovery={models?.launchers} provider={provider ?? (scope === 'orchestrator' ? models?.orchestratorProvider : undefined)} value={value} onChange={(v) => { setValue(v); setSaved(false); }} />
    <button className="rounded border px-3 py-1 text-sm" onClick={load}>Refresh discovery</button>{' '}
    <button className="rounded border px-3 py-1 text-sm" onClick={async () => { setSaved(false); if (await dispatch({ type: 'launchers.configure', scope, ...(scope === 'default' ? { provider } : {}), ...(agentId ? { agentId } : {}), launcher: value })) setSaved(true); }}>Save launcher</button>
    {saved && <p role="status">Launcher saved for the next start.</p>}
    {error && <ErrorNotice error={error} />}
  </div>;
}
