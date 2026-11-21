import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Team panel changes persist locally without dispatching a core command', () => {
  const team = read('../src/pages/team.tsx');
  assert.match(team, /setPanels\(persistTeamPanels\(next\)\)/);
  assert.doesNotMatch(team, /dispatch\(\{\s*type:\s*'layout\.panels'/);

  const helper = read('../src/pages/team-panel-layout.ts');
  const js = ts.transpileModule(helper, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', js)(mod, mod.exports);
  const panels = ['agents', 'automations'];
  const writes = [];
  assert.equal(mod.exports.persistTeamPanels(panels, { setItem: (...args) => writes.push(args) }), panels);
  assert.deepEqual(writes, [['paramount.team.panels.v2', '["agents","automations"]']]);
  assert.equal(mod.exports.persistTeamPanels(panels, { setItem: () => { throw new Error('storage unavailable'); } }), panels);
});
