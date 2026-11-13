/** Build only the portable hire@1 fields known for an existing Paramount agent. */
export interface ExistingAgentPresetSource {
  name: string;
  provider: string;
  model?: string;
  accent?: string;
  tokenCapMillions?: number;
}

export function hirePresetFromAgent(agent: ExistingAgentPresetSource): Record<string, unknown> {
  const rawProvider = agent.provider.trim().toLowerCase();
  const provider = rawProvider === 'agy' || rawProvider === 'antigravity' ? 'antigravity'
    : rawProvider === 'claude' || rawProvider === 'claude-code' ? 'claude'
      : rawProvider === 'codex' ? 'codex'
        : rawProvider === 'cursor' ? 'cursor' : null;
  if (!provider) throw new Error(`Provider “${agent.provider}” cannot be saved in a hire@1 preset.`);

  const preset: Record<string, unknown> = { spec: 'munder-difflin/hire@1', name: agent.name, provider };
  if (agent.model?.trim()) preset.model = agent.model.trim();
  if (agent.accent?.trim()) preset.accent = agent.accent.trim();
  if (typeof agent.tokenCapMillions === 'number' && Number.isFinite(agent.tokenCapMillions) && agent.tokenCapMillions > 0) {
    const tokenCap = Math.round(agent.tokenCapMillions * 1_000_000);
    if (!Number.isSafeInteger(tokenCap)) throw new Error('The selected agent token cap is too large to export.');
    preset.tokenCap = tokenCap;
  }
  return preset;
}

export function saveExistingAgentPreset(
  agent: ExistingAgentPresetSource,
  save: (manifest: Record<string, unknown>) => Promise<{ canceled: boolean; path?: string; error?: string }>,
) {
  return save(hirePresetFromAgent(agent));
}
