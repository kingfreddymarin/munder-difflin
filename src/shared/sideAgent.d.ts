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

type SideAgentSource = { provider: SideAgentProvider; context: SideAgentContext };

export type SideAgentState =
  | { status: 'idle' }
  | (SideAgentSource & { status: 'running'; ptyId: string })
  | (SideAgentSource & { status: 'stopped' | 'exited'; exitCode?: number; signal?: number });

export type SideAgentAction = 'start' | 'stop' | 'restart';
export type SideAgentResult = { ok: true } | { ok: false; error: string };
