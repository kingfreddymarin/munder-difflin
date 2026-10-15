import type { Command, FloorEvent } from './protocol';

export type ParamountUpdate = FloorEvent | { kind: 'invalidate'; at: string; source: string };

export interface ElectronBridge {
  paramountSnapshot(): Promise<Record<string, unknown>>;
  paramountDispatch(command: Command): Promise<{ ok: true; event: FloorEvent } | { ok: false; error: string }>;
  onParamountEvent(listener: (event: ParamountUpdate) => void): () => void;
  hiveSend(message: { to: string; act: 'request'; subject: string; body: string }, from: string): Promise<{ ok: boolean; error?: string }>;
  hivePatchTask(id: string, patch: { status: 'todo' | 'doing' | 'blocked' | 'done' }): Promise<{ ok: boolean; error?: string }>;
  writePty(id: string, data: string): Promise<{ ok: boolean; error?: string }>;
  resizePty(id: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }>;
  onPtyData(id: string, listener: (data: string) => void): () => void;
  onPtyExit(id: string, listener: () => void): () => void;
}

declare global {
  interface Window { cth?: ElectronBridge }
}
