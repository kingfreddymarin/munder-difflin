import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// A core failure shown in the UI keeps the core's errorId, code and message (never "Unknown
// failure" with a fresh ui- id). Seen 2026-11-12 15:03Z: E-mwdogs0f-... became ui-mwdogs0k-....
const outputDir = mkdtempSync(join(tmpdir(), 'paramount-errors-test-'));
execFileSync('node_modules/.bin/tsc', ['--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', 'src/data/errors.ts']);
const file = readdirSync(outputDir, { recursive: true }).find((name) => String(name).endsWith('errors.js'));
const { toBackendError } = await import(pathToFileURL(join(outputDir, String(file))).href);
rmSync(outputDir, { recursive: true });

test('a core failure object keeps its errorId, code and message', () => {
  const e = toBackendError({ ok: false, errorId: 'E-mwdogs0f-029af145', code: 'UNCERTAIN_STATE', message: 'git: Not a git working tree' }, 'terminal.artifacts');
  assert.equal(e.errorId, 'E-mwdogs0f-029af145');
  assert.equal(e.code, 'UNCERTAIN_STATE');
  assert.equal(e.message, 'git: Not a git working tree');
  assert.equal(e.operation, 'terminal.artifacts');
});

test('Artifacts: a folder outside git shows an empty state; warnings keep the core errorId', () => {
  const side = readFileSync(new URL('../src/components/app/terminal/session-side.tsx', import.meta.url), 'utf8');
  assert.match(side, /load\.map\.notRepo && <p role="status"[^>]*>This folder is not a git repository, so there are no changed files to show\.<\/p>/);
  assert.match(side, /new BackendError\(\{ errorId: w\.errorId/);
});
