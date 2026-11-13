// A saved launcher only fits the engine it runs (owner run of ceeb4aaf: the hire sheet preselected the
// Codex launcher dcxm for a Claude orchestrator, and every start failed). The form preselects a saved
// launcher only when its discovered engine matches; otherwise it shows Provider default.
import type { CouncilLauncherDiscovery, CouncilLauncherPick } from '@/data/paramount-api';

export function fitLauncher(pick: CouncilLauncherPick | null | undefined, provider: string | undefined, discovery: CouncilLauncherDiscovery | undefined): CouncilLauncherPick | null {
  if (!pick || !provider) return null;
  const choice = discovery?.choices.find((c) => c.id === pick.id);
  return choice && choice.provider === provider ? pick : null;
}
