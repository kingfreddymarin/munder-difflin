export interface SavePresetResult {
  canceled: boolean;
  path?: string;
  error?: string;
}

interface SavePresetDependencies {
  validate(raw: unknown): { ok: boolean; manifest?: unknown; errors: string[] };
  showSaveDialog(defaultName: string): Promise<{ canceled: boolean; filePath?: string }>;
  writeFile(path: string, content: string): Promise<void>;
}

/** Validate again at the process boundary, then use injected native-picker and file operations. */
export async function saveParamountHirePreset(raw: unknown, deps: SavePresetDependencies): Promise<SavePresetResult> {
  const validation = deps.validate(raw);
  if (!validation.ok || !validation.manifest) {
    return { canceled: false, error: validation.errors.join('; ') || 'Invalid agent preset.' };
  }
  const manifest = validation.manifest as Record<string, unknown>;
  const safeName = (typeof manifest.name === 'string' ? manifest.name : 'agent-preset')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent-preset';
  let picked: { canceled: boolean; filePath?: string };
  try {
    picked = await deps.showSaveDialog(`${safeName}.json`);
  } catch {
    return { canceled: false, error: 'Could not open the save dialog. Try again.' };
  }
  if (picked.canceled || !picked.filePath) return { canceled: true };
  try {
    await deps.writeFile(picked.filePath, `${JSON.stringify(validation.manifest, null, 2)}\n`);
    return { canceled: false, path: picked.filePath };
  } catch {
    return { canceled: false, error: 'Could not save the agent preset. Choose another file name or location and try again.' };
  }
}
