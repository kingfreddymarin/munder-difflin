export const TERMINAL_SIDE_PANEL_IDS = ['asks', 'talk', 'artifacts', 'updates', 'profile'] as const;
export type TerminalSidePanelId = typeof TERMINAL_SIDE_PANEL_IDS[number];
export const TERMINAL_SIDE_PANEL_KEY = 'paramount.terminal.side.panels.v1';
export const TERMINAL_SIDE_PANEL_DEFAULT: TerminalSidePanelId[] = [...TERMINAL_SIDE_PANEL_IDS];

/** Terminal sidebar panel visibility is a per-viewer preference, persisted locally. */
export function persistTerminalPanels(
  next: TerminalSidePanelId[],
  storage: Pick<Storage, 'setItem'> = localStorage,
): TerminalSidePanelId[] {
  try { storage.setItem(TERMINAL_SIDE_PANEL_KEY, JSON.stringify(next)); } catch { /* per-viewer preference only */ }
  return next;
}

export function loadTerminalPanels(
  storage: Pick<Storage, 'getItem'> = localStorage,
): TerminalSidePanelId[] {
  try {
    const v = JSON.parse(storage.getItem(TERMINAL_SIDE_PANEL_KEY) ?? 'null');
    if (!Array.isArray(v)) return TERMINAL_SIDE_PANEL_DEFAULT;
    const valid = v.filter((x): x is TerminalSidePanelId => TERMINAL_SIDE_PANEL_IDS.includes(x as TerminalSidePanelId));
    return valid.length ? valid : TERMINAL_SIDE_PANEL_DEFAULT;
  } catch {
    return TERMINAL_SIDE_PANEL_DEFAULT;
  }
}
