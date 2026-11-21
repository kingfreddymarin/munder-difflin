import type { CouncilLauncherPick, ParamountTeamModels } from '@/data/paramount-api';
import { launcherPick } from '@/lib/launcher-fit';

/** The switch form starts from the live account, else the saved one, as a dispatchable pick without its label. */
export function switchLauncherSeed(account?: ParamountTeamModels['agents'][string]): CouncilLauncherPick | null {
  return launcherPick(account?.running ? account.running.launcher : account?.launcher);
}

export function currentSwitchModel(account?: ParamountTeamModels['agents'][string]) {
  return account?.running ? account.running.model : account?.model;
}

/** UI admission only; the core revalidates the account and sign-in before stopping anything. */
export function canSwitchAgent(input: { role: string; currentProvider: string; currentModel?: string; model?: string; currentAccount?: { accountSelection: 'default' | 'selected' | 'stale' | 'unavailable' | 'unknown'; launcher?: CouncilLauncherPick }; provider: string; launcher: CouncilLauncherPick | null; discovery?: ParamountTeamModels['launchers']; accounts?: ParamountTeamModels['accounts']; chosen: boolean }) {
  if (input.role === 'ephemeral' || input.role === 'watcher' || !input.chosen || !input.provider) return false;
  const managed = !!input.launcher && input.accounts?.some(account => account.source === 'managed' && account.available && account.provider === input.provider && account.id === input.launcher!.id && account.fingerprint === input.launcher!.fingerprint);
  if (!managed && ['claude', 'codex'].includes(input.provider) && input.discovery?.status !== 'ok') return false;
  if (input.launcher && !managed && !input.discovery?.choices.some(choice => choice.provider === input.provider && choice.id === input.launcher!.id && choice.fingerprint === input.launcher!.fingerprint)) return false;
  if (input.currentAccount?.accountSelection === 'unknown') return false;
  if (input.provider !== input.currentProvider) return true;
  if ((input.model ?? '') !== (input.currentModel ?? '')) return true;
  const current = input.currentAccount;
  if (!current || current.accountSelection === 'stale' || current.accountSelection === 'unavailable') return true;
  if (current.accountSelection === 'default') return input.launcher !== null;
  return !input.launcher || input.launcher.id !== current.launcher?.id || input.launcher.fingerprint !== current.launcher?.fingerprint;
}
