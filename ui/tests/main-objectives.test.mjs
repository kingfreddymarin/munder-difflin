import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// STD-4 (owner): Main Objectives can be entered and edited on Home, are saved by the core
// (home.objectives), and the reducer shows the saved list at once.
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const compile = (rel, jsx = false) => ts.transpileModule(readFileSync(new URL(rel, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, ...(jsx ? { jsx: ts.JsxEmit.React } : {}) } }).outputText;
const load = (js, req) => { const mod = { exports: {} }; new Function('module', 'exports', 'require', js)(mod, mod.exports, req); return mod.exports; };
const objectives = load(compile('../src/data/objectives.ts'), () => ({}));
const reducer = load(compile('../src/data/reducer.ts'), () => ({}));
const editorJs = compile('../src/features/home/objectives-editor.tsx', true);

function harness(initial, { dispatchOk = true } = {}) {
  const values = []; let cursor = 0; const commands = []; let done = 0;
  const react = { createElement: (tag, props, ...children) => ({ tag, props: { ...props, children } }), useState: (init) => {
    const i = cursor++; if (!(i in values)) values[i] = typeof init === 'function' ? init() : init;
    return [values[i], (v) => { values[i] = typeof v === 'function' ? v(values[i]) : v; }];
  } };
  const mod = load(editorJs, (id) => id === 'react' ? react : id === '@/data/store' ? { useDispatch: () => async (c) => { commands.push(c); return dispatchOk; } }
    : id === '@/data/objectives' ? objectives : new Proxy({}, { get: (_t, key) => key }));
  const agents = [{ id: 'jim', name: 'Jim' }];
  const render = () => { cursor = 0; return mod.ObjectivesEditor({ objectives: initial, agents, onDone: () => done++ }); };
  return { render, commands, done: () => done };
}
const nodes = (t) => !t || typeof t !== 'object' ? [] : [t, ...(t.props?.children ?? []).flat(Infinity).flatMap(nodes)];
const byId = (t, id) => nodes(t).find((n) => n.props?.id === id);
const button = (t, label) => nodes(t).find((n) => n.tag === 'Button' && n.props.children.flat(Infinity).includes(label));
const submit = async (t) => { nodes(t).find((n) => n.tag === 'form').props.onSubmit({ preventDefault() {} }); await new Promise(setImmediate); };

test('adding and filling an objective saves it through home.objectives', async () => {
  const h = harness([]);
  button(h.render(), 'Add objective').props.onClick();
  let tree = h.render();
  const id = nodes(tree).find((n) => n.tag === 'fieldset').props.key;
  byId(tree, `obj-title-${id}`).props.onChange({ target: { value: ' Ship the DMG ' } });
  tree = h.render();
  byId(tree, `obj-why-${id}`).props.onChange({ target: { value: 'testers need one link' } });
  byId(tree, `obj-owner-${id}`).props.onChange({ target: { value: 'jim' } });
  byId(tree, `obj-health-${id}`).props.onChange({ target: { value: 'at-risk' } });
  byId(tree, `obj-cards-${id}`).props.onBlur({ target: { value: 'NSC-30, NSC-35,, NSC-30' } });
  await submit(h.render());
  assert.deepEqual(h.commands, [{ type: 'home.objectives', objectives: [{ id, title: 'Ship the DMG', why: 'testers need one link', owner: 'jim', cardKeys: ['NSC-30', 'NSC-35'], health: 'at-risk' }] }]);
  assert.equal(h.done(), 1, 'the editor closes after the core accepts');
});

test('editing an existing objective keeps its id; Remove and blank titles drop rows', async () => {
  const h = harness([
    { id: 'o1', title: 'Old', why: 'w', owner: '', cardKeys: [], health: 'on-track', due: '2026-12-01' },
    { id: 'o2', title: 'Gone', why: '', owner: '', cardKeys: [], health: 'blocked' }]);
  let tree = h.render();
  byId(tree, 'obj-title-o1').props.onChange({ target: { value: 'Renamed' } });
  tree = h.render();
  nodes(tree).find((n) => n.tag === 'fieldset' && n.props.key === 'o2').props.children.flat(Infinity).flatMap(nodes).find((n) => n.tag === 'Button').props.onClick();
  button(h.render(), 'Add objective').props.onClick();
  await submit(h.render());
  assert.deepEqual(h.commands[0].objectives, [{ id: 'o1', title: 'Renamed', why: 'w', owner: '', cardKeys: [], health: 'on-track' }], 'UI-only due is not sent; blank new row dropped');
});

test('a refused save keeps the editor open with the draft', async () => {
  const h = harness([{ id: 'o1', title: 'Keep', why: '', owner: '', cardKeys: [], health: 'on-track' }], { dispatchOk: false });
  await submit(h.render());
  assert.equal(h.commands.length, 1);
  assert.equal(h.done(), 0);
  assert.equal(byId(h.render(), 'obj-title-o1').props.value, 'Keep');
});

test('the reducer shows the saved objectives at once', () => {
  const next = reducer.applyEvent({ objectives: [] }, { id: "e1", at: "", actor: "you", command: { type: 'home.objectives', objectives: [{ id: 'o1', title: 'A', why: '', owner: '', cardKeys: [], health: 'blocked' }] } });
  assert.deepEqual(next.objectives, [{ id: 'o1', title: 'A', why: '', owner: '', cardKeys: [], health: 'blocked' }]);
});

test('Home offers Set objectives / Edit and renders the editor in the tile', () => {
  const home = readFileSync(new URL('../src/pages/home.tsx', import.meta.url), 'utf8');
  assert.match(home, /onClick=\{\(\) => setEditingObjectives\(true\)\}>\{objectives\.length \? 'Edit' : 'Set objectives'\}/);
  assert.match(home, /editingObjectives \? <ObjectivesEditor objectives=\{objectives\} agents=\{agents\} onDone=\{\(\) => setEditingObjectives\(false\)\} \/>/);
});
