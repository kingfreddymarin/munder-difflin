// Model defaults that follow the configured catalog (matrix row 16). A model is
// used only when the catalog offers it for that engine at this app version;
// otherwise the engine's own default applies (no --model flag), so a stale or
// unknown default can never reach a command line.

/** Munder 0.5.7's shipped default for the orchestrator and every agent
 *  (its config DEFAULTS godModel and defaultModel, observed from the installed build). */
export const MUNDER_DEFAULT_MODEL = 'claude-opus-5-5';

/** `wanted` when the catalog offers it for `provider`, else undefined (engine default). */
export function supportedModel(provider: string, wanted: string | undefined, offered: (provider: string) => string[]): string | undefined {
  if (!wanted) return undefined;
  return offered(provider).includes(wanted) ? wanted : undefined;
}

/** First supported choice in priority order: per-agent pick, then the configured
 *  default for its role, then the engine default (undefined). */
export function resolveAgentModel(provider: string, choices: Array<string | undefined>, offered: (provider: string) => string[]): string | undefined {
  for (const wanted of choices) {
    const model = supportedModel(provider, wanted, offered);
    if (model) return model;
  }
  return undefined;
}

/** Model ids the catalog offers for `provider` at this app version. The first
 *  catalog that parses wins (the cached remote copy, then the baked one). */
export function offeredModelIds<C>(provider: string, catalogs: unknown[], appVersion: string, parse: (raw: unknown) => C | null,
  offered: (catalog: C, appVersion: string) => Array<{ id: string; models: Array<{ id?: string }> }>): string[] {
  for (const raw of catalogs) {
    const catalog = parse(raw);
    if (!catalog) continue;
    return (offered(catalog, appVersion).find((e) => e.id === provider)?.models ?? []).flatMap((m) => (m.id ? [m.id] : []));
  }
  return [];
}
