import { LauncherSettings } from '@/features/team/launcher-select';
import * as React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/animate-ui/components/radix/popover';
import { Switch } from '@/components/animate-ui/components/radix/switch';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { SlidersHorizontal } from '@/components/animate-ui/icons/sliders-horizontal';
import { Tile } from '@/components/app/tile';
import { AgentsPanel } from '@/features/team/agents-panel';
import { GraphPanel } from '@/features/team/graph-panel';
import { ActivityPanel } from '@/features/team/activity-panel';
import { SourcesPanel } from '@/features/team/sources-panel';
import { AutomationsPanel } from '@/features/team/automations-panel';
import { AgentSheet } from '@/features/team/agent-sheet';
import { ImportAgentsSheet } from '@/features/team/import-agents-sheet';
import { HireSheet } from '@/features/team/hire-sheet';
import { NewCardDialog } from '@/features/team/new-card-dialog';
import { useAgentImport, useDispatch, useFloor, useTeamApi } from '@/data/store';
import { AGENT_VIEW, agentViewParams } from '@/app/agent-view';
import { useRouter } from '@/app/router';
import { cn } from '@/lib/utils';
import { Screen } from '@/components/app/screen';
import { TeamsEditor } from '@/features/team/teams-editor';

type PanelId = 'agents' | 'graph' | 'activity' | 'sources' | 'automations';
const PANELS: Record<PanelId, { title: string; hint: string }> = {
  agents: { title: 'Agents', hint: 'tap one for its profile' },
  graph: { title: 'Team graph', hint: 'reporting · live · asked you · triggers' },
  activity: { title: 'Activity', hint: 'today, per agent' },
  sources: { title: 'Data sources', hint: 'tap a cell to change access' },
  automations: { title: 'Automations', hint: 'hover for the rule' },
};
const KEY = 'paramount.team.panels.v2';
const DEFAULT: PanelId[] = ['graph', 'agents', 'activity', 'sources', 'automations'];

function load(): PanelId[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return Array.isArray(v) ? v : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

const gridFor: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-2 lg:grid-rows-2 [&>*:first-child]:lg:col-span-2',
  4: 'lg:grid-cols-2 lg:grid-rows-2',
  5: 'lg:grid-cols-3 lg:grid-rows-2 [&>*:first-child]:lg:col-span-2',
};

export function TeamPage() {
  const dispatch = useDispatch();
  const { route, go } = useRouter();
  const [panels, setPanels] = React.useState<PanelId[]>(load);
  const open = route.params.get('agent');
  const agentImport = useAgentImport();
  // `?import=1` (Home's "Import agents") opens the import sheet directly.
  const [importing, setImporting] = React.useState(() => route.params.get('import') === '1');

  const teamApi = useTeamApi();
  const agents = useFloor((s) => s.agents);
  const terminals = useFloor((s) => s.terminals);
  const hasOrchestrator = agents.some((agent) => agent.role === 'paramount' && terminals.some((terminal) => terminal.agentId === agent.id));
  // null = closed; otherwise which way the Add-Agent form opens (empty, or pre-filled from a bundle file).
  const [hiring, setHiring] = React.useState<null | { bundle: boolean; orchestrator?: boolean; manifest?: Record<string, unknown>; notes?: string[] }>(null);
  const [creating, setCreating] = React.useState(false);

  const apply = (next: PanelId[]) => {
    setPanels(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* per-viewer preference only */ }
    dispatch({ type: 'layout.panels', panels: next });
  };
  const toggle = (id: PanelId, on: boolean) => apply(on ? DEFAULT.filter((p) => p === id || panels.includes(p)) : panels.filter((p) => p !== id));
  const move = (id: PanelId, d: -1 | 1) => {
    const i = panels.indexOf(id), j = i + d;
    if (i < 0 || j < 0 || j >= panels.length) return;
    const next = [...panels];
    [next[i], next[j]] = [next[j], next[i]];
    apply(next);
  };
  const openAgent = (id: string) => go(AGENT_VIEW, agentViewParams(id));

  const body = (id: PanelId) => {
    switch (id) {
      case 'agents': return <AgentsPanel onOpen={openAgent} />;
      case 'graph': return <GraphPanel onOpen={openAgent} />;
      case 'activity': return <ActivityPanel onOpen={openAgent} />;
      case 'sources': return <SourcesPanel onOpen={openAgent} />;
      case 'automations': return <AutomationsPanel />;
    }
  };

  return (
    <Screen>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-48 flex-1 flex-col">
          <h1 className="text-xl font-semibold tracking-tight">Team</h1>
          <span className="text-muted-foreground text-xs">Agents, graph, activity, data sources and automations on one screen</span>
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline"><SlidersHorizontal animateOnHover /> Customize</Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Panels on this screen</span>
              {DEFAULT.map((id) => {
                const on = panels.includes(id);
                return (
                  <div key={id} className="flex items-center gap-2">
                    <Switch checked={on} onCheckedChange={(v) => toggle(id, v)} aria-label={`Show ${PANELS[id].title}`} />
                    <span className="flex-1 text-sm">{PANELS[id].title}</span>
                    <Button size="icon-sm" variant="ghost" disabled={!on} onClick={() => move(id, -1)} aria-label={`Move ${PANELS[id].title} up`}>↑</Button>
                    <Button size="icon-sm" variant="ghost" disabled={!on} onClick={() => move(id, 1)} aria-label={`Move ${PANELS[id].title} down`}>↓</Button>
                  </div>
                );
              })}
              <span className="text-muted-foreground text-xs">Layout changes are logged like every other change.</span>
            </div>
          </PopoverContent>
        </Popover>
        <Button variant="outline" disabled={!agentImport} onClick={() => setImporting(true)}
          title={agentImport ? 'List agents defined in Claude Code, Codex and Munder on this machine' : 'Import needs the desktop core.'}>Import from Claude / Codex / Munder</Button>
        <Button variant="outline" onClick={() => setCreating(true)}>New card</Button>
        <Button variant="outline" disabled={!teamApi} onClick={() => setHiring({ bundle: true })}
          title={teamApi ? 'Pre-fill the Add-Agent form from a munder-difflin/hire@1 file' : 'Hiring needs the desktop core.'}>Hire from a bundle</Button>
        {!hasOrchestrator && <Button variant="outline" disabled={!teamApi} onClick={() => setHiring({ bundle: false, orchestrator: true })}
          title={teamApi ? 'Start the main Paramount agent using the configured orchestrator engine' : 'Starting the orchestrator needs the desktop core.'}>Start Paramount orchestrator</Button>}
        <Button disabled={!teamApi} onClick={() => setHiring({ bundle: false })}
          title={teamApi ? 'Add an agent: review the exact command, then start it in a terminal' : 'Hiring needs the desktop core.'}>Hire</Button>
      </div>
      <TeamsEditor />
      <div className={cn('grid min-h-0 flex-1 grid-cols-1 gap-3', gridFor[panels.length] ?? gridFor[5])}>
        {panels.map((id) => (
          <Tile key={id} title={PANELS[id].title} hint={PANELS[id].hint}>{body(id)}</Tile>
        ))}
      </div>
      <LauncherSettings scope="temps" />
      <AgentSheet agentId={open} tab={route.params.get('tab')} onClose={() => go('team')} />
      <ImportAgentsSheet open={importing} onClose={() => setImporting(false)} onImported={(manifest, notes) => { setImporting(false); setHiring({ bundle: false, manifest, notes }); }} />
      <HireSheet open={!!hiring} bundle={!!hiring?.bundle} orchestrator={!!hiring?.orchestrator} manifest={hiring?.manifest} notes={hiring?.notes} onClose={() => setHiring(null)} />
      <NewCardDialog open={creating} onClose={() => setCreating(false)} />
    </Screen>
  );
}
