import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('mock provider supplies the explicit provider-default account state', () => {
  assert.match(read('../src/data/mock-provider.ts'), /installed: true, accountSelection: 'default'/);
});

test('crashed chat opens the Overview tab that contains the launcher picker', () => {
  const chats = read('../src/pages/chats.tsx');
  const sheet = read('../src/features/team/agent-sheet.tsx');
  assert.match(chats, /onResolveAccount=\{\(\) => go\('team', \{ agent: focus\.id, tab: 'overview' \}\)\}/);
  assert.match(sheet, /TabsContent value="overview"[\s\S]*?LauncherSettings/);
});

test('account reselection notifies AgentSheet after refresh and save', async () => {
  const source = read('../src/features/team/launcher-select.tsx');
  assert.match(read('../src/features/team/agent-sheet.tsx'), /onSelectionChange=\{loadModels\}/);
  assert.match(source, /changed: \(\) => changed\.current\?\.\(\)/);
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, (id) => id === '@/data/errors' ? { toBackendError: e => e } : {});
  let parentRefreshes = 0;
  const commands = [];
  const controller = new mod.exports.LauncherSettingsController({
    models: async () => ({ launchers: { status: 'ok', choices: [] }, launcherState: { agents: {} } }),
    persisted: () => null,
    refresh: async () => { commands.push('launchers.refresh'); return true; },
    save: async value => { commands.push(['launchers.configure', value]); return true; },
    changed: () => parentRefreshes++,
  });
  controller.start();
  for (let i=0;i<4;i++) await Promise.resolve();
  await controller.refresh();
  controller.edit(null);
  await controller.save();
  assert.deepEqual(commands, ['launchers.refresh', ['launchers.configure', null]]);
  assert.equal(parentRefreshes, 2);
  controller.stop();
});
