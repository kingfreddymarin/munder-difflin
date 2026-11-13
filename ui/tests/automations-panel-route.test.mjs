import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('More routes to the automation panel and Team reveals/focuses a customized-away panel', () => {
  const shell = read('../src/app/app-shell.tsx');
  const team = read('../src/pages/team.tsx');
  assert.match(shell, /item\('Automations',[\s\S]*?go\('team', \{ panel: 'automations' \}\)/);
  assert.match(team, /revealTeamPanel\(panels, requestedPanel\)/);
  assert.match(team, /panelToFocus[\s\S]*?scrollIntoView/);
  assert.match(team, /go\('team'\)/); // consume the one-shot focus route after handling it

  const helper = read('../src/pages/team-panel-route.ts');
  const js = ts.transpileModule(helper, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', js)(mod, mod.exports);
  const { revealTeamPanel } = mod.exports;
  assert.deepEqual(revealTeamPanel([], 'automations'), ['automations']);
  assert.deepEqual(revealTeamPanel(['agents'], 'automations'), ['agents', 'automations']);
  const existing = ['agents', 'automations'];
  assert.equal(revealTeamPanel(existing, 'automations'), existing);
  assert.equal(revealTeamPanel(existing, 'unsupported'), existing);
});
