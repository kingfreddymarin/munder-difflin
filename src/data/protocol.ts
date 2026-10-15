// The contract between the UI and the core. The UI sends commands (intent);
// the core validates them, appends events to the hive log, and pushes the events back.
import type { Access, Agent, CardStatus, IterationSettings, Snapshot, YoloSettings } from './types';

export type Command =
  | { type: 'chat.send'; chatId: string; text: string }
  | { type: 'question.answer'; messageId: string; option: string }
  | { type: 'notification.act'; notificationId: string; action: string }
  | { type: 'card.move'; key: string; status: CardStatus }
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
  | { type: 'prereq.install'; id: string }
  | { type: 'prereq.start'; id: string }
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
}
