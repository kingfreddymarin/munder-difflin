export type SideAgentProvider = 'opencode' | 'claude';

export interface SideAgentContext {
  floorLabel: string;
  orchestratorId: string;
  orchestratorName: string;
  capturedAt: string;
  boardSummary: string;
  cards: Array<{ id: string; title: string; status: 'todo' | 'doing' | 'blocked'; assignee?: string; blocker?: string }>;
  roster: Array<{ id: string; name: string; status: 'working' | 'idle' | 'on hold' | 'offline' | 'unknown'; contextPct: number | null }>;
  decisions: string[];
}

/** The persona the side agent reads as.
 *  - `null`   = None — no system prompt; pure neutral provider session.
 *  - object   = agent persona, name + optional role used as the opening identity line.
 *  - `undefined` (absent) = default "Floor assistant" persona. */
export type SideAgentPersona = { id: string; name: string; role?: string } | null;

/** Models a provider CLI reported for the side agent.
 *  - `ok`          = the CLI listed these ids (read verbatim from its output).
 *  - `unsupported` = the CLI has no way to list models; only its default is offered.
 *  - `unavailable` = the CLI is not installed.
 *  - `error`       = listing failed or timed out; the provider keeps its default. */
export type SideAgentModelList = {
  provider: SideAgentProvider;
  status: 'ok' | 'unsupported' | 'unavailable' | 'error';
  models: string[];
  error?: string;
};

/** `model` absent = the provider's own default model. */
type SideAgentSource = { provider: SideAgentProvider; context: SideAgentContext; persona: SideAgentPersona | undefined; model?: string };

export type SideAgentState =
  | { status: 'idle' }
  | (SideAgentSource & { status: 'running'; ptyId: string; cwd?: string })
  | (SideAgentSource & { status: 'stopped' | 'exited'; exitCode?: number; signal?: number });

export type SideAgentAction = 'start' | 'stop' | 'restart';
export type SideAgentResult = { ok: true } | { ok: false; error: string };
