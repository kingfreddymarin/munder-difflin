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
const { diagnosticsFile } = await import(pathToFileURL(join(outputDir, String(file))).href);

test('diagnosticsFile names the export by local time and keeps the bundle as pretty JSON', () => {
  const bundle = { app: { version: '0.4.6' }, log: ['a', 'b'] };
  const { name, text } = diagnosticsFile(bundle, new Date(2026, 9, 15, 7, 5, 9));
  assert.equal(name, 'paramount-diagnostics-20261015-070509.json');
  assert.deepEqual(JSON.parse(text), bundle);
  assert.ok(text.endsWith('\n'));
});
