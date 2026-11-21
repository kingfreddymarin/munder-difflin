// A saved launcher only fits the engine it runs (owner run of ceeb4aaf: the hire sheet preselected the
// Codex launcher dcxm for a Claude orchestrator, and every start failed). The form preselects a saved
// launcher only when its discovered engine matches; otherwise it shows Provider default.
import type { CouncilLauncherDiscovery, CouncilLauncherPick } from '@/data/paramount-api';

// The core accepts only id, fingerprint and allowUnrestricted in a pick (NSC-267). A saved or running
// launcher reported by team.models also carries its label, so it is narrowed before it can be dispatched.
export function launcherPick(launcher: { id: string; fingerprint: string; allowUnrestricted?: boolean } | null | undefined): CouncilLauncherPick | null {
  if (!launcher) return null;
  return { id: launcher.id, fingerprint: launcher.fingerprint, ...(launcher.allowUnrestricted === true ? { allowUnrestricted: true } : {}) };
}

export function fitLauncher(pick: CouncilLauncherPick | null | undefined, provider: string | undefined, discovery: CouncilLauncherDiscovery | undefined): CouncilLauncherPick | null {
  if (!pick || !provider) return null;
  const choice = discovery?.choices.find((c) => c.id === pick.id);
  return choice && choice.provider === provider ? launcherPick(pick) : null;
}
