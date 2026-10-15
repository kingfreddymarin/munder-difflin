import { autoModeExpired } from './paramount';

/** Timed YOLO (bypass permissions). When the persisted expiry passes, autoMode
 *  turns off with a log line. Electron-free so the timer logic is testable. */
export interface AutoModeExpiryDeps {
  read: () => { autoMode?: boolean; autoModeExpiresAt?: string };
  write: (patch: { autoMode: false; autoModeExpiresAt: undefined }) => void;
  /** In-memory fail safe: while set, every config read reports autoMode off,
   *  so a failed disk write can never leave bypass on past its window. */
  forceOff: (on: boolean) => void;
  log: (event: Record<string, unknown>) => void;
  newErrorId: () => string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Retry waits after a failed expiry write: 5 s doubling, capped at 5 min. */
export const EXPIRY_RETRY_MS = { first: 5_000, max: 300_000 };
/** Below the 2^31 setTimeout limit; the timer re-arms on wake. */
const MAX_WAIT_MS = 2_000_000_000;

export function retryDelay(attempt: number): number {
  return Math.min(EXPIRY_RETRY_MS.first * 2 ** Math.max(0, attempt - 1), EXPIRY_RETRY_MS.max);
}

export function createAutoModeExpiry(deps: AutoModeExpiryDeps): { arm: () => void } {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let failures = 0;

  function arm(): void {
    if (timer) { clearTimer(timer); timer = null; }
    const cfg = deps.read();
    if (!cfg.autoModeExpiresAt) { failures = 0; return; }
    if (!autoModeExpired(cfg.autoModeExpiresAt, now())) {
      failures = 0;
      timer = setTimer(arm, Math.min(Date.parse(cfg.autoModeExpiresAt) - now(), MAX_WAIT_MS));
      return;
    }
    // Expired. Force off in memory first, so bypass is off even if the write fails.
    deps.forceOff(true);
    try {
      deps.write({ autoMode: false, autoModeExpiresAt: undefined });
      failures = 0;
      deps.forceOff(false);
      deps.log({ kind: 'paramount-yolo-expired', expiredAt: cfg.autoModeExpiresAt });
    } catch (e) {
      failures += 1;
      const retryInMs = retryDelay(failures);
      deps.log({
        kind: 'paramount-error', errorId: deps.newErrorId(), code: 'UNCERTAIN_STATE', op: 'yolo-expiry',
        attempt: failures, retryInMs, message: e instanceof Error ? e.message : String(e)
      });
      timer = setTimer(arm, retryInMs);
    }
  }

  return { arm };
}

/** Normalizes a generic config patch that touches autoMode (classic Settings,
 *  voice actions): a plain on/off toggle without a stamp ends any timed window,
 *  and turning off always clears the stamp. Returns the patch unchanged otherwise. */
export function normalizeAutoModePatch<T extends { autoMode?: boolean; autoModeExpiresAt?: string }>(patch: T): T {
  if (!patch || typeof patch.autoMode !== 'boolean') return patch;
  if (patch.autoMode === false || !('autoModeExpiresAt' in patch)) return { ...patch, autoModeExpiresAt: undefined };
  return patch;
}

/** True when the patch changes autoMode or its expiry, so the timer must re-arm. */
export function touchesAutoModeExpiry(patch: unknown): boolean {
  return !!patch && typeof patch === 'object' && ('autoMode' in patch || 'autoModeExpiresAt' in patch);
}
