// Finds the Electron preload. Paramount runs against it when present and falls back to fixtures otherwise.
import type { ElectronBridge } from './electron-api';
import { BackendError } from './errors';

const usable = (value: unknown): value is ElectronBridge =>
  !!value && typeof (value as ElectronBridge).paramountSnapshot === 'function' && typeof (value as ElectronBridge).paramountDispatch === 'function';

export function findBridge(): ElectronBridge | null {
  if (typeof window === 'undefined') return null;
  if (usable(window.paramount)) return window.paramount;
  if (usable(window.cth)) return window.cth;
  return null;
}

/** The bridge, or a DISCONNECTED error that names what is missing. */
export function requireBridge(): ElectronBridge {
  const bridge = findBridge();
  if (!bridge) throw BackendError.local('DISCONNECTED', 'The desktop core is not connected. Open Paramount in the desktop app, then retry.');
  return bridge;
}
