import * as React from 'react';
import { Tile } from '@/components/app/tile';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/animate-ui/components/radix/switch';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { useDispatch, useFloor, useTeamApi } from '@/data/store';
import type { ParamountTeamModels } from '@/data/paramount-api';

const number = (value: unknown) => typeof value === 'number' ? String(value) : '';
const boolean = (value: unknown) => value === true;

export function CoreSettings() {
  const settings = useFloor((s) => s.settings);
  const agents = useFloor((s) => s.agents);
  const columns = useFloor((s) => s.board.columns);
  const teamApi = useTeamApi();
  const dispatch = useDispatch();
  const [catalog, setCatalog] = React.useState<ParamountTeamModels | null>(null);
  const [catalogError, setCatalogError] = React.useState('');
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!teamApi) return;
    teamApi.models().then(setCatalog, (error: unknown) => setCatalogError(error instanceof Error ? error.message : 'Model list unavailable'));
  }, [teamApi]);
  if (!settings) return <p className="text-muted-foreground text-sm">Settings are available when connected to the desktop core.</p>;
  const save = (key: string, value: unknown) => { void dispatch({ type: 'settings.update', patch: { [key]: value } }); };
  const toggle = (key: string, label: string, hint?: string) => <div className="flex items-center gap-3 py-2" key={key}>
    <span className="flex-1 text-sm">{label}{hint && <span className="text-muted-foreground block text-xs">{hint}</span>}</span>
    <Switch checked={boolean(settings[key])} onCheckedChange={(on) => save(key, on)} aria-label={label} />
  </div>;
  const numeric = (key: string, label: string, minimum: number, maximum: number, hint?: string) => <div className="grid gap-1.5" key={key}>
    <label className="text-sm" htmlFor={`core-${key}`}>{label}</label>
    <div className="flex gap-2"><Input id={`core-${key}`} type="number" min={minimum} max={maximum} value={drafts[key] ?? number(settings[key])} onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })} />
      <Button variant="outline" disabled={!Number.isSafeInteger(Number(drafts[key])) || Number(drafts[key]) < minimum || Number(drafts[key]) > maximum} onClick={() => { save(key, Number(drafts[key])); setDrafts((d) => { const next = { ...d }; delete next[key]; return next; }); }}>Save</Button></div>
    {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
  </div>;
  const breaker = (settings.circuitBreaker && typeof settings.circuitBreaker === 'object' ? settings.circuitBreaker : {}) as Record<string, unknown>;
  const breakerToggle = (key: string, label: string) => <div className="flex items-center gap-3 py-2" key={key}><span className="flex-1 text-sm">{label}</span><Switch checked={boolean(breaker[key])} onCheckedChange={(on) => save('circuitBreaker', { [key]: on })} aria-label={label} /></div>;
  const breakerNumber = (key: string, label: string) => <div className="grid gap-1.5" key={key}><label className="text-sm" htmlFor={`breaker-${key}`}>{label}</label><div className="flex gap-2"><Input id={`breaker-${key}`} type="number" min={1} max={1000000} value={drafts[key] ?? number(breaker[key])} onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })} /><Button variant="outline" disabled={!Number.isSafeInteger(Number(drafts[key])) || Number(drafts[key]) < 1 || Number(drafts[key]) > 1000000} onClick={() => { save('circuitBreaker', { [key]: Number(drafts[key]) }); setDrafts((d) => { const next = { ...d }; delete next[key]; return next; }); }}>Save</Button></div></div>;
  return <div className="grid gap-3 lg:grid-cols-2">
    <Tile title="Agents & models" hint="applies to future agents">
      <label className="text-sm" htmlFor="core-default-model">Default agent model</label>
      {catalog ? <select id="core-default-model" className="bg-background w-full rounded-md border px-3 py-2 text-sm" value={String(settings.defaultModel ?? '')} onChange={(e) => save('defaultModel', e.target.value)}>
        <option value="">CLI default</option>{catalog.engines.filter((engine) => engine.id === 'claude').flatMap((engine) => engine.models.filter((model) => model.id).map((model) => <option key={`${engine.id}:${model.id}`} value={model.id}>{model.label}{model.id === settings.defaultModel ? ' · default' : ''}</option>))}
      </select> : <span className="text-muted-foreground text-xs">{catalogError || 'Loading model list…'}</span>}
      {toggle('orchestratorMaySpawn', 'Orchestrator may add agents', 'Off leaves spawn requests queued for your decision.')}
      <span className="text-muted-foreground text-xs">{agents.length} active agents · individual models are set on each Team card.</span>
    </Tile>
    <Tile title="Team board" hint="your column order">
      {columns.map((column, index) => <div key={column} className="flex items-center gap-2 py-1 text-sm"><span className="flex-1 capitalize">{column}</span><Button variant="outline" size="sm" disabled={index === 0} onClick={() => { const order = [...columns]; [order[index - 1], order[index]] = [order[index], order[index - 1]]; void dispatch({ type: 'board.columns', order }); }}>↑</Button><Button variant="outline" size="sm" disabled={index === columns.length - 1} onClick={() => { const order = [...columns]; [order[index + 1], order[index]] = [order[index], order[index + 1]]; void dispatch({ type: 'board.columns', order }); }}>↓</Button></div>)}
      <span className="text-muted-foreground text-xs">Agents supply tags and workspaces on their cards; Board filters use those values.</span>
    </Tile>
    <Tile title="Response style" hint="applies when an agent starts its next session">
      <label htmlFor="response-style-brief" className="text-sm">Style brief · up to 1,200 characters</label>
      <textarea id="response-style-brief" maxLength={1200} className="bg-background min-h-28 rounded-md border p-2 text-sm" value={drafts.responseStyleBrief ?? String(settings.responseStyleBrief ?? '')} onChange={(event) => setDrafts((current) => ({ ...current, responseStyleBrief: event.target.value }))} />
      <div className="flex gap-2"><Button variant="outline" onClick={() => save('responseStyleBrief', drafts.responseStyleBrief ?? String(settings.responseStyleBrief ?? ''))}>Save brief</Button><Button variant="ghost" onClick={() => { save('responseStyleBrief', ''); setDrafts((current) => ({ ...current, responseStyleBrief: '' })); }}>Reset</Button></div>
      <label htmlFor="claude-output-style" className="text-sm">Claude Code output style</label>
      <select id="claude-output-style" className="bg-background rounded-md border px-3 py-2 text-sm" value={String(settings.claudeOutputStyle ?? 'off')} onChange={(event) => save('claudeOutputStyle', event.target.value)}><option value="off">Off</option><option value="concise">Concise</option><option value="explanatory">Explanatory</option><option value="learning">Learning</option></select>
    </Tile>
    <Tile title="Advanced & memory">
      {numeric('maxTurns', 'Maximum turns per agent', 1, 1000, 'Unset means the CLI default.')}
      <Button variant="ghost" size="sm" onClick={() => save('maxTurns', null)}>Use CLI turn limit</Button>
      {toggle('semanticMemory', 'Semantic search (MemPalace)')}
      {toggle('reflectEnabled', 'Condense agent memory files')}
      <label className="text-sm" htmlFor="core-embedding-model">Memory embedding model</label>
      <select id="core-embedding-model" className="bg-background rounded-md border px-3 py-2 text-sm" value={String(settings.embeddingModel ?? 'minilm')} onChange={(e) => save('embeddingModel', e.target.value)}><option value="minilm">MiniLM</option><option value="embeddinggemma">EmbeddingGemma</option></select>
      <span className="text-muted-foreground text-xs">Read memory files and search from Settings → Memory.</span>
    </Tile>
    <Tile title="Circuit breaker" hint="YOLO can override budget enforcement while enabled">
      {breakerToggle('enabled', 'Enable circuit breaker')}{breakerToggle('hardStop', 'Allow hard stop')}
      {numeric('costCapTokens', 'Floor token budget', 0, Number.MAX_SAFE_INTEGER, '0 means no floor cap. The core does not yet report live token usage here.')}
      {breakerNumber('tokenVelocityPerMin', 'Token velocity per minute')}{breakerNumber('repeatedToolLimit', 'Repeated tool calls')}{breakerNumber('errorStormLimit', 'Consecutive API errors')}
    </Tile>
    <Tile title="Still awaiting core support">
      <p className="text-muted-foreground text-sm">Ticket archiving rules are not exposed by this fork’s settings API yet. No saved state is implied here.</p>
    </Tile>
  </div>;
}
