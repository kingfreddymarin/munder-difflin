import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Owner run of ceeb4aaf (failures/2026-11-12T2126-ceeb4aaf-hire-orchestrator): the floor's god is
// registered on claude, setup said codex, and the saved orchestrator launcher is dcxm (Codex). The hire
// sheet preselected dcxm and Codex models for the orchestrator; every start and hire failed.
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const load = (rel) => { const js = ts.transpileModule(readFileSync(new URL(rel, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} }; new Function('module', 'exports', 'require', js)(mod, mod.exports, () => ({})); return mod.exports; };
const { fitLauncher } = load('../src/lib/launcher-fit.ts');
const { orchestratorModelRow } = load('../src/lib/default-models.ts');

const discovery = { status: 'ok', choices: [
  { id: 'dc', provider: 'claude', label: 'dc', fingerprint: 'a'.repeat(64), unrestricted: false },
  { id: 'dcxm', provider: 'codex', label: 'dcxm', fingerprint: 'b'.repeat(64), unrestricted: false }] };
const dcxm = { id: 'dcxm', fingerprint: 'b'.repeat(64) };
const dc = { id: 'dc', fingerprint: 'a'.repeat(64) };

test('a saved launcher is preselected only for the engine it runs', () => {
  assert.equal(fitLauncher(dcxm, 'claude', discovery), null, 'the Codex launcher is not offered for a Claude orchestrator');
  assert.deepEqual(fitLauncher(dcxm, 'codex', discovery), dcxm);
  assert.deepEqual(fitLauncher(dc, 'claude', discovery), dc);
  assert.equal(fitLauncher(dc, 'claude', undefined), null, 'not discovered: Provider default');
  assert.equal(fitLauncher(null, 'claude', discovery), null);
});

test('the hire sheet and Settings take the orchestrator engine from team.models and fit the launcher to it', () => {
  const sheet = readFileSync(new URL('../src/features/team/hire-sheet.tsx', import.meta.url), 'utf8');
  assert.match(sheet, /const provider = orchestrator \? next\.orchestratorProvider \?\? 'claude'/);
  assert.match(sheet, /setLauncher\(fitLauncher\(orchestrator \? next\.launcherState\?\.orchestrator : next\.launcherState\?\.defaults\?\.\[provider\], provider, next\.launchers\)\);/);
  assert.match(sheet, /plan\.notes\?\.map/, 'fallback notes are shown in the review');
  assert.match(sheet, /orchestrator-launcher-note/);
  const settings = readFileSync(new URL('../src/features/team/launcher-select.tsx', import.meta.url), 'utf8');
  assert.match(settings, /fitLauncher\(m\.launcherState\?\.orchestrator, m\.orchestratorProvider, m\.launchers\)/);
  assert.match(settings, /settings-orchestrator-launcher-note/);
});

test('Settings model row: with a claude god and setup on codex, switching changes only the god pick', () => {
  const engines = [{ id: 'claude', label: 'Claude Code', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }] }, { id: 'codex', label: 'Codex', models: [{ id: 'gpt-x', label: 'GPT X' }] }];
  const row = orchestratorModelRow({ engines, orchestratorProvider: 'claude', orchestratorConfiguredProvider: 'codex', orchestratorId: 'god', agents: { god: { engine: 'claude' } } });
  assert.equal(row.engine, 'claude');
  assert.deepEqual(row.commands('claude-opus-5-5'), [{ type: 'agent.update', agentId: 'god', patch: { model: 'claude-opus-5-5' } }], 'no Claude model written into the Codex setting');
});
