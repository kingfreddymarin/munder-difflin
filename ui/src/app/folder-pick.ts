// The native folder dialog (main's dialog:chooseFolder: openDirectory + createDirectory, as Munder
// uses it). Cancel is not an error: the caller leaves its field as it was.
import type { ElectronBridge } from '../data/electron-api';

export type FolderPick =
  | { kind: 'chosen'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' }
  | { kind: 'failed'; message: string };

export async function chooseFolder(bridge: Pick<ElectronBridge, 'chooseFolder'> | null): Promise<FolderPick> {
  if (!bridge?.chooseFolder) return { kind: 'unavailable' };
  try {
    const r = await bridge.chooseFolder();
    if (r.ok) return r.path.startsWith('/') ? { kind: 'chosen', path: r.path } : { kind: 'failed', message: `The dialog returned a path that is not absolute: ${r.path}` };
    return r.error === 'cancelled' ? { kind: 'cancelled' } : { kind: 'failed', message: r.error || 'The folder dialog failed.' };
  } catch (e) {
    return { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}
