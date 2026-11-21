export interface CouncilAccountProfile { id: string; provider: 'claude' | 'codex'; label: string; source: 'managed'; fingerprint: string; unrestricted: false; available: boolean }
export interface CouncilLauncherPick { id: string; fingerprint: string; allowUnrestricted?: boolean }
export interface CouncilLauncherDiscovery { status: 'ok' | 'failed' | 'timeout'; choices: Array<{ id: string; provider: string; label: string; fingerprint: string; unrestricted: boolean }>; message?: string }
export interface CouncilLauncherState { version: 1; orchestrator?: CouncilLauncherPick; temps?: CouncilLauncherPick; agents: Record<string, CouncilLauncherPick>; defaults?: Record<string, CouncilLauncherPick> }
export type ParamountSignInState =
  | { state: 'signed-in' | 'unknown'; accountId?: string; accountLabel?: string; accountFingerprint?: string }
  | { state: 'signed-out' | 'expired'; fix: string; seen?: string; accountId?: string; accountLabel?: string; accountFingerprint?: string };
/** Copy this file with the Paramount UI. It has no Electron or fork imports. */
export type ParamountCardStatus = 'backlog' | 'todo' | 'doing' | 'blocked' | 'review' | 'done';
export type ParamountAccess = 'rw' | 'r' | 'none';

export type ParamountCommand =
  | ParamountBoardCommand
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
  | { type: 'settings.update'; patch: Record<string, unknown> }
  | { type: 'terminal.input'; agentId: string; text: string }
  | { type: 'layout.panels'; panels: string[] }
  /** Read-only unless `confirm: true`; then opens a visible installer terminal. */
  | { type: 'prereq.install'; id: string; confirm?: boolean }
  /** Read-only unless `confirm: true`; then runs the vetted start command in a visible terminal. */
  | { type: 'prereq.start'; id: string; confirm?: boolean }
  | { type: 'setup.dismiss'; degraded: string[] }
  /** Read-only: returns a redacted diagnostics bundle on the result. */
  | { type: 'diagnostics.bundle'; logLines?: number }
  /** Saves the same redacted bundle as a JSON file through the core's save dialog.
   *  `name` is the suggested file name. The result's `saved` says whether the
   *  human picked a path or canceled; nothing is written on cancel. */
  | { type: 'diagnostics.save'; name: string; logLines?: number }
  /** Read-only: lists agents defined in Claude Code, Codex and Munder setups.
   *  `projectDir` adds that project's `.claude/agents` and `AGENTS.md`. */
  | { type: 'agents.discover'; sources?: ParamountAgentSource[]; projectDir?: string }
  /** Imports one discovered agent through the hire path: the Add-Agent form
   *  opens pre-filled and the human confirms the spawn. Pass the same
   *  `projectDir` used to discover a project agent. */
  | { type: 'agents.import'; source: ParamountAgentSource; id: string; projectDir?: string }
  | ParamountHomeChatsCommand
  // lane a-shell
  /** Opens an http(s) link in the default browser. Hosts: github.com,
   *  dev.azure.com, *.visualstudio.com; anything else fails INVALID_INPUT. */
  | { type: 'shell.openExternal'; url: string }
  /** Opens an existing absolute directory in Warp or VS Code (macOS). */
  | { type: 'shell.openIn'; app: ParamountOpenInApp; path: string }
  /** Read-only: what one agent touched. */
  | { type: 'terminal.artifacts'; agentId: string }
  /** Persist a per-provider "Don't ask again" login-reminder preference.
   *  `muted: true` silences automatic sign-in prompts for `provider` across
   *  restarts; `muted: false` re-enables them. Manual sign-in and status
   *  checks in Settings › Setup are unaffected. */
  | { type: 'signIn.muteReminder'; provider: 'claude' | 'codex'; muted: boolean };

export type ParamountOpenInApp = 'warp' | 'vscode';
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
  | 'UNSUPPORTED' | 'UNCERTAIN_STATE' | 'INTERNAL' | 'FORBIDDEN';
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
      discovery?: ParamountAgentDiscovery; imported?: ParamountAgentImport; artifacts?: ParamountArtifactMap;
      saved?: ParamountDiagnosticsSave }
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

/** Outcome of `diagnostics.save`: the written path, or canceled with nothing written. */
export type ParamountDiagnosticsSave = { canceled: true } | { canceled: false; path: string };

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
  organization?: ParamountOrganization;
  archivedAgents?: Array<{ id: string; name: string }>;
  prereqs?: unknown;
  integrations?: unknown[];
  /** Per-agent live telemetry; absent usage detail means the provider has no sample. */
  activity?: Record<string, unknown>;
}

/** Only the preload calls Paramount's React adapter needs. */
export interface ParamountPreloadAPI {
  /** Rejects with an Error whose message starts with "[<errorId>] <code>:". */
  paramountSnapshot(): Promise<ParamountRawSnapshot>;
  /** Save a validated portable hire@1 preset through a native save picker. */
  paramountSaveHirePreset?(manifest: Record<string, unknown>): Promise<{ canceled: boolean; path?: string; error?: string }>;
  /** GAP commands only. chat.send/card.move/terminal.input use the calls below. */
  paramountDispatch(command: ParamountCommand): Promise<ParamountResult>;
  startEngineSignIn(provider: 'claude' | 'codex', accountId?: string, accountFingerprint?: string): Promise<{ ok: boolean; ptyId?: string; cwd?: string; error?: string }>;
  refreshEngineSignIn(provider: 'claude' | 'codex', accountId?: string, accountFingerprint?: string): Promise<{ ok: boolean; status?: ParamountSignInState; error?: string }>;
  prepareClaudeTelegramChannels(): Promise<{ ok: boolean; canceled?: boolean; alreadyConfigured?: boolean; planId?: string; target?: string; changed?: string[]; error?: string }>;
  applyClaudeTelegramChannels(planId: string): Promise<{ ok: boolean; target?: string; backup?: string; changed?: string[]; recovery?: 'unchanged' | 'restored' | 'manual-restore'; error?: string }>;
  onParamountEvent(cb: (event: ParamountUpdate) => void): () => void;
  hiveSend(msg: { to: string; act: 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done'; subject: string; body: string }, from?: string): Promise<{ ok: boolean; error?: string; message?: unknown }>;
  hivePatchTask(id: string, patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  writePty(id: string, data: string): Promise<{ ok: boolean; error?: string }>;
  onPtyData(id: string, cb: (data: string) => void): () => void;
  onPtyExit(id: string, cb: (info: { exitCode: number; signal?: number }) => void): () => void;
}

// lane b-home-chats
/** How the human replied to an ask: free text, a picked option, or "done" for a to-do only they could do. */
export type ParamountAskMode = 'answer' | 'decision' | 'done';

export interface ParamountHomeLayout {
  density?: 'compact' | 'comfortable' | 'spacious';
  /** Tile ids, first shown first. */
  order?: string[];
  tiles?: Record<string, { size?: 'sm' | 'md' | 'lg'; hidden?: boolean }>;
}

/** A Main Objective the human sets on Home (STD-4). `owner` is an agent id; `cardKeys` link board cards. */
export interface ParamountObjective {
  id: string;
  title: string;
  why?: string;
  owner?: string;
  cardKeys?: string[];
  health: 'on-track' | 'at-risk' | 'blocked';
}

export type ParamountHomeChatsCommand =
  /** Answers an open ask (Munder's ASK ME). `messageId` is `<task id>:<humanQA index>` for a card's ask:
   *  the reply lands on the card as `a` (with `mode`) and is mailed to god and to the asking agent.
   *  Any other id is a hive message sent to the human; the reply is mailed back with `in_reply_to`. */
  | { type: 'ask.reply'; messageId: string; mode: ParamountAskMode; text: string }
  /** Clears a card's open ask off ASK ME without answering; the question stays on the card. */
  | { type: 'ask.dismiss'; messageId: string }
  /** Saves the Home layout under `home` in the snapshot's `preferences`. */
  | { type: 'home.layout'; layout: ParamountHomeLayout }
  /** Replaces the floor's Main Objectives, saved under `objectives.items` in the snapshot's `preferences`. */
  | { type: 'home.objectives'; objectives: ParamountObjective[] }
  /** Saves which update cards Chats hides, under `chats` in the snapshot's `preferences`. */
  | { type: 'chats.view'; hideUpdates?: boolean; hiddenIds?: string[] };

// lane c-board
/** A link a card carries to an external item (PR, build, run, work item).
 *  The agent that created or found the item stores its real URL on the card;
 *  `card.link` opens only https URLs that are stored on that card. */
export interface ParamountCardRef {
  kind: 'pr' | 'build' | 'run' | 'workitem';
  system: 'github' | 'ado';
  /** The item's own id as people say it, e.g. "23572". */
  id: string;
  url: string;
}
/** Optional board fields an agent may set on a hive task (tasks.json).
 *  Evidence lives on Azure DevOps: a card's evidence is its ADO `workitem` refs. */
export interface ParamountCardBoardFields {
  /** Free labels the agents choose (project, area); the board filters on them. */
  tags?: string[];
  /** Workspace the card belongs to, e.g. "Varium" or "Studio". */
  workspace?: string;
  /** Absolute working directory; `card.open` opens it in Warp or VS Code. */
  dir?: string;
  refs?: ParamountCardRef[];
}
/** Persisted in paramount-preferences.json under `board`; read from the snapshot's `preferences.board`. */
export interface ParamountBoardPreferences {
  /** The human's column order. Columns not listed keep their default order after these. */
  columns: ParamountCardStatus[];
}
export type ParamountOpenApp = 'warp' | 'vscode';
export type ParamountCardPatch = Partial<{ title: string; description: string; priority: 1 | 2 | 3; assignee: string }>;
/** Board commands, handled by src/main/paramount-board.ts. Send them through `paramountDispatch`. */
export type ParamountBoardCommand =
  | { type: 'board.columns'; order: ParamountCardStatus[] }
  | { type: 'card.open'; key: string; app: ParamountOpenApp }
  | { type: 'card.link'; key: string; url: string }
  | { type: 'card.update'; key: string; patch: ParamountCardPatch }
  | { type: 'card.archive'; key: string };

// lane d-team
/** Team-screen commands, sent through `paramountDispatch` like any other command. */
export type ParamountTeamCommand =
  /** Adds one card to the hive task ledger. Its key is the next number of the
   *  ledger's most used key prefix (NSC-68 → NSC-69). */
  | { type: 'card.create'; title: string; description?: string; assignee?: string;
      priority?: 1 | 2 | 3; status?: 'todo' | 'blocked' }
  /** Read-only: models per engine, the harness default model and each agent's pick. */
  | { type: 'team.models' }
  | { type: 'team.org.get' }
  | { type: 'team.org.save'; organization: ParamountOrganization }
  | { type: 'team.delegate'; teamId: string; title: string; description?: string; subtasks: Array<{ title: string; description?: string; ownerId: string; dependsOn: number[] }> }
  /** The Add-Agent form. Read-only unless `confirm: true`: without it the core
   *  validates the hire manifest and returns the exact spawn plan for review;
   *  with it the agent starts in a visible terminal. Nothing spawns unconfirmed. */
  | { type: 'agent.hire'; manifest: Record<string, unknown>; cwd?: string; confirm?: boolean; orchestrator?: boolean; launcher?: CouncilLauncherPick | null }
  | { type: 'agent.restart'; agentId: string; mode: 'resume' | 'fresh' }
  | { type: 'agent.switch'; agentId: string; provider: string; model: string; launcher: CouncilLauncherPick | null }
  | { type: 'accounts.list' }
  | { type: 'accounts.create'; provider: 'claude' | 'codex'; label: string }
  | { type: 'accounts.rename'; id: string; label: string }
  | { type: 'launchers.refresh' }
  | { type: 'launchers.configure'; scope: 'agent' | 'temps' | 'orchestrator' | 'default'; agentId?: string; provider?: string; launcher: CouncilLauncherPick | null };
/** `agent.update` with `{ model }` (and optionally the agent's own `engine`) is
 *  handled by the team module: the pick is saved and used at the agent's next
 *  start. An empty model clears the pick so the default applies again. */

export interface ParamountTeamModel {
  /** Absent = no --model flag (the CLI's own default). */
  id?: string;
  label: string;
}
export interface ParamountTeamModels {
  /** Engines that take a model, each with the models this build offers. */
  engines: Array<{ id: string; label: string; models: ParamountTeamModel[] }>;
  /** The harness default (config.defaultModel), a Claude model id; mark it "· default". */
  defaultModel?: string;
  /** Provider and model selected for Munder's main god/orchestrator. */
  orchestratorProvider?: string;
  /** The engine settings name for a NEW orchestrator, when the registered one runs on another. */
  orchestratorConfiguredProvider?: string;
  /** Set when the saved orchestrator launcher runs another engine (it is ignored; that engine's default applies). */
  orchestratorLauncherNote?: string;
  orchestratorId?: string;
  orchestratorModel?: string;
  accounts?: CouncilAccountProfile[];
  launchers?: CouncilLauncherDiscovery;
  launcherState?: CouncilLauncherState;
  /** Model chosen per agent in Paramount; an agent missing here runs the default. */
  agents: Record<string, { running?: { provider: string; model?: string; accountSelection: 'default' | 'selected' | 'unknown'; launcher?: { id: string; fingerprint: string; label: string } }; engine: string; model?: string; installed: boolean; accountSelection: 'default' | 'selected' | 'stale' | 'unavailable'; launcher?: { id: string; fingerprint: string; label: string } }>;
}
export interface ParamountOrganization { version: 1; teams: Array<{ id: string; name: string; leadId: string; memberIds: string[] }>; reportsTo: Record<string, string> }
export interface ParamountHirePlan {
  launcher?: string;
  agentId: string;
  name: string;
  role?: string;
  engine: string;
  model?: string;
  cwd: string;
  isolate: boolean;
  /** The exact command line the terminal runs. */
  command: string;
  /** False when the engine CLI is not installed; a confirmed hire is then refused. */
  engineInstalled: boolean;
  confirmed: boolean;
  /** MCP servers that need explicit consent; a hire never enables them. */
  consentRequired: string[];
  /** Fields of the manifest this build does not apply. */
  ignored: string[];
  /** Saved picks that did not fit the engine and were replaced by its default, in plain words. */
  notes?: string[];
}
/** The ok-result of a team command carries one of these payloads. */
export type ParamountTeamResult = Extract<ParamountResult, { ok: true }> & {
  accounts?: CouncilAccountProfile[];
  card?: { key: string };
  models?: ParamountTeamModels;
  organization?: ParamountOrganization;
  delegated?: { parentKey: string; childKeys: string[] };
  hire?: ParamountHirePlan;
};

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
  /** The cwd exists but is not in a git repository: a normal state (no changed files), not an error. */
  notRepo?: boolean;
  artifacts: ParamountArtifact[];
  /** Sources that could not be read; each errorId is on a `paramount-terminal` line in log.jsonl. */
  warnings: Array<{ errorId: string; source: string; message: string }>;
}
