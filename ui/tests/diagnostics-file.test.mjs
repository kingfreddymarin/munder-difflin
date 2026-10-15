import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// diagnostics-file.ts has no imports, so it compiles to one self-contained module.
const outputDir = mkdtempSync(join(tmpdir(), 'paramount-diagnostics-file-test-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', 'src/lib/diagnostics-file.ts',
]);
const file = readdirSync(outputDir, { recursive: true }).find((name) => String(name).endsWith('diagnostics-file.js'));
const { diagnosticsFile, exportDiagnostics } = await import(pathToFileURL(join(outputDir, String(file))).href);

test('diagnosticsFile names the export by local time and keeps the bundle as pretty JSON', () => {
  const bundle = { app: { version: '0.4.6' }, log: ['a', 'b'] };
  const { name, text } = diagnosticsFile(bundle, new Date(2026, 9, 15, 7, 5, 9));
  assert.equal(name, 'paramount-diagnostics-20261015-070509.json');
  assert.deepEqual(JSON.parse(text), bundle);
  assert.ok(text.endsWith('\n'));
});

test('exportDiagnostics reports a canceled save dialog as canceled, not saved', async () => {
  const names = [];
  const result = await exportDiagnostics(async (name) => { names.push(name); return { canceled: true }; }, new Date(2026, 9, 15, 7, 5, 9));
  assert.deepEqual(result, { status: 'canceled' });
  assert.deepEqual(names, ['paramount-diagnostics-20261015-070509.json']);
});

test('exportDiagnostics reports the path the core wrote', async () => {
  const result = await exportDiagnostics(async () => ({ canceled: false, path: '/tmp/x/paramount-diagnostics.json' }));
  assert.deepEqual(result, { status: 'saved', path: '/tmp/x/paramount-diagnostics.json' });
});

test('exportDiagnostics passes a core failure through for the error notice', async () => {
  await assert.rejects(exportDiagnostics(async () => { throw new Error('disk full'); }), /disk full/);
});
