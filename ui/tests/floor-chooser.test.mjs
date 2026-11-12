import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Owner requests 2026-11-12 (NSC-193, Munder 0.5.7 parity): the floor picker on every launch (recent
// floors with their state, the last one preselected, Enter opens it, Choose folder… via
// dialog:chooseFolder); a held floor shows the refusal screen; New Floor… shows the same picker over
// a running floor and starts the choice as its own process; Settings has a Floor location row.
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const compile = (rel, jsx = false) => ts.transpileModule(readFileSync(new URL(rel, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, ...(jsx ? { jsx: ts.JsxEmit.React } : {}) } }).outputText;
const load = (js, req) => { const mod = { exports: {} }; new Function('module', 'exports', 'require', js)(mod, mod.exports, req); return mod.exports; };
const folderPick = load(compile('../src/app/folder-pick.ts'), () => ({}));

function hooks() {
  const values = []; let cursor = 0;
  const react = { createElement: (tag, props, ...children) => ({ tag, props: { ...props, children } }), useState: (initial) => {
    const i = cursor++; if (!(i in values)) values[i] = initial;
    return [values[i], (value) => { values[i] = typeof value === 'function' ? value(values[i]) : value; }];
  } };
  return { react, reset: () => { cursor = 0; } };
}
function chooserHarness(choice, { bridge, dispatchOk = true } = {}) {
  const h = hooks(); const commands = [];
  const state = { choice, lock: { state: 'none' } };
  const store = { useDispatch: () => async (command) => { commands.push(command); return dispatchOk; }, useSnapshotRefresh: () => ({ refresh() {} }), useActionError: () => ({ error: null, clear() {} }) };
  const mod = load(compile('../src/app/floor-chooser.tsx', true), (id) => id === 'react' ? h.react : id === '@/data/store' ? store
    : id === '@/data/bridge' ? { findBridge: () => bridge ?? null } : id === './folder-pick' ? folderPick : id === './floor-refused' ? { FloorRefused: 'FloorRefused' }
    : new Proxy({}, { get: (_t, key) => key }));
  return { mod, commands, state, render: () => { h.reset(); return mod.FloorChooser({ choice: state.choice, lock: state.lock }); } };
}
const nodes = (tree) => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.props?.children ?? []).flat(Infinity).flatMap(nodes)];
const text = (n) => n.props.children.flat(Infinity).filter((c) => typeof c === 'string').join('');
const button = (tree, label) => nodes(tree).find((n) => n.tag === 'Button' && text(n).includes(label));
const selectedRow = (tree) => nodes(tree).find((n) => n.props?.role === 'option' && n.props['aria-selected'])?.props['data-path'];
const listbox = (tree) => nodes(tree).find((n) => n.props?.role === 'listbox');
const key = (k) => ({ key: k, preventDefault() {} });
const tick = () => new Promise(setImmediate);
const choice = { pending: true, newFloor: false, last: '/f/b', recents: [
  { path: '/f/b', exists: true, state: 'free' }, { path: '/f/a', exists: true, state: 'free' },
  { path: '/f/held', exists: true, state: 'held', heldBy: 'Munder Difflin 0.5.7 (pid 71506)' },
  { path: '/f/gone', exists: false, state: 'missing' }, { path: '/u/Library/Application Support/Paramount', exists: true, state: 'data-folder' }] };
const rowState = (tree, p) => { const row = nodes(tree).find((n) => n.props?.['data-path'] === p); const label = nodes(row).find((n) => n.props?.['data-testid'] === 'floor-state'); return { disabled: row.props['aria-disabled'], label: label ? text(label) : '' }; };

test('launch: recent floors with their state; the last one preselected; Enter opens it here', async () => {
  const h = chooserHarness(choice);
  const tree = h.render();
  assert.equal(nodes(tree).find((n) => n.props?.['data-testid'] === 'floor-chooser').props['data-mode'], 'launch');
  assert.equal(selectedRow(tree), '/f/b');
  assert.deepEqual(rowState(tree, '/f/held'), { disabled: false, label: 'open in Munder Difflin 0.5.7 (pid 71506)' });
  assert.deepEqual(rowState(tree, '/f/gone'), { disabled: true, label: 'folder not found' });
  assert.deepEqual(rowState(tree, '/u/Library/Application Support/Paramount'), { disabled: true, label: "the app's own data folder; not a floor" });
  assert.equal(listbox(tree).props.autoFocus, true, 'Enter works without clicking first');
  listbox(tree).props.onKeyDown(key('Enter')); await tick();
  assert.deepEqual(h.commands, [{ type: 'floor.open', home: '/f/b' }]);
});

test('arrow keys move between floors that can be opened; missing and data-folder rows are skipped', async () => {
  const h = chooserHarness(choice);
  let tree = h.render();
  for (const want of ['/f/a', '/f/held', '/f/held']) { listbox(tree).props.onKeyDown(key('ArrowDown')); tree = h.render(); assert.equal(selectedRow(tree), want); }
  nodes(tree).find((n) => n.props?.['data-path'] === '/f/gone').props.onClick(); tree = h.render();
  assert.equal(selectedRow(tree), '/f/held');
  listbox(tree).props.onKeyDown(key('ArrowUp')); tree = h.render();
  button(tree, 'Open').props.onClick(); await tick();
  assert.deepEqual(h.commands, [{ type: 'floor.open', home: '/f/a' }]);
});

test('the preselection skips a last floor that cannot be opened', () => {
  const h = chooserHarness(choice);
  assert.equal(h.mod.initialFloor({ ...choice, last: '/f/gone' }), '/f/b');
  assert.equal(h.mod.initialFloor({ ...choice, last: '/u/Library/Application Support/Paramount' }), '/f/b');
  assert.equal(h.mod.initialFloor({ pending: true, newFloor: false, last: null, recents: [] }), null);
});

test('Choose folder… opens the chosen folder; Cancel does nothing', async () => {
  let h = chooserHarness(choice, { bridge: { chooseFolder: async () => ({ ok: true, path: '/Users/me/floors/new' }) } });
  button(h.render(), 'Choose folder…').props.onClick(); await tick(); await tick();
  assert.deepEqual(h.commands, [{ type: 'floor.open', home: '/Users/me/floors/new' }]);
  h = chooserHarness(choice, { bridge: { chooseFolder: async () => ({ ok: false, error: 'cancelled' }) } });
  button(h.render(), 'Choose folder…').props.onClick(); await tick();
  assert.deepEqual(h.commands, []);
  assert.equal(selectedRow(h.render()), '/f/b');
});

test('launch on a floor another app holds shows the refusal screen; Choose another goes back to the list', async () => {
  const h = chooserHarness({ ...choice, last: '/f/held' }, { dispatchOk: false });
  listbox(h.render()).props.onKeyDown(key('Enter')); await tick();
  assert.deepEqual(h.commands, [{ type: 'floor.open', home: '/f/held' }]);
  h.state.lock = { state: 'refused', refusal: { floor: '/f/held', owner: 'Munder Difflin 0.5.7', pid: 71506, since: '', userData: '/x' } };
  let tree = h.render();
  assert.equal(tree.tag, 'FloorRefused');
  await tree.props.onRetry();
  assert.deepEqual(h.commands.at(-1), { type: 'floor.open', home: '/f/held' }, 'Check again reopens the same floor');
  tree = h.render(); tree.props.onChooseAnother(); tree = h.render();
  assert.ok(nodes(tree).some((n) => n.props?.['data-testid'] === 'floor-chooser'));
});

test('New Floor…: the same list over the running floor; this floor and held floors cannot be chosen; Cancel and Escape close it', async () => {
  const nf = { pending: false, newFloor: true, last: '/f/a', recents: [{ path: '/f/a', exists: true, state: 'current' }, { path: '/f/b', exists: true, state: 'free' }, { path: '/f/held', exists: true, state: 'held', heldBy: 'Munder Difflin 0.5.7 (pid 71506)' }] };
  const h = chooserHarness(nf, { dispatchOk: false });
  let tree = h.render();
  const box = nodes(tree).find((n) => n.props?.['data-testid'] === 'floor-chooser');
  assert.equal(box.props['data-mode'], 'new-floor');
  assert.match(String(tree.props.className), /fixed inset-0/, 'an overlay; the floor underneath keeps running');
  assert.equal(selectedRow(tree), '/f/b', 'the current floor is not preselected');
  assert.deepEqual(rowState(tree, '/f/a'), { disabled: true, label: 'open in this window' });
  assert.equal(rowState(tree, '/f/held').disabled, true);
  button(tree, 'Open in a new window').props.onClick(); await tick();
  assert.deepEqual(h.commands, [{ type: 'floor.open', home: '/f/b' }]);
  tree = h.render();
  assert.notEqual(tree.tag, 'FloorRefused', 'a refused New Floor shows its error in the picker');
  button(tree, 'Cancel').props.onClick();
  listbox(tree).props.onKeyDown(key('Escape'));
  assert.deepEqual(h.commands.slice(1), [{ type: 'floor.picker', open: false }, { type: 'floor.picker', open: false }]);
});

test('the app shows the launch picker before anything else, and New Floor… as an overlay on the app', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const chooser = app.indexOf('if (setup?.choice?.pending) return <FloorChooser');
  assert.ok(chooser > app.indexOf('return <SetupFlow') && chooser < app.indexOf("setup?.floorLock?.state === 'refused'"));
  assert.ok(app.indexOf('{setup?.choice?.newFloor && <FloorChooser') > app.indexOf('<Routes />'));
  const startup = readFileSync(new URL('../src/app/use-orchestrator-startup.ts', import.meta.url), 'utf8');
  assert.match(startup, /setup\.floorLock && setup\.floorLock\.state !== 'open'\) return;/, 'no orchestrator before a floor is open');
});

function locationHarness(bridge, floor = '/f/a') {
  const h = hooks(); const commands = [];
  const snap = { floorSetup: { floorLock: floor ? { state: 'open', floor } : { state: 'none' } } };
  const store = { useDispatch: () => async (c) => { commands.push(c); return true; }, useFloor: (sel) => sel(snap) };
  const mod = load(compile('../src/features/settings/floor-location.tsx', true), (id) => id === 'react' ? h.react : id === '@/data/store' ? store
    : id === '@/data/bridge' ? { findBridge: () => bridge } : id === '@/app/folder-pick' ? folderPick : new Proxy({}, { get: (_t, k) => k }));
  return { commands, render: () => { h.reset(); return mod.FloorLocationTile(); } };
}

test('Settings Floor location: shows the path; Change… picks a folder, asks move or new, then calls config:changeHome', async () => {
  const calls = [];
  const bridge = { chooseFolder: async () => ({ ok: true, path: '/f/new' }), changeHome: async (p, mode) => { calls.push(['changeHome', p, mode]); return { ok: false, error: 'stand-in: not relaunched' }; },
    revealPath: async (p) => { calls.push(['reveal', p]); return { ok: true }; } };
  const h = locationHarness(bridge);
  let tree = h.render();
  assert.equal(text(nodes(tree).find((n) => n.props?.['data-testid'] === 'floor-location-path')), '/f/a');
  button(tree, 'Change…').props.onClick(); await tick();
  assert.deepEqual(calls, [], 'nothing changes before the choice');
  tree = h.render();
  assert.ok(nodes(tree).some((n) => n.props?.['data-testid'] === 'floor-location-confirm'));
  button(tree, 'Move this floor there').props.onClick(); await tick();
  assert.deepEqual(calls, [['changeHome', '/f/new', 'move']]);
  tree = h.render();
  assert.ok(nodes(tree).some((n) => n.props?.role === 'alert' && text(n).includes('stand-in: not relaunched')), 'a refusal from main is shown');
  button(tree, 'Start a new floor there').props.onClick(); await tick();
  assert.deepEqual(calls.at(-1), ['changeHome', '/f/new', 'fresh']);
  button(h.render(), 'Reveal in Finder').props.onClick(); await tick();
  assert.deepEqual(calls.at(-1), ['reveal', '/f/a']);
  button(h.render(), 'Open another floor…').props.onClick();
  assert.deepEqual(h.commands, [{ type: 'floor.picker', open: true }]);
  button(h.render(), 'Switch floor…').props.onClick();
  assert.deepEqual(h.commands, [{ type: 'floor.picker', open: true }], 'Switch asks first');
  assert.ok(nodes(h.render()).some((n) => n.props?.['data-testid'] === 'switch-floor-confirm'));
  button(h.render(), 'Stop agents and switch').props.onClick(); await tick();
  assert.deepEqual(h.commands.at(-1), { type: 'floor.switch' });
  const core = readFileSync(new URL('../src/features/settings/core-settings.tsx', import.meta.url), 'utf8');
  assert.match(core, /<FloorLocationTile \/>/);
});

test("Settings Floor location: cancelling the dialog changes nothing; the data folder refusal from main is shown", async () => {
  let calls = 0;
  let h = locationHarness({ chooseFolder: async () => ({ ok: false, error: 'cancelled' }), changeHome: async () => { calls++; return { ok: true }; } });
  button(h.render(), 'Change…').props.onClick(); await tick();
  assert.equal(calls, 0);
  assert.ok(!nodes(h.render()).some((n) => n.props?.['data-testid'] === 'floor-location-confirm'));
  h = locationHarness({ chooseFolder: async () => ({ ok: true, path: '/u/Library/Application Support/Paramount' }), changeHome: async () => ({ ok: false, error: "A floor cannot use this floor's own data folder." }) });
  button(h.render(), 'Change…').props.onClick(); await tick();
  button(h.render(), 'Move this floor there').props.onClick(); await tick();
  assert.ok(nodes(h.render()).some((n) => n.props?.role === 'alert' && text(n) === "A floor cannot use this floor's own data folder."));
  const main = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(main, /const ownData = dataFolderRefusal\(newHome, appDataDirs\(\)\);\s*if \(ownData\) return \{ ok: false, error: ownData \};/, 'config:changeHome refuses it');
});
