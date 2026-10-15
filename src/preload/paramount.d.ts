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
  | { type: 'prereq.install'; id: string }
  | { type: 'prereq.start'; id: string }
  | { type: 'setup.dismiss'; degraded: string[] };

export interface ParamountEvent {
  id: string;
  at: string;
  actor: 'you';
  command: ParamountCommand;
}
export type ParamountUpdate = ParamountEvent | {
  kind: 'invalidate';
  at: string;
  source: string;
};
export type ParamountResult =
  | { ok: true; event: ParamountEvent }
  | { ok: false; error: string };

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
