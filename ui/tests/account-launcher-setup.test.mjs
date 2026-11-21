import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const source = readFileSync(new URL('../src/app/setup-flow.tsx', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
// The real engine default (setup-defaults.ts), not a stub.
const defaultsJs = ts.transpileModule(readFileSync(new URL('../src/app/setup-defaults.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const setupDefaults = { exports: {} }; new Function('module', 'exports', 'require', defaultsJs)(setupDefaults, setupDefaults.exports, () => ({}));
function harness(setup) {
  const values = []; let cursor = 0, refreshed = 0; const commands = [];
  const react = { createElement: (tag, props, ...children) => ({ tag, props: { ...props, children } }), useState: (initial) => {
    const i = cursor++; if (!(i in values)) values[i] = initial;
    return [values[i], (value) => { values[i] = typeof value === 'function' ? value(values[i]) : value; }];
  } };
  const store = { useDispatch: () => async (command) => { commands.push(command); return true; }, useSnapshotRefresh: () => ({ refresh: () => refreshed++ }), useActionError: () => ({ error: null, clear() {} }), useFloor: (selector) => selector({ me: { yolo: { on: false } } }) };
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, (id) => id === 'react' ? react : id === '@/data/store' ? store : id.includes('launcher-select') ? { LauncherSelect: 'LauncherSelect' } : id === './setup-defaults' ? setupDefaults.exports : new Proxy({}, { get: (_target, key) => key }));
  const render = () => { cursor = 0; return mod.exports.SetupFlow({ setup }); };
  return { render, commands, refreshed: () => refreshed };
}
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.props?.children ?? []).flat(Infinity).flatMap(nodes)]; }
function button(tree, text) { return nodes(tree).find((n) => n.tag === 'Button' && n.props.children.flat(Infinity).includes(text)); }
const pick = (id) => ({ id, fingerprint: id.repeat(32).slice(0, 64).padEnd(64, 'a'), allowUnrestricted: true });
test('first run discovers/configures agent and temp defaults before the orchestrator and persists the selected provider', async () => {
  const setup = { suggestedHome: '/fixture', engines: ['claude', 'codex'].map((id) => ({ id, label: id, installed: true, orchestrator: true, models: [] })), launchers: { status: 'ok', choices: [] } };
  const h = harness(setup); let tree = h.render();
  button(tree, 'Continue').props.onClick(); tree = h.render();
  assert.ok(nodes(tree).some((n) => n.props['data-stage'] === 'launchers'));
  const selects = nodes(tree).filter((n) => n.tag === 'LauncherSelect');
  assert.equal(selects.length, 3); selects[0].props.onChange(pick('dcm')); selects[1].props.onChange(pick('dcxm')); selects[2].props.onChange(pick('dcxm'));
  // Rediscovery is an explicit main command; the provider re-reads the snapshot after it.
  button(tree, 'Refresh device discovery').props.onClick(); assert.deepEqual(h.commands, [{ type: 'launchers.refresh' }]);
  tree = h.render(); button(tree, 'Continue').props.onClick(); tree = h.render();
  assert.ok(nodes(tree).some((n) => n.props['data-stage'] === 'orchestrator'));
  assert.equal(nodes(tree).find((n) => n.tag === 'LauncherSelect').props.value.id, 'dcm');
  nodes(tree).find((n) => n.tag === 'input' && n.props.value === 'codex').props.onChange(); tree = h.render();
  assert.equal(nodes(tree).find((n) => n.tag === 'LauncherSelect').props.value.id, 'dcxm');
  button(tree, 'Finish setup').props.onClick(); await new Promise(setImmediate);
  assert.equal(h.commands.length, 2); const command = h.commands[1];
  assert.equal(command.type, 'setup.complete'); assert.equal(command.engine, 'codex'); assert.equal(command.launcher.id, 'dcxm');
  assert.deepEqual(command.launcherDefaults, { claude: pick('dcm'), codex: pick('dcxm') }); assert.equal(command.tempLauncher.id, 'dcxm');
});
test('first run retains the explicit failed discovery state and provider-default continuation', () => {
  const h = harness({ suggestedHome: '/fixture', engines: [], launchers: { status: 'failed', choices: [], message: 'Unsupported mapping; refresh' } });
  let tree = h.render(); button(tree, 'Continue').props.onClick(); tree = h.render();
  const selects = nodes(tree).filter((n) => n.tag === 'LauncherSelect');
  assert.ok(selects.every((n) => n.props.discovery.status === 'failed' && n.props.value === null));
  assert.ok(button(tree, 'Refresh device discovery')); assert.equal(h.commands.length, 0);
});
