// The orchestrator engine the setup screen preselects. Only Claude Code (Munder's default god
// provider), then Codex, are preselected when installed; any other engine (gemini, grok, ...)
// must be chosen on purpose. Before this, the first installed engine in list order was
// preselected, so a Mac without Claude or Codex detected would default the god to gemini.
import type { FloorSetupEngine } from '../data/types';

export const PRESELECTED_ORCHESTRATORS = ['claude', 'codex'] as const;

export function defaultOrchestratorEngine(engines: FloorSetupEngine[]): string {
  for (const id of PRESELECTED_ORCHESTRATORS) {
    const e = engines.find((x) => x.id === id);
    if (e?.orchestrator && e.installed) return e.id;
  }
  return '';
}
