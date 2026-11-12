// The floor picker state from the core's snapshot (floorSetup.choice). Unknown states and malformed
// rows are dropped, so the picker never offers a row it cannot describe.
import type { FloorChoice, FloorProbeState } from './types';

const STATES: readonly FloorProbeState[] = ['free', 'held', 'missing', 'current', 'data-folder'];

export function floorChoiceOf(value: unknown): FloorChoice | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.pending !== 'boolean') return undefined;
  const recents = (Array.isArray(v.recents) ? v.recents : []).flatMap((r): FloorChoice['recents'] => {
    const row = r && typeof r === 'object' ? r as Record<string, unknown> : {};
    const state = STATES.find((s) => s === row.state);
    if (typeof row.path !== 'string' || !row.path || !state) return [];
    return [{ path: row.path, exists: row.exists === true, state, ...(typeof row.heldBy === 'string' && row.heldBy ? { heldBy: row.heldBy } : {}) }];
  });
  return { pending: v.pending, newFloor: v.newFloor === true, last: typeof v.last === 'string' ? v.last : null, recents };
}
