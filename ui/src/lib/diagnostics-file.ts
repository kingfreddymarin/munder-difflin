/** The suggested file name for Export: `paramount-diagnostics-YYYYMMDD-HHMMSS.json`, local time. */
export function diagnosticsFileName(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `paramount-diagnostics-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}.json`;
}

/** The file Health's "Export diagnostics" saves: the core's redacted bundle, pretty JSON, named by local time.
 *  The core writes the same text (src/main/paramount.ts, `diagnostics.save`). */
export function diagnosticsFile(bundle: unknown, now = new Date()): { name: string; text: string } {
  return { name: diagnosticsFileName(now), text: `${JSON.stringify(bundle, null, 2)}\n` };
}

/** What Export reports. A canceled save dialog is "canceled", never "saved". */
export type DiagnosticsExport = { status: 'saved'; path: string } | { status: 'canceled' };

/** Asks the core to save the bundle under the suggested name and maps its answer to what Export shows. */
export async function exportDiagnostics(
  save: (name: string) => Promise<{ canceled: true } | { canceled: false; path: string }>, now = new Date(),
): Promise<DiagnosticsExport> {
  const saved = await save(diagnosticsFileName(now));
  return saved.canceled ? { status: 'canceled' } : { status: 'saved', path: saved.path };
}
