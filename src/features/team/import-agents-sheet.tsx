// Lists agents already defined in Claude Code, Codex and Munder setups and imports one through the hire path.
// Read-only until the human confirms: the core opens the Add-Agent form pre-filled and nothing spawns from here.
import * as React from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/animate-ui/components/radix/sheet';
import { Button } from '@/components/animate-ui/components/buttons/button';
import { Badge } from '@/components/ui/badge';
import { ErrorNotice } from '@/components/app/error-notice';
import { CopyDiagnosticsButton, useAgentImport } from '@/data/store';
import { toBackendError, type BackendError } from '@/data/errors';
import type { ParamountAgentDiscovery, ParamountAgentImport, ParamountDiscoveredAgent, ParamountSourceWarning } from '@/data/paramount-api';

const SOURCE_LABEL = { claude: 'Claude Code', codex: 'Codex', munder: 'Munder' } as const;

type Load = { status: 'loading' } | { status: 'ready'; discovery: ParamountAgentDiscovery } | { status: 'error'; error: BackendError };
type Pending = { key: string; state: 'sending' } | { key: string; state: 'done'; result: ParamountAgentImport } | { key: string; state: 'error'; error: BackendError };

const keyOf = (agent: ParamountDiscoveredAgent) => `${agent.source}:${agent.id}`;

function Warnings({ warnings }: { warnings: ParamountSourceWarning[] }) {
  if (!warnings.length) return null;
  return (
    <ul className="flex flex-col gap-1">
      {warnings.map((warning) => (
        <li key={warning.errorId} data-error-id={warning.errorId} className="rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-xs">
          <span className="font-mono text-muted-foreground">{warning.errorId} · {warning.path}</span>
          <span className="block break-words">{warning.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function ImportAgentsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useAgentImport();
  const [load, setLoad] = React.useState<Load>({ status: 'loading' });
  const [pending, setPending] = React.useState<Pending | null>(null);

  const discover = React.useCallback(() => {
    if (!api) return;
    setLoad({ status: 'loading' });
    api.discover().then(
      (discovery) => setLoad({ status: 'ready', discovery }),
      (cause) => setLoad({ status: 'error', error: toBackendError(cause, 'agents.discover') }),
    );
  }, [api]);
  React.useEffect(() => { if (open) { setPending(null); discover(); } }, [open, discover]);

  const importOne = async (agent: ParamountDiscoveredAgent) => {
    if (!api) return;
    const key = keyOf(agent);
    setPending({ key, state: 'sending' });
    try {
      setPending({ key, state: 'done', result: await api.importAgent(agent.source, agent.id) });
    } catch (cause) {
      setPending({ key, state: 'error', error: toBackendError(cause, 'agents.import') });
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[520px] sm:max-w-[520px]">
        <SheetHeader>
          <SheetTitle>Import from Claude / Codex / Munder</SheetTitle>
          <SheetDescription>Agents already defined on this machine. Importing opens the Add-Agent form pre-filled; you confirm the hire there.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
          {load.status === 'loading' && <span className="text-muted-foreground text-sm">Looking for agents…</span>}
          {load.status === 'error' && (
            <ErrorNotice error={load.error}>
              <div className="flex gap-2"><Button size="sm" variant="outline" onClick={discover}>Retry</Button><CopyDiagnosticsButton size="sm" /></div>
            </ErrorNotice>
          )}
          {load.status === 'ready' && (
            <>
              {load.discovery.agents.length === 0 && (
                <span className="text-muted-foreground text-sm">No agents found in {Object.values(load.discovery.roots).flat().join(', ') || 'the scanned folders'}.</span>
              )}
              {load.discovery.agents.map((agent) => {
                const key = keyOf(agent);
                const mine = pending?.key === key ? pending : null;
                return (
                  <div key={key} className="flex flex-col gap-2 rounded-lg border p-3">
                    <div className="flex items-start gap-2">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-sm font-medium">{agent.name}</span>
                        <span className="text-muted-foreground text-xs">{agent.description || 'No description.'}</span>
                      </div>
                      <Badge variant="outline">{SOURCE_LABEL[agent.source]}{agent.origin === 'project' ? ' · project' : ''}</Badge>
                    </div>
                    <span className="truncate font-mono text-[11px] text-muted-foreground" title={agent.instructionsPath}>{agent.instructionsPath}</span>
                    <Warnings warnings={agent.warnings} />
                    <div className="flex items-center gap-2">
                      <Button size="sm" disabled={pending?.state === 'sending'} onClick={() => void importOne(agent)}>
                        {mine?.state === 'sending' ? 'Importing…' : mine?.state === 'done' ? 'Import again' : 'Import'}
                      </Button>
                      {mine?.state === 'done' && <span role="status" className="text-xs text-emerald-400">Add-Agent form opened. Confirm the hire there.</span>}
                    </div>
                    {mine?.state === 'done' && mine.result.adjustments.length > 0 && (
                      <ul className="text-muted-foreground list-disc pl-4 text-xs">{mine.result.adjustments.map((item) => <li key={item}>{item}</li>)}</ul>
                    )}
                    {mine?.state === 'error' && <ErrorNotice error={mine.error}><CopyDiagnosticsButton size="sm" /></ErrorNotice>}
                  </div>
                );
              })}
              {load.discovery.warnings.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium">Could not read; agents in these files are missing above</span>
                  <Warnings warnings={load.discovery.warnings} />
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
