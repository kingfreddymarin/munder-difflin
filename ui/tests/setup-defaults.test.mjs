import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Setup never preselects gemini (or any engine other than Claude Code or Codex) for the god.
// Before, the first installed engine in list order was preselected; on varium setup.complete
// carried engine "gemini" and Council restarted the floor's claude god on gemini.
const outputDir = mkdtempSync(join(tmpdir(), 'paramount-setup-defaults-test-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', 'src/app/setup-defaults.ts',
]);
const file = readdirSync(outputDir, { recursive: true }).find((name) => String(name).endsWith('setup-defaults.js'));
const setup = await import(pathToFileURL(join(outputDir, String(file))).href);
rmSync(outputDir, { recursive: true });

const engine = (id, installed = true, orchestrator = true) => ({ id, label: id, installed, orchestrator, models: [] });

test('Claude Code is preselected when installed, then Codex', () => {
  assert.equal(setup.defaultOrchestratorEngine([engine('claude'), engine('codex'), engine('gemini')]), 'claude');
  assert.equal(setup.defaultOrchestratorEngine([engine('claude', false), engine('codex'), engine('gemini')]), 'codex');
});

test('gemini or any other engine is never preselected: the owner picks it on purpose', () => {
  assert.equal(setup.defaultOrchestratorEngine([engine('claude', false), engine('codex', false), engine('grok'), engine('gemini')]), '');
  assert.equal(setup.defaultOrchestratorEngine([engine('gemini')]), '');
});

test('the setup screen uses that default, not the first installed engine', () => {
  const flow = readFileSync('src/app/setup-flow.tsx', 'utf8');
  assert.match(flow, /React\.useState\(defaultOrchestratorEngine\(setup\.engines\)\)/);
  assert.doesNotMatch(flow, /setup\.engines\.find\(\(e\) => e\.orchestrator && e\.installed\)/);
});

test('a failed orchestrator start is shown on every screen', () => {
  const banner = readFileSync('src/app/hook-socket-banner.tsx', 'utf8');
  assert.match(banner, /export function OrchestratorFailureBanner\(\)/);
  assert.match(banner, /useFloor\(\(s\) => s\.orchestratorFailure\)/);
  assert.match(readFileSync('src/app/app-shell.tsx', 'utf8'), /<OrchestratorFailureBanner \/>/);
  assert.match(readFileSync('src/data/electron-provider.ts', 'utf8'), /orchestratorFailure: orchestratorFailureOf\(native\.orchestratorFailure\)/);
});
