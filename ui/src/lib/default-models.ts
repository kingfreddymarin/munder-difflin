// Default agent model rows for Settings: one picker per engine that takes a model.
// Claude's default is config.defaultModel; every other engine's is
// config.providerDefaultModels[engine] (the same split Munder's Add Agent form uses).
// No imports, so the test compiles this file on its own.

export interface DefaultModelCatalog {
  engines: Array<{ id: string; label: string; models: Array<{ id?: string; label: string }> }>;
}
export interface DefaultModelOption { id: string; label: string }
export interface DefaultModelRow {
  engine: string;
  label: string;
  /** The settings.update patch that saves `model` as this engine's default. */
  patch(model: string): Record<string, unknown>;
  /** The saved default, or '' for none (the CLI's own default). */
  value: string;
  /** The engine's full list; the saved one carries " · default". A saved id the
   *  list no longer offers is kept as a "(custom)" option so it is still shown. */
  options: DefaultModelOption[];
}

export function defaultModelRows(catalog: DefaultModelCatalog, settings: Record<string, unknown>): DefaultModelRow[] {
  const providerDefaults = settings.providerDefaultModels && typeof settings.providerDefaultModels === 'object'
    ? settings.providerDefaultModels as Record<string, unknown> : {};
  return catalog.engines.map((engine) => {
    const claude = engine.id === 'claude';
    const saved = claude ? settings.defaultModel : providerDefaults[engine.id];
    const value = typeof saved === 'string' ? saved : '';
    const listed = engine.models.filter((model): model is { id: string; label: string } => !!model.id);
    const options = listed.map((model) => ({ id: model.id, label: model.id === value ? `${model.label} · default` : model.label }));
    if (value && !listed.some((model) => model.id === value)) options.push({ id: value, label: `${value} (custom) · default` });
    return {
      engine: engine.id,
      label: engine.label,
      value,
      options,
      patch: (model: string) => (claude ? { defaultModel: model } : { providerDefaultModels: { [engine.id]: model } }),
    };
  });
}
