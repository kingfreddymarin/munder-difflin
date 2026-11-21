import type { TeamPanelId } from './team-panel-route';

export const TEAM_PANEL_LAYOUT_KEY = 'paramount.team.panels.v2';

/** Team panel order is a per-viewer renderer preference, persisted locally. */
export function persistTeamPanels(next: TeamPanelId[], storage: Pick<Storage, 'setItem'> = localStorage): TeamPanelId[] {
  try { storage.setItem(TEAM_PANEL_LAYOUT_KEY, JSON.stringify(next)); } catch { /* per-viewer preference only */ }
  return next;
}
