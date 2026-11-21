import type { CouncilLauncherPick } from './paramount-api';
// The contract between the UI and the core. The UI sends commands (intent);
// the core validates them, appends events to the hive log, and pushes the events back.
import type { ParamountBoardCommand, ParamountArtifactMap, ParamountAgentDiscovery, ParamountAgentImport, ParamountAgentSource, ParamountDiagnostics, ParamountDiagnosticsSave, ParamountOpenInApp, ParamountHirePlan, ParamountOrganization, ParamountTeamCommand, ParamountTeamModels, ParamountTeamResult } from './paramount-api';
import type { ObjectiveInput } from './objectives';
import type { Access, Agent, AskMode, CardStatus, ChatView, HomeLayout, IterationSettings, Snapshot, YoloSettings } from './types';
export type Command =
  | { type: 'chat.send'; chatId: string; text: string }
  | { type: 'question.answer'; messageId: string; option: string }
  | { type: 'notification.act'; notificationId: string; action: string }
  | { type: 'card.move'; key: string; status: CardStatus }
  /** `key` is not sent: the core picks it and the provider puts it on the event. */
  | { type: 'card.create'; title: string; description?: string; assignee?: string; priority?: 1 | 2 | 3; status?: 'todo' | 'blocked'; key?: string }
  | { type: 'automation.toggle'; id: string; enabled: boolean }
  | { type: 'access.set'; agentId: string; sourceId: string; access: Access }
  | { type: 'agent.update'; agentId: string; patch: Partial<Pick<Agent, 'name' | 'color' | 'model' | 'engine' | 'tokensCap' | 'persona' | 'tone' | 'autonomy' | 'yolo'>> }
  | { type: 'agent.restart'; agentId: string; mode: 'resume' | 'fresh' }
  | { type: 'agent.switch'; agentId: string; provider: string; model: string; launcher: CouncilLauncherPick | null }
  | { type: 'floor.yolo'; patch: Partial<YoloSettings> }
  | { type: 'floor.iteration'; patch: Partial<IterationSettings> }
  | { type: 'account.connection'; id: string; connected: boolean }
  | { type: 'account.notify'; id: string; on: boolean }
  | { type: 'account.profile'; patch: Partial<Pick<Snapshot['me'], 'name' | 'workEmail' | 'timezone'>> }
  | { type: 'settings.update'; patch: Record<string, unknown> }
  | { type: 'terminal.input'; agentId: string; text: string }
  | { type: 'layout.panels'; panels: string[] }
  | { type: 'prereq.install'; id: string; confirm?: boolean }
  | { type: 'prereq.start'; id: string; confirm?: boolean }
  | { type: 'setup.dismiss'; degraded: string[] }
  | { type: 'signIn.muteReminder'; provider: 'claude' | 'codex'; muted: boolean }
  | { type: 'orchestrator.ensure' }
  | { type: 'floor.retry' }
  | { type: 'floor.choose-another' }
  | { type: 'floor.open'; home: string }
  | { type: 'floor.picker'; open: boolean }
  | { type: 'floor.switch' }
  | { type: 'setup.complete'; home: string; engine: string; model?: string; autoMode?: boolean; codexExecutionPolicy?: 'inherit' | 'workspace-ask' | 'workspace-auto' | 'full-ask' | 'full-auto'; launcher?: CouncilLauncherPick | null; launcherDefaults?: Record<string, CouncilLauncherPick | null>; tempLauncher?: CouncilLauncherPick | null }
  | { type: 'accounts.list' }
  | { type: 'accounts.create'; provider: 'claude' | 'codex'; label: string }
  | { type: 'accounts.rename'; id: string; label: string }
  | { type: 'launchers.refresh' }
  | { type: 'launchers.configure'; scope: 'agent' | 'temps' | 'orchestrator' | 'default'; agentId?: string; provider?: string; launcher: CouncilLauncherPick | null }
  | { type: 'ask.reply'; messageId: string; mode: AskMode; text: string }
  | { type: 'ask.dismiss'; messageId: string }
  | { type: 'home.layout'; layout: HomeLayout }
  | { type: 'home.objectives'; objectives: ObjectiveInput[] }
  | ({ type: 'chats.view' } & ChatView)
  | ParamountBoardCommand;

// Every event is attributed and correlated, which is what makes the audit log and
// "your change goes into the agent's context" fall out of the log for free.
export interface FloorEvent {
  id: string;
  at: string;
  actor: 'you';
  command: Command;
}

export interface DataProvider {
  snapshot(): Promise<Snapshot>;
  dispatch(command: Command): Promise<FloorEvent>;
  subscribe(listener: (event: FloorEvent) => void): () => void;
  /** 'electron' is the real core through the preload; 'mock' is the in-browser fixtures. */
  kind?: 'electron' | 'mock';
  /** Asks for a fresh snapshot when the core says its data changed. */
  onRefresh?(listener: () => void): () => void;
  /** Why the core cannot run this command, before it is sent; null when it can. The UI disables the control and shows the reason. */
  unsupported?(command: Command): string | null;
  /** Redacted support bundle. Absent when the provider cannot produce one. */
  diagnostics?(): Promise<ParamountDiagnostics>;
  /** Saves the redacted bundle through the core's save dialog, suggesting `name`; reports a cancel as canceled. */
  saveDiagnostics?(name: string): Promise<ParamountDiagnosticsSave>;
  /** Save an existing agent's portable hire@1 definition through the native picker. */
  saveAgentPreset?(manifest: Record<string, unknown>): Promise<{ canceled: boolean; path?: string; error?: string }>;
  /** Read-only list of agents defined in Claude Code, Codex and Munder setups. Absent when the provider cannot scan disk. */
  discoverAgents?(options?: { sources?: ParamountAgentSource[]; projectDir?: string }): Promise<ParamountAgentDiscovery>;
  /** Imports one discovered agent through the hire path; the human confirms the spawn in the Add-Agent form. */
  importAgent?(source: ParamountAgentSource, id: string, projectDir?: string): Promise<ParamountAgentImport>;
  /** Opens an http(s) link in the default browser; the core refuses hosts outside its allow-list. Absent when the provider cannot open links. */
  openExternal?(url: string): Promise<void>;
  /** Opens an existing absolute folder in Warp or VS Code. Absent when the provider cannot launch apps. */
  openIn?(app: ParamountOpenInApp, path: string): Promise<void>;
  /** Models per engine, the default model and each agent's pick (`team.models`). */
  teamModels?(): Promise<ParamountTeamModels>;
  createTeam?(request: Extract<ParamountTeamCommand, { type: 'team.org.create' }>): Promise<NonNullable<ParamountTeamResult['createdTeam']>>;
  organization?(): Promise<ParamountOrganization>;
  saveOrganization?(organization: ParamountOrganization, expected?: ParamountOrganization): Promise<ParamountOrganization>;
  delegate?(request: Extract<ParamountTeamCommand, { type: 'team.delegate' }>): Promise<NonNullable<ParamountTeamResult['delegated']>>;
  archiveAgent?(id: string, archived: boolean): Promise<void>;
  sendNote?(id: string, text: string): Promise<void>;
  startEngineSignIn?(provider: 'claude' | 'codex', accountId?: string, accountFingerprint?: string): Promise<{ ptyId: string; cwd: string }>;
  refreshEngineSignIn?(provider: 'claude' | 'codex', accountId?: string, accountFingerprint?: string): Promise<import('./paramount-api').ParamountSignInState>;
  /** The Add-Agent hire: without `confirm` it returns the spawn plan for review; with it the agent starts in a visible terminal. */
  hire?(manifest: Record<string, unknown>, options?: { cwd?: string; confirm?: boolean; orchestrator?: boolean; launcher?: CouncilLauncherPick | null }): Promise<ParamountHirePlan>;
  /** Read-only: map artifacts touched by an agent. */
  artifacts?(agentId: string): Promise<ParamountArtifactMap>;
}
