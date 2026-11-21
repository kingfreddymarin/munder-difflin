export const TEAM_PANEL_IDS = ['agents', 'graph', 'activity', 'sources', 'automations'] as const;
export type TeamPanelId = typeof TEAM_PANEL_IDS[number];

export function isTeamPanelId(value: string | null): value is TeamPanelId {
  return value !== null && TEAM_PANEL_IDS.includes(value as TeamPanelId);
}

/** Add a deep-linked panel to the saved screen layout, preserving its current order. */
export function revealTeamPanel(panels: TeamPanelId[], requested: string | null): TeamPanelId[] {
  if (!isTeamPanelId(requested) || panels.includes(requested)) return panels;
  return [...panels, requested];
}
