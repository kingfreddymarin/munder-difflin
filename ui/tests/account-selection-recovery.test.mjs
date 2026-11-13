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
  assert.match(source, /onSelectionChange\?\.\(\)/);
  assert.match(read('../src/features/team/agent-sheet.tsx'), /onSelectionChange=\{loadModels\}/);

  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const values = []; let cursor = 0; let modelReads = 0; let parentRefreshes = 0; const commands = [];
  const react = {
    createElement: (tag, props, ...children) => ({ tag, props: { ...props, children } }),
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], (value) => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; },
    useCallback(fn) { return fn; }, useEffect() {},
  };
  const stale = {
    engines: [], defaultModel: undefined,
    agents: { a: { engine: 'claude', installed: true, accountSelection: 'stale', launcher: { id: 'dcm', fingerprint: 'old', label: 'dcm' } } },
    launcherState: { agents: { a: { id: 'dcm', fingerprint: 'old' } } },
    launchers: { status: 'ok', choices: [] },
  };
  const fresh = { ...stale, agents: { a: { engine: 'claude', installed: true, accountSelection: 'default' } }, launcherState: { agents: {} } };
  const api = { models: async () => (++modelReads === 1 ? stale : fresh) };
  const dispatch = async (command) => { commands.push(command); return true; };
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, (id) => id === 'react' ? react
    : id === '@/lib/launcher-fit' ? { fitLauncher: (value) => value }
      : id === '@/data/store' ? { useDispatch: () => dispatch, useTeamApi: () => api }
        : id === '@/data/errors' ? { toBackendError: (error) => error }
          : id === '@/components/app/error-notice' ? { ErrorNotice: 'ErrorNotice' }
            : new Proxy({}, { get: (_target, key) => key }));
  const render = () => { cursor = 0; return mod.exports.LauncherSettings({ agentId: 'a', provider: 'claude', onSelectionChange: () => { parentRefreshes++; } }); };
  const nodes = (tree) => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.props?.children ?? []).flat(Infinity).flatMap(nodes)];
  const button = (tree, label) => nodes(tree).find((node) => node.tag === 'button' && node.props.children.flat(Infinity).includes(label));

  let tree = render();
  await button(tree, 'Refresh discovery').props.onClick();
  assert.equal(parentRefreshes, 1);
  tree = render();
  nodes(tree).find((node) => node.tag.name === 'LauncherSelect').props.onChange(null); // explicitly choose provider default
  tree = render();
  await button(tree, 'Save launcher').props.onClick();
  assert.equal(parentRefreshes, 2);
  assert.equal(commands.at(-1).type, 'launchers.configure');
});

test('sign-in state invalidates when saved account resolution changes', () => {
  assert.match(read('../src/components/app/engine-sign-in-actions.tsx'), /setFresh\(null\); \}, \[provider, state, accountSelection, accountId, accountFingerprint\]/);
});
