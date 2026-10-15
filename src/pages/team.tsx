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
import { useAgentImport, useDispatch } from '@/data/store';
import { useRouter } from '@/app/router';
import { cn } from '@/lib/utils';
import { Screen } from '@/components/app/screen';

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
  const [importing, setImporting] = React.useState(false);

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
  const openAgent = (id: string) => go('team', { agent: id });

  const body = (id: PanelId) => {
    switch (id) {
      case 'agents': return <AgentsPanel onOpen={openAgent} />;
      case 'graph': return <GraphPanel onOpen={openAgent} />;
      case 'activity': return <ActivityPanel onOpen={openAgent} />;
      case 'sources': return <SourcesPanel />;
      case 'automations': return <AutomationsPanel />;
    }
  };

  return (
    <Screen>
      <div className="flex items-center gap-3">
        <div className="flex flex-1 flex-col">
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
        <Button>Hire from a bundle</Button>
      </div>
      <div className={cn('grid min-h-0 flex-1 grid-cols-1 gap-3', gridFor[panels.length] ?? gridFor[5])}>
        {panels.map((id) => (
          <Tile key={id} title={PANELS[id].title} hint={PANELS[id].hint}>{body(id)}</Tile>
        ))}
      </div>
      <AgentSheet agentId={open} onClose={() => go('team')} />
      <ImportAgentsSheet open={importing} onClose={() => setImporting(false)} />
    </Screen>
  );
}
