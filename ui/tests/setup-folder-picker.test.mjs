import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Owner request 2026-11-12: a Choose folder button on the setup screen's Floor folder. It opens the
// native folder dialog (main's dialog:chooseFolder), fills the field with the absolute path, keeps
// manual typing, and Cancel leaves the field unchanged. The chosen folder still goes through the
// floor-lock check at Finish; a floor another app holds shows the refusal screen.
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const compile = (rel, jsx = false) => ts.transpileModule(readFileSync(new URL(rel, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, ...(jsx ? { jsx: ts.JsxEmit.React } : {}) } }).outputText;
const load = (js, req) => { const mod = { exports: {} }; new Function('module', 'exports', 'require', js)(mod, mod.exports, req); return mod.exports; };
const folderPick = load(compile('../src/app/folder-pick.ts'), () => ({}));
const defaults = load(compile('../src/app/setup-defaults.ts'), () => ({}));
const flowJs = compile('../src/app/setup-flow.tsx', true);

function harness(initialSetup, { bridge, dispatchOk = true } = {}) {
  const values = []; let cursor = 0; const commands = []; let refreshes = 0;
  const state = { setup: initialSetup };
  const react = { createElement: (tag, props, ...children) => ({ tag, props: { ...props, children } }), useState: (initial) => {
    const i = cursor++; if (!(i in values)) values[i] = initial;
    return [values[i], (value) => { values[i] = typeof value === 'function' ? value(values[i]) : value; }];
  } };
  const store = { useDispatch: () => async (command) => { commands.push(command); return dispatchOk; }, useSnapshotRefresh: () => ({ refresh: () => refreshes++ }),
    useActionError: () => ({ error: null, clear() {} }), useFloor: (selector) => selector({ me: { yolo: { on: false } } }) };
  const mod = load(flowJs, (id) => id === 'react' ? react : id === '@/data/store' ? store : id === '@/data/bridge' ? { findBridge: () => bridge ?? null }
    : id === './folder-pick' ? folderPick : id === './setup-defaults' ? defaults : id === './floor-refused' ? { FloorRefused: 'FloorRefused' }
    : id.includes('launcher-select') ? { LauncherSelect: 'LauncherSelect' } : new Proxy({}, { get: (_t, key) => key }));
  const render = () => { cursor = 0; return mod.SetupFlow({ setup: state.setup }); };
  return { render, commands, state, refreshes: () => refreshes };
}
const nodes = (tree) => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.props?.children ?? []).flat(Infinity).flatMap(nodes)];
const button = (tree, text) => nodes(tree).find((n) => n.tag === 'Button' && n.props.children.flat(Infinity).includes(text));
const homeInput = (tree) => nodes(tree).find((n) => n.tag === 'Input' && n.props.id === 'setup-home');
const tick = () => new Promise(setImmediate);
const setup = (extra = {}) => ({ suggestedHome: '/Users/me/Paramount', engines: [{ id: 'claude', label: 'Claude Code', installed: true, orchestrator: true, models: [] }], launchers: { status: 'ok', choices: [] }, complete: false, harnessHome: null, ...extra });

test('Choose folder fills the field with the chosen absolute path', async () => {
  const calls = [];
  const h = harness(setup(), { bridge: { chooseFolder: async () => { calls.push(1); return { ok: true, path: '/Users/me/floors/acme' }; } } });
  let tree = h.render();
  button(tree, 'Choose folder…').props.onClick(); await tick();
  tree = h.render();
  assert.equal(calls.length, 1);
  assert.equal(homeInput(tree).props.value, '/Users/me/floors/acme');
});

test('Cancel leaves the field unchanged and shows no error', async () => {
  const h = harness(setup(), { bridge: { chooseFolder: async () => ({ ok: false, error: 'cancelled' }) } });
  let tree = h.render();
  homeInput(tree).props.onChange({ target: { value: '/Users/me/typed' } });
  tree = h.render();
  button(tree, 'Choose folder…').props.onClick(); await tick();
  tree = h.render();
  assert.equal(homeInput(tree).props.value, '/Users/me/typed');
  assert.ok(!nodes(tree).some((n) => n.tag === 'p' && String(n.props.className).includes('destructive')));
});

test('typing still works, and a dialog failure is shown without touching the field', async () => {
  const h = harness(setup(), { bridge: { chooseFolder: async () => ({ ok: false, error: 'no window' }) } });
  let tree = h.render();
  homeInput(tree).props.onChange({ target: { value: '/Volumes/work/floor' } });
  tree = h.render();
  assert.equal(homeInput(tree).props.value, '/Volumes/work/floor');
  button(tree, 'Choose folder…').props.onClick(); await tick();
  tree = h.render();
  assert.equal(homeInput(tree).props.value, '/Volumes/work/floor');
  assert.ok(nodes(tree).some((n) => n.tag === 'p' && n.props.children.flat(Infinity).includes('no window')));
});

test('the dialog result goes through the floor-lock check at Finish; a held floor shows the refusal screen', async () => {
  const chosen = '/Users/me/floors/held';
  const h = harness(setup(), { bridge: { chooseFolder: async () => ({ ok: true, path: chosen }) }, dispatchOk: false });
  let tree = h.render();
  button(tree, 'Choose folder…').props.onClick(); await tick();
  tree = h.render(); button(tree, 'Continue').props.onClick();
  tree = h.render(); button(tree, 'Continue').props.onClick();
  tree = h.render(); button(tree, 'Finish setup').props.onClick(); await tick();
  assert.equal(h.commands.at(-1).type, 'setup.complete');
  assert.equal(h.commands.at(-1).home, chosen, 'the chosen folder is what main lock-checks');
  // The refused claim is in the snapshot (main's floor gate): setup shows the refusal screen.
  h.state.setup = setup({ floorLock: { state: 'refused', refusal: { floor: chosen, owner: 'Munder Difflin 0.5.7', pid: 71506, since: '', userData: '/x' } } });
  tree = h.render();
  assert.equal(tree.tag, 'FloorRefused');
  assert.equal(tree.props.lock.refusal.owner, 'Munder Difflin 0.5.7');
  // Choose another floor goes back to the folder step, with the field kept for editing.
  tree.props.onChooseAnother();
  tree = h.render();
  assert.equal(nodes(tree).find((n) => n.props?.['data-stage'])?.props['data-stage'], 'workspace');
  assert.equal(homeInput(tree).props.value, chosen);
});

test('the folder helper: chosen, cancelled, unavailable, failed', async () => {
  assert.deepEqual(await folderPick.chooseFolder({ chooseFolder: async () => ({ ok: true, path: '/a' }) }), { kind: 'chosen', path: '/a' });
  assert.deepEqual(await folderPick.chooseFolder({ chooseFolder: async () => ({ ok: false, error: 'cancelled' }) }), { kind: 'cancelled' });
  assert.deepEqual(await folderPick.chooseFolder(null), { kind: 'unavailable' });
  assert.deepEqual(await folderPick.chooseFolder({}), { kind: 'unavailable' });
  assert.equal((await folderPick.chooseFolder({ chooseFolder: async () => { throw new Error('boom'); } })).kind, 'failed');
  assert.equal((await folderPick.chooseFolder({ chooseFolder: async () => ({ ok: true, path: 'relative' }) })).kind, 'failed');
});

test('no new backend: the preload exposes the existing dialog:chooseFolder', () => {
  const preload = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8');
  assert.match(preload, /chooseFolder: \(\): Promise<[^>]+>\s*=>\s*ipcRenderer\.invoke\('dialog:chooseFolder'\)/);
  const main = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\('dialog:chooseFolder'[\s\S]{0,300}properties: \['openDirectory', 'createDirectory'\]/);
});
