import type { ParamountPreloadAPI } from './paramount-api';

export type * from './paramount-api';

/** The preload surface Paramount uses. The optional calls exist on the fork's preload but are not in the shared
 *  contract; each caller checks for them and says what it cannot do when one is missing. */
export type ElectronBridge = ParamountPreloadAPI & {
  resizePty?(id: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }>;
  // Terminal (lane e-terminal): the same calls Munder's own terminal uses.
  /** Asks the TUI for a fresh frame at its current size; output from before we subscribed is otherwise never shown. */
  redrawPty?(id: string): Promise<{ ok: boolean; error?: string }>;
  onPtyRelaunch?(id: string, cb: () => void): () => void;
  copyToClipboard?(text: string): Promise<{ ok: boolean; error?: string }>;
  // Quit confirmation (Munder's QuitWarningModal): main defers a quit while agents run and asks the window.
  onCloseRequested?(cb: (info: { ptyCount: number }) => void): () => void;
  confirmClose?(): Promise<void>;
  cancelClose?(): Promise<void>;
  readClipboard?(): Promise<string>;
  /** Native folder dialog (openDirectory + createDirectory). error 'cancelled' when the human cancels. */
  chooseFolder?(): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  readClipboardSync?(): string;
  /** https only; the main process re-checks. */
  openExternal?(url: string): Promise<{ ok: boolean; error?: string }>;
  /** Shows a file in Finder, or opens a directory. Never opens a file with its default app. */
  revealPath?(path: string): Promise<{ ok: boolean; error?: string }>;
  pathForFile?(file: File): string;
  statAbs?(path: string): Promise<{ exists: boolean; isFile: boolean; path: string }>;
  providerKeyHas?(backend: string): Promise<boolean>;
  providerKeySet?(request: { backend: string; key: string }): Promise<{ ok: boolean; error?: string }>;
  providerKeyClear?(backend: string): Promise<{ ok: boolean; error?: string }>;
  hiveMemory?(id: string): Promise<string>;
  textSearch?(query: string): Promise<{ ok: boolean; results: Array<{ source: string; excerpt: string }> }>;
  searchMemory?(query: string, wing?: string): Promise<{ ok: boolean; output: string; error?: string }>;
};

declare global {
  interface Window {
    /** The Paramount preload name. */
    paramount?: ElectronBridge;
    /** The name the Munder Difflin fork's preload uses today (`contextBridge.exposeInMainWorld('cth', …)`). */
    cth?: ElectronBridge;
  }
}
