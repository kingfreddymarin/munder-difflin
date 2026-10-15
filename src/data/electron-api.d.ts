import type { ParamountPreloadAPI } from './paramount-api';

export type * from './paramount-api';

/** The preload surface Paramount uses. `resizePty` exists on the fork's preload but is not in the shared contract. */
export type ElectronBridge = ParamountPreloadAPI & {
  resizePty?(id: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }>;
};

declare global {
  interface Window {
    /** The Paramount preload name. */
    paramount?: ElectronBridge;
    /** The name the Munder Difflin fork's preload uses today (`contextBridge.exposeInMainWorld('cth', …)`). */
    cth?: ElectronBridge;
  }
}
