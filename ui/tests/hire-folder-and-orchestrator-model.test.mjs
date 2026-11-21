import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Owner requests 2026-11-12: (1) the hire sheet's Folder says an empty folder is the floor root and
// has a Choose folder button (the setup picker's dialog:chooseFolder); (2) Settings shows the
// orchestrator's model (a profile carried claude-opus-4-8) and lets the owner switch it.
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const load = (rel) => { const js = ts.transpileModule(readFileSync(new URL(rel, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} }; new Function('module', 'exports', 'require', js)(mod, mod.exports, () => ({})); return mod.exports; };
const { orchestratorModelRow } = load('../src/lib/default-models.ts');
const { chooseFolder } = load('../src/app/folder-pick.ts');

const engines = [{ id: 'claude', label: 'Claude Code', models: [{ id: 'claude-opus-4-8', label: 'Opus 4.8' }, { id: 'claude-opus-5-5', label: 'Opus 5.5' }] }, { id: 'codex', label: 'Codex', models: [{ id: 'gpt-x', label: 'GPT X' }] }];

test('Settings shows the saved orchestrator model and switching saves godModel', () => {
  const row = orchestratorModelRow({ engines, orchestratorProvider: 'claude', orchestratorId: 'god', orchestratorModel: 'claude-opus-4-8', agents: { god: { engine: 'claude' } } });
  assert.equal(row.value, 'claude-opus-4-8');
  assert.ok(row.options.some((o) => o.id === 'claude-opus-5-5'));
  assert.deepEqual(row.commands('claude-opus-5-5'), [{ type: 'settings.update', patch: { godModel: 'claude-opus-5-5' } }]);
});

test('a Team-card pick for the orchestrator is what it starts on; a switch updates both', () => {
  const row = orchestratorModelRow({ engines, orchestratorProvider: 'claude', orchestratorId: 'god', orchestratorModel: 'claude-opus-4-8', agents: { god: { engine: 'claude', model: 'claude-opus-5-5' } } });
  assert.equal(row.value, 'claude-opus-5-5');
  assert.deepEqual(row.commands('claude-opus-4-8'), [
    { type: 'settings.update', patch: { godModel: 'claude-opus-4-8' } },
    { type: 'agent.update', agentId: 'god', patch: { model: 'claude-opus-4-8' } }]);
});

test('a god recorded on another engine than the floor setting: only its own pick changes', () => {
  const row = orchestratorModelRow({ engines, orchestratorProvider: 'claude', orchestratorId: 'god', orchestratorModel: 'claude-opus-4-8', agents: { god: { engine: 'codex' } } });
  assert.equal(row.engine, 'codex');
  assert.equal(row.value, '');
  assert.deepEqual(row.commands('gpt-x'), [{ type: 'agent.update', agentId: 'god', patch: { model: 'gpt-x' } }]);
});

test('a saved model this build does not list is still shown', () => {
  const row = orchestratorModelRow({ engines, orchestratorProvider: 'claude', orchestratorModel: 'claude-opus-4-1' });
  assert.ok(row.options.some((o) => o.id === 'claude-opus-4-1' && /not in this build's list/.test(o.label)));
});

test('the hire sheet: floor-root placeholder and a Choose folder button using the same picker', async () => {
  const sheet = readFileSync(new URL('../src/features/team/hire-sheet.tsx', import.meta.url), 'utf8');
  assert.match(sheet, /placeholder=\{`Empty: floor root \(\$\{floorRoot \?\? 'not open in this app'\}\)`\}/);
  assert.match(sheet, /const r = await chooseFolder\(findBridge\(\)\);\s*if \(r\.kind === 'chosen'\) edit\(\{ cwd: r\.path \}\);/);
  assert.match(sheet, />Choose folder…<\/Button>/);
  // The picker's choose and cancel paths (cancel leaves the field: no edit, no message).
  assert.deepEqual(await chooseFolder({ chooseFolder: async () => ({ ok: true, path: '/Users/me/repo' }) }), { kind: 'chosen', path: '/Users/me/repo' });
  assert.deepEqual(await chooseFolder({ chooseFolder: async () => ({ ok: false, error: 'cancelled' }) }), { kind: 'cancelled' });
});

test('Settings renders the orchestrator model control; settings.update accepts godModel', () => {
  assert.match(readFileSync(new URL('../src/features/settings/core-settings.tsx', import.meta.url), 'utf8'), /id="core-orchestrator-model"/);
  assert.match(readFileSync(new URL('../../src/main/paramount.ts', import.meta.url), 'utf8'), /const textFields = \['defaultModel', 'godModel'\];/);
});
