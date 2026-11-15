// NSC-222 (B2): a floor window can come up focused while the human is typing in another app; the
// chooser's listbox is autofocused and opens the selected floor on Enter. This guard drops an Enter
// that lands within a short grace period after the chooser appears or regains focus (and auto-repeat),
// so stray typing cannot open a floor. A deliberate Enter after the grace period still works.
export const FOCUS_ENTER_GRACE_MS = 400;

export type EnterGuard = { focused(): void; allows(e: { repeat?: boolean }): boolean };

export function createEnterGuard(now: () => number = () => Date.now(), graceMs = FOCUS_ENTER_GRACE_MS): EnterGuard {
  let focusedAt = now();
  return {
    focused() { focusedAt = now(); },
    allows(e) { return !e.repeat && now() - focusedAt >= graceMs; },
  };
}
