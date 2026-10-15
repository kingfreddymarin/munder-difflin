/** The file Health's "Export diagnostics" saves: the core's redacted bundle, pretty JSON, named by local time. */
export function diagnosticsFile(bundle: unknown, now = new Date()): { name: string; text: string } {
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return { name: `paramount-diagnostics-${stamp}.json`, text: `${JSON.stringify(bundle, null, 2)}\n` };
}
