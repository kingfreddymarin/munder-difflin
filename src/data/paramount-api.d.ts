/** Copy this file with the Paramount UI. It has no Electron or fork imports. */
export type ParamountCardStatus = 'backlog' | 'todo' | 'doing' | 'blocked' | 'review' | 'done';
export type ParamountAccess = 'rw' | 'r' | 'none';

export type ParamountCommand =
  | { type: 'chat.send'; chatId: string; text: string }
  | { type: 'question.answer'; messageId: string; option: string }
  | { type: 'notification.act'; notificationId: string; action: string }
  | { type: 'card.move'; key: string; status: ParamountCardStatus }
  | { type: 'automation.toggle'; id: string; enabled: boolean }
  | { type: 'access.set'; agentId: string; sourceId: string; access: ParamountAccess }
  | { type: 'agent.update'; agentId: string; patch: Partial<{
      name: string; color: string; model: string; engine: string; tokensCap: number;
      persona: string; tone: string; autonomy: string; yolo: boolean;
    }> }
  | { type: 'floor.yolo'; patch: Partial<{
      on: boolean; autoOffHours: number | null; keepHardRules: boolean; since: string;
    }> }
  | { type: 'floor.iteration'; patch: Partial<{
      speed: 'fast' | 'balanced' | 'careful'; heartbeatSec: number;
      standupMin: number; checkpointEverySteps: number;
    }> }
  | { type: 'account.connection'; id: string; connected: boolean }
  | { type: 'account.notify'; id: string; on: boolean }
  | { type: 'account.profile'; patch: Partial<{ name: string; workEmail: string; timezone: string }> }
  | { type: 'terminal.input'; agentId: string; text: string }
  | { type: 'layout.panels'; panels: string[] }
  /** Read-only unless `confirm: true`; then opens a visible installer terminal. */
  | { type: 'prereq.install'; id: string; confirm?: boolean }
  /** Read-only unless `confirm: true`; then runs the vetted start command in a visible terminal. */
  | { type: 'prereq.start'; id: string; confirm?: boolean }
  | { type: 'setup.dismiss'; degraded: string[] }
  /** Read-only: returns a redacted diagnostics bundle on the result. */
  | { type: 'diagnostics.bundle'; logLines?: number }
  /** Read-only: lists agents defined in Claude Code, Codex and Munder setups.
   *  `projectDir` adds that project's `.claude/agents` and `AGENTS.md`. */
  | { type: 'agents.discover'; sources?: ParamountAgentSource[]; projectDir?: string }
  /** Imports one discovered agent through the hire path: the Add-Agent form
   *  opens pre-filled and the human confirms the spawn. Pass the same
   *  `projectDir` used to discover a project agent. */
  | { type: 'agents.import'; source: ParamountAgentSource; id: string; projectDir?: string }
  // lane a-shell
  /** Opens an http(s) link in the default browser. Hosts: github.com,
   *  dev.azure.com, *.visualstudio.com; anything else fails INVALID_INPUT. */
  | { type: 'shell.openExternal'; url: string }
  /** Opens an existing absolute directory in Warp or VS Code (macOS). */
  | { type: 'shell.openIn'; app: ParamountOpenInApp; path: string }
  // lane e-terminal
  /** Read-only: what one agent touched (git changes/commits in its cwd, paths and links in its messages). */
  | { type: 'terminal.artifacts'; agentId: string };

export interface ParamountEvent {
  id: string;
  at: string;
  actor: 'you';
  command: ParamountCommand;
  /** The dispatch's correlation id; matches its `paramount-op` lines in log.jsonl. */
  correlationId?: string;
}
export type ParamountUpdate = ParamountEvent | {
  kind: 'invalidate';
  at: string;
  source: string;
};
/** Stable failure codes; branch on these, not on message text. */
export type ParamountErrorCode =
  | 'INVALID_COMMAND' | 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT'
  | 'UNSUPPORTED' | 'UNCERTAIN_STATE' | 'INTERNAL';
/** Every failure carries an errorId. The same id is on a `paramount-error`
 *  line in log.jsonl with the stack and context; show it to the user. */
export interface ParamountFailure {
  ok: false;
  errorId: string;
  code: ParamountErrorCode;
  message: string;
  /** Same text as `message`; kept for callers written before errorId. */
  error: string;
  correlationId: string;
}
export type ParamountResult =
  | { ok: true; event: ParamountEvent; diagnostics?: ParamountDiagnostics; prereq?: ParamountPrereqReport;
      discovery?: ParamountAgentDiscovery; imported?: ParamountAgentImport; artifacts?: ParamountArtifactMap }
  | ParamountFailure;

/** What `prereq.install` would run (confirmed=false) or started (confirmed=true). */
export interface ParamountPrereqReport {
  id: string;
  label: string;
  installed: boolean;
  kind: 'npm' | 'node-then-npm' | 'native' | 'manual' | 'start';
  /** The exact trusted command the installer terminal runs. */
  command: string;
  confirmed: boolean;
  /** Terminal to stream with onPtyData; present only after a confirmed start. */
  ptyId?: string;
}

export type ParamountAgentSource = 'claude' | 'codex' | 'munder';

/** A file that could not be read or parsed. Never skipped silently: the same
 *  errorId is on a `paramount-agent-source` line in log.jsonl. */
export interface ParamountSourceWarning {
  errorId: string;
  path: string;
  message: string;
}

/** One agent definition found on disk. Read-only: nothing is copied or changed. */
export interface ParamountDiscoveredAgent {
  source: ParamountAgentSource;
  /** Stable within a source; pass it back to `agents.import`. */
  id: string;
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  /** File holding the agent's instructions (or its definition, for a model-only profile). */
  instructionsPath: string;
  origin: 'user' | 'project';
  /** Problems with this agent's file that did not stop it being listed. */
  warnings: ParamountSourceWarning[];
}

export interface ParamountAgentDiscovery {
  agents: ParamountDiscoveredAgent[];
  /** Files or directories that could not be read; their agents are missing above. */
  warnings: ParamountSourceWarning[];
  /** Roots that were scanned, per source; a missing root just yields no agents. */
  roots: Record<ParamountAgentSource, string[]>;
}

export interface ParamountAgentImport {
  agent: ParamountDiscoveredAgent;
  /** Hire manifest handed to the Add-Agent form (munder-difflin/hire@1). */
  manifest: Record<string, unknown>;
  /** Fields that were dropped or shortened to fit the hire manifest limits. */
  adjustments: string[];
}

/** Redacted support bundle returned by `diagnostics.bundle`. */
export interface ParamountDiagnostics {
  generatedAt: string;
  correlationId: string;
  app: Record<string, unknown>;
  os: Record<string, unknown>;
  /** App config with secrets replaced by "[REDACTED]". */
  config: unknown;
  /** Newest log.jsonl lines, oldest first, redacted. */
  logTail: unknown[];
  /** Newest crash reports first, each capped at 16 KB, redacted. */
  crashes: Array<{ file: string; bytes: number; modifiedAt: string; content: string }>;
  /** Parts that could not be read; the bundle is still returned. */
  errors: string[];
}

/** Fork-native data; the React DataProvider projects this into its own Snapshot. */
export interface ParamountRawSnapshot {
  registry: unknown;
  tasks: unknown;
  messages: unknown[];
  log: unknown[];
  roster: unknown | null;
  config: { notifications: boolean; autoMode: boolean };
  missions: unknown[];
  ptys: unknown[];
  preferences: Record<string, unknown>;
}

/** Only the preload calls Paramount's React adapter needs. */
export interface ParamountPreloadAPI {
  /** Rejects with an Error whose message starts with "[<errorId>] <code>:". */
  paramountSnapshot(): Promise<ParamountRawSnapshot>;
  /** GAP commands only. chat.send/card.move/terminal.input use the calls below. */
  paramountDispatch(command: ParamountCommand): Promise<ParamountResult>;
  onParamountEvent(cb: (event: ParamountUpdate) => void): () => void;
  hiveSend(msg: { to: string; act: 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done'; subject: string; body: string }, from?: string): Promise<{ ok: boolean; error?: string; message?: unknown }>;
  hivePatchTask(id: string, patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  writePty(id: string, data: string): Promise<{ ok: boolean; error?: string }>;
  onPtyData(id: string, cb: (data: string) => void): () => void;
  onPtyExit(id: string, cb: (info: { exitCode: number; signal?: number }) => void): () => void;
}

// lane a-shell
export type ParamountOpenInApp = 'warp' | 'vscode';

// lane e-terminal
/** One thing an agent touched. `dir` is an existing absolute directory to pass to
 *  `shell.openIn` (Warp / VS Code); absent when nothing on disk matches. */
export interface ParamountArtifact {
  /** changed = uncommitted in its tree; committed = in a recent commit; commit = the commit itself;
   *  mentioned = an absolute path in a message it sent; link = an http(s) link in a message it sent. */
  kind: 'changed' | 'committed' | 'commit' | 'mentioned' | 'link';
  label: string;
  path?: string;
  dir?: string;
  url?: string;
  /** git porcelain status (M, A, D, ??, R…) for `changed`. */
  status?: string;
  commit?: string;
  at?: string;
  messageId?: string;
}
export interface ParamountArtifactMap {
  agentId: string;
  /** The agent's registry cwd; empty when it has none. */
  cwd: string;
  repo: { root: string; branch: string; head: string } | null;
  artifacts: ParamountArtifact[];
  /** Sources that could not be read; each errorId is on a `paramount-terminal` line in log.jsonl. */
  warnings: Array<{ errorId: string; source: string; message: string }>;
}
