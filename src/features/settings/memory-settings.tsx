import * as React from 'react';
import { Tile } from '@/components/app/tile';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { useFloor } from '@/data/store';
import { findBridge } from '@/data/bridge';

export function MemorySettings() {
  const agents = useFloor((s) => s.agents);
  const bridge = findBridge();
  const [agentId, setAgentId] = React.useState('');
  const selected = agentId || agents[0]?.id || '';
  const [memory, setMemory] = React.useState('');
  const [textQuery, setTextQuery] = React.useState('');
  const [semanticQuery, setSemanticQuery] = React.useState('');
  const [hits, setHits] = React.useState<Array<{ source: string; excerpt: string }>>([]);
  const [semantic, setSemantic] = React.useState('');
  const [error, setError] = React.useState('');
  const [searched, setSearched] = React.useState(false);
  React.useEffect(() => {
    if (!selected || !bridge?.hiveMemory) return;
    let active = true;
    bridge.hiveMemory(selected).then((value) => { if (active) setMemory(value); }, (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Memory file could not be read'); });
    return () => { active = false; };
  }, [selected, bridge]);
  const exactSearch = async () => {
    if (!bridge?.textSearch || !textQuery.trim()) return;
    setError(''); setSearched(true);
    try { const result = await bridge.textSearch(textQuery.trim()); if (!result.ok) throw new Error('Exact text search failed'); setHits(result.results); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Exact text search failed'); setHits([]); }
  };
  const meaningSearch = async () => {
    if (!bridge?.searchMemory || !semanticQuery.trim()) return;
    setError('');
    try { const result = await bridge.searchMemory(semanticQuery.trim()); if (!result.ok) throw new Error(result.error || 'Semantic search failed'); setSemantic(result.output); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Semantic search failed'); setSemantic(''); }
  };
  return <div className="grid gap-3 lg:grid-cols-2">
    <Tile title="Agent memory file" hint="read only">
      <select aria-label="Agent memory" className="bg-background rounded-md border px-3 py-2 text-sm" value={selected} onChange={(event) => setAgentId(event.target.value)}>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>
      <pre className="bg-muted max-h-96 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{memory || 'No memory file content reported.'}</pre>
    </Tile>
    <div className="grid gap-3">
      <Tile title="Exact text search" hint="board · tasks · agent memory">
        <div className="flex gap-2"><Input value={textQuery} onChange={(event) => setTextQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void exactSearch(); }} placeholder="Find exact text" /><Button disabled={!bridge?.textSearch || !textQuery.trim()} onClick={() => { void exactSearch(); }}>Search</Button></div>
        {hits.map((hit, index) => <div key={`${hit.source}:${index}`} className="rounded-md border p-2 text-xs"><strong>{hit.source}</strong><p className="whitespace-pre-wrap">{hit.excerpt}</p></div>)}
        {searched && !hits.length && !error && <p className="text-muted-foreground text-xs">No matches.</p>}
      </Tile>
      <Tile title="Semantic search" hint="MemPalace, when installed">
        <div className="flex gap-2"><Input value={semanticQuery} onChange={(event) => setSemanticQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void meaningSearch(); }} placeholder="Search by meaning" /><Button disabled={!bridge?.searchMemory || !semanticQuery.trim()} onClick={() => { void meaningSearch(); }}>Search</Button></div>
        {semantic && <pre className="bg-muted max-h-72 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{semantic}</pre>}
      </Tile>
      {error && <p role="alert" className="text-rose-400 text-xs">{error}</p>}
    </div>
  </div>;
}
