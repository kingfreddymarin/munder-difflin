// The contract between the UI and the core. The UI sends commands (intent);
// the core validates them, appends events to the hive log, and pushes the events back.
import type { ParamountAgentDiscovery, ParamountAgentImport, ParamountAgentSource, ParamountDiagnostics, ParamountHirePlan, ParamountTeamModels } from './paramount-api';
import type { Access, Agent, CardStatus, IterationSettings, Snapshot, YoloSettings } from './types';

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
  | { type: 'floor.yolo'; patch: Partial<YoloSettings> }
  | { type: 'floor.iteration'; patch: Partial<IterationSettings> }
  | { type: 'account.connection'; id: string; connected: boolean }
  | { type: 'account.notify'; id: string; on: boolean }
  | { type: 'account.profile'; patch: Partial<Pick<Snapshot['me'], 'name' | 'workEmail' | 'timezone'>> }
  | { type: 'terminal.input'; agentId: string; text: string }
  | { type: 'layout.panels'; panels: string[] }
  | { type: 'prereq.install'; id: string; confirm?: boolean }
  | { type: 'prereq.start'; id: string; confirm?: boolean }
  | { type: 'setup.dismiss'; degraded: string[] };

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
  /** Read-only list of agents defined in Claude Code, Codex and Munder setups. Absent when the provider cannot scan disk. */
  discoverAgents?(options?: { sources?: ParamountAgentSource[]; projectDir?: string }): Promise<ParamountAgentDiscovery>;
  /** Imports one discovered agent through the hire path; the human confirms the spawn in the Add-Agent form. */
  importAgent?(source: ParamountAgentSource, id: string, projectDir?: string): Promise<ParamountAgentImport>;
  /** Models per engine, the default model and each agent's pick (`team.models`). */
  teamModels?(): Promise<ParamountTeamModels>;
  /** The Add-Agent hire: without `confirm` it returns the spawn plan for review; with it the agent starts in a visible terminal. */
  hire?(manifest: Record<string, unknown>, options?: { cwd?: string; confirm?: boolean }): Promise<ParamountHirePlan>;
}
