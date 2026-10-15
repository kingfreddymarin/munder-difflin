import * as React from 'react';
import { Tile } from '@/components/app/tile';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Input } from '@/components/ui/input';
import { useDispatch, useFloor } from '@/data/store';
import { findBridge } from '@/data/bridge';

const engines = ['opencode', 'crush', 'pi', 'qwen'] as const;
const backends = ['anthropic', 'openai', 'google', 'openrouter', 'groq'] as const;

export function ProviderSettings() {
  const settings = useFloor((s) => s.settings);
  const dispatch = useDispatch();
  const bridge = findBridge();
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [hasKey, setHasKey] = React.useState<Record<string, boolean>>({});
  const [status, setStatus] = React.useState('');
  React.useEffect(() => {
    if (!bridge?.providerKeyHas) return;
    let active = true;
    Promise.all(backends.map(async (backend) => [backend, await bridge.providerKeyHas!(backend)] as const))
      .then((entries) => { if (active) setHasKey(Object.fromEntries(entries)); }, (error: unknown) => { if (active) setStatus(error instanceof Error ? error.message : 'Could not check stored keys'); });
    return () => { active = false; };
  }, [bridge]);
  if (!settings) return <p className="text-muted-foreground text-sm">Connect to the desktop core to manage providers.</p>;
  const urls = settings.providerBaseUrls && typeof settings.providerBaseUrls === 'object' ? settings.providerBaseUrls as Record<string, string> : {};
  const models = settings.providerDefaultModels && typeof settings.providerDefaultModels === 'object' ? settings.providerDefaultModels as Record<string, string> : {};
  const save = (field: 'providerBaseUrls' | 'providerDefaultModels', id: string) => { void dispatch({ type: 'settings.update', patch: { [field]: { [id]: (drafts[`${field}:${id}`] ?? '').trim() } } }); };
  const keyAction = async (backend: string, action: 'set' | 'clear') => {
    if (!bridge?.providerKeySet || !bridge.providerKeyClear) return;
    setStatus('');
    try {
      const result = action === 'set' ? await bridge.providerKeySet({ backend, key: drafts[`key:${backend}`] ?? '' }) : await bridge.providerKeyClear(backend);
      if (!result.ok) { setStatus(result.error || 'Key operation failed'); return; }
      setHasKey((current) => ({ ...current, [backend]: action === 'set' }));
      setDrafts((current) => ({ ...current, [`key:${backend}`]: '' }));
      setStatus(`${backend} key ${action === 'set' ? 'saved' : 'cleared'}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Key operation failed'); }
  };
  return <div className="grid gap-3 lg:grid-cols-2">
    <Tile title="Local and BYOK engines" hint="OpenCode · Crush · pi · Qwen">
      {engines.map((id) => <div key={id} className="grid gap-2 border-b py-3 last:border-0">
        <strong className="text-sm">{id === 'pi' ? 'pi' : id[0].toUpperCase() + id.slice(1)}</strong>
        {(['providerBaseUrls', 'providerDefaultModels'] as const).map((field) => <div key={field} className="flex gap-2"><Input aria-label={`${id} ${field === 'providerBaseUrls' ? 'endpoint' : 'default model'}`} placeholder={field === 'providerBaseUrls' ? 'Local endpoint URL' : 'Default model ID'} value={drafts[`${field}:${id}`] ?? (field === 'providerBaseUrls' ? urls[id] : models[id]) ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [`${field}:${id}`]: event.target.value }))} /><Button variant="outline" onClick={() => save(field, id)}>Save</Button></div>)}
      </div>)}
    </Tile>
    <Tile title="Keys & secrets" hint="Write only · key values are never read back">
      {backends.map((backend) => <div key={backend} className="grid gap-1.5 border-b py-3 last:border-0"><span className="text-sm">{backend} · {hasKey[backend] ? 'stored' : 'not stored'}</span><div className="flex gap-2"><Input type="password" autoComplete="off" aria-label={`${backend} API key`} value={drafts[`key:${backend}`] ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [`key:${backend}`]: event.target.value }))} /><Button variant="outline" disabled={!bridge?.providerKeySet || !(drafts[`key:${backend}`] ?? '').trim()} onClick={() => { void keyAction(backend, 'set'); }}>Save</Button>{hasKey[backend] && <Button variant="outline" disabled={!bridge?.providerKeyClear} onClick={() => { void keyAction(backend, 'clear'); }}>Clear</Button>}</div></div>)}
      {status && <p role="status" className="text-muted-foreground text-xs">{status}</p>}
    </Tile>
  </div>;
}
