import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// STD-4 / NSC-232: Main Objectives are entered and edited on Home; each objective links open Board
// cards via a dropdown and auto-links newly created cards; the reducer shows the saved list at once.
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const compile = (rel, jsx = false) => ts.transpileModule(
  readFileSync(new URL(rel, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022, ...(jsx ? { jsx: ts.JsxEmit.React } : {}) } }
).outputText;
const load = (js, req) => { const mod = { exports: {} }; new Function('module', 'exports', 'require', js)(mod, mod.exports, req); return mod.exports; };
const objectives = load(compile('../src/data/objectives.ts'), () => ({}));
const reducer = load(compile('../src/data/reducer.ts'), () => ({}));
const editorJs = compile('../src/features/home/objectives-editor.tsx', true);

// ── Helpers shared by both harnesses ─────────────────────────────────────────
const nodes = (t) => !t || typeof t !== 'object' ? [] : [t, ...(t.props?.children ?? []).flat(Infinity).flatMap(nodes)];
const byId = (t, id) => nodes(t).find((n) => n.props?.id === id);
const byTestId = (t, id) => nodes(t).find((n) => n.props?.['data-testid'] === id);
const button = (t, label) => nodes(t).find((n) => n.tag === 'Button' && n.props.children.flat(Infinity).includes(label));
const submit = async (t) => { nodes(t).find((n) => n.tag === 'form').props.onSubmit({ preventDefault() {} }); await new Promise(setImmediate); };

// ── ObjectivesEditor harness ──────────────────────────────────────────────────
// Uses the original cursor-indexed hook tracking; CardPicker is treated as a black-box element.
function makeEditorHarness(initial, { dispatchOk = true, snapshotCards = [] } = {}) {
  const values = []; let cursor = 0; const commands = []; let done = 0;
  let snapshot = { cards: snapshotCards };
  const react = {
    createElement: (tag, props, ...children) => ({ tag, props: { ...props, children } }),
    useState: (init) => {
      const i = cursor++; if (!(i in values)) values[i] = typeof init === 'function' ? init() : init;
      return [values[i], (v) => { values[i] = typeof v === 'function' ? v(values[i]) : v; }];
    },
    useRef: (init) => ({ current: typeof init === 'function' ? init() : init }),
  };
  const req = (id) => {
    if (id === 'react') return react;
    if (id === '@/data/store') return {
      useDispatch: () => async (c) => { commands.push(c); return dispatchOk; },
      useGetSnapshot: () => () => snapshot,
    };
    if (id === '@/data/objectives') return objectives;
    if (id === '@/features/team/new-card-dialog') return { NewCardDialog: (props) => ({ tag: 'NewCardDialog', props }) };
    return new Proxy({}, { get: (_t, key) => key });
  };
  const mod = load(editorJs, req);
  const agents = [{ id: 'jim', name: 'Jim' }];
  const openCards = [
    { key: 'NSC-10', title: 'Fix the login flow', status: 'todo' },
    { key: 'NSC-20', title: 'Ship the DMG', status: 'doing' },
    { key: 'NSC-30', title: 'Write docs', status: 'backlog' },
  ];
  const render = () => { cursor = 0; return mod.ObjectivesEditor({ objectives: initial, agents, openCards, onDone: () => done++ }); };
  return { render, nodes, byId, byTestId, button, submit, commands, done: () => done, openCards,
    updateSnapshot: (cards) => { snapshot = { cards }; } };
}

// ── CardPicker harness ────────────────────────────────────────────────────────
// Tests CardPicker directly. Hooks:
//   useGetSnapshot → no cursor (custom hook wrapping store)
//   useRef (1 call, for beforeCreateRef — MUST persist across renders)
//   useState (1 call, for `creating`)
function makePickerHarness(initialCardKeys = [], openCards = [], snapshotCards = []) {
  const values = []; let cursor = 0;
  // Refs persist across renders: same object by position, .current changes survive re-renders.
  const refMap = new Map(); let refCursor = 0;
  let snapshot = { cards: snapshotCards };
  const react = {
    createElement: (tag, props, ...children) => ({ tag, props: { ...props, children } }),
    useState: (init) => {
      const i = cursor++; if (!(i in values)) values[i] = typeof init === 'function' ? init() : init;
      return [values[i], (v) => { values[i] = typeof v === 'function' ? v(values[i]) : v; }];
    },
    useRef: (init) => {
      const i = refCursor++;
      if (!refMap.has(i)) refMap.set(i, { current: typeof init === 'function' ? init() : init });
      return refMap.get(i); // same object on every render
    },
  };
  const req = (id) => {
    if (id === 'react') return react;
    if (id === '@/data/store') return {
      useDispatch: () => async () => true,
      useGetSnapshot: () => () => snapshot,
    };
    if (id === '@/data/objectives') return objectives;
    if (id === '@/features/team/new-card-dialog') return { NewCardDialog: (props) => ({ tag: 'NewCardDialog', props }) };
    return new Proxy({}, { get: (_t, key) => key });
  };
  const mod = load(editorJs, req);

  let cardKeys = [...initialCardKeys];
  const edits = [];
  const onEdit = (patch) => { if (patch.cardKeys) cardKeys = patch.cardKeys; edits.push(patch); };

  const render = () => {
    cursor = 0; refCursor = 0; // reset positions only; values/refMap persist
    return mod.CardPicker({ objectiveId: 'o1', cardKeys, openCards, onEdit });
  };
  // Find the NewCardDialog element: identified by having open+onClose props on a function tag.
  const findDialog = (tree) => nodes(tree).find((n) => typeof n.tag === 'function' && 'open' in (n.props ?? {}) && 'onClose' in (n.props ?? {}));
  return { render, nodes, byId, byTestId, button, edits,
    getCardKeys: () => cardKeys, findDialog,
    updateSnapshot: (cards) => { snapshot = { cards }; } };
}

// ── ObjectivesEditor tests ────────────────────────────────────────────────────

test('adding and filling an objective saves it through home.objectives', async () => {
  const h = makeEditorHarness([]);
  button(h.render(), 'Add objective').props.onClick();
  let tree = h.render();
  const id = nodes(tree).find((n) => n.tag === 'fieldset').props.key;
  byId(tree, `obj-title-${id}`).props.onChange({ target: { value: ' Ship the DMG ' } });
  tree = h.render();
  byId(tree, `obj-why-${id}`).props.onChange({ target: { value: 'testers need one link' } });
  byId(tree, `obj-owner-${id}`).props.onChange({ target: { value: 'jim' } });
  byId(tree, `obj-health-${id}`).props.onChange({ target: { value: 'at-risk' } });
  // Set cardKeys via the CardPicker's onEdit prop
  const picker = nodes(tree).find((n) => typeof n.tag === 'function' && n.props.objectiveId === id);
  picker.props.onEdit({ cardKeys: ['NSC-30', 'NSC-35'] });
  await submit(h.render());
  assert.deepEqual(h.commands, [{ type: 'home.objectives', objectives: [{ id, title: 'Ship the DMG', why: 'testers need one link', owner: 'jim', cardKeys: ['NSC-30', 'NSC-35'], health: 'at-risk' }] }]);
  assert.equal(h.done(), 1, 'the editor closes after the core accepts');
});

test('editing an existing objective keeps its id; Remove and blank titles drop rows', async () => {
  const h = makeEditorHarness([
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
  const h = makeEditorHarness([{ id: 'o1', title: 'Keep', why: '', owner: '', cardKeys: [], health: 'on-track' }], { dispatchOk: false });
  await submit(h.render());
  assert.equal(h.commands.length, 1);
  assert.equal(h.done(), 0);
  assert.equal(byId(h.render(), 'obj-title-o1').props.value, 'Keep');
});

test('the reducer shows the saved objectives at once', () => {
  const next = reducer.applyEvent({ objectives: [] }, { id: 'e1', at: '', actor: 'you', command: { type: 'home.objectives', objectives: [{ id: 'o1', title: 'A', why: '', owner: '', cardKeys: [], health: 'blocked' }] } });
  assert.deepEqual(next.objectives, [{ id: 'o1', title: 'A', why: '', owner: '', cardKeys: [], health: 'blocked' }]);
});

test('Home offers Set objectives / Edit and renders the editor with openCards in the tile', () => {
  const home = readFileSync(new URL('../src/pages/home.tsx', import.meta.url), 'utf8');
  assert.match(home, /onClick=\{\(\) => setEditingObjectives\(true\)\}>\{objectives\.length \? 'Edit' : 'Set objectives'\}/);
  assert.match(home, /ObjectivesEditor objectives=\{objectives\} agents=\{agents\} openCards=\{cards\.filter/);
  assert.match(home, /c\.status !== 'done'/);
});

test('CardPicker element is rendered inside each objective fieldset with correct props', () => {
  const h = makeEditorHarness([{ id: 'o1', title: 'T', why: '', owner: '', cardKeys: ['NSC-10'], health: 'on-track' }]);
  const tree = h.render();
  const picker = nodes(tree).find((n) => typeof n.tag === 'function' && n.props.objectiveId === 'o1');
  assert.ok(picker, 'CardPicker element in tree');
  assert.deepEqual(picker.props.cardKeys, ['NSC-10']);
  assert.deepEqual(picker.props.openCards, h.openCards);
  assert.ok(typeof picker.props.onEdit === 'function');
});

// ── CardPicker tests (NSC-232) ────────────────────────────────────────────────

const OPEN_CARDS = [
  { key: 'NSC-10', title: 'Fix the login flow', status: 'todo' },
  { key: 'NSC-20', title: 'Ship the DMG', status: 'doing' },
  { key: 'NSC-30', title: 'Write docs', status: 'backlog' },
];

test('selecting a card from the dropdown adds its key to cardKeys', () => {
  const h = makePickerHarness([], OPEN_CARDS);
  const tree = h.render();
  const sel = byTestId(tree, 'obj-card-select-o1');
  assert.ok(sel, 'dropdown rendered when no cards selected');
  sel.props.onChange({ target: { value: 'NSC-10' } });
  assert.deepEqual(h.getCardKeys(), ['NSC-10']);
});

test('clicking × on a chip removes the card key', () => {
  const h = makePickerHarness(['NSC-20', 'NSC-30'], OPEN_CARDS);
  const tree = h.render();
  const rm = nodes(tree).find((n) => n.props?.['aria-label'] === 'Remove NSC-20');
  assert.ok(rm, 'remove button for NSC-20 chip');
  rm.props.onClick();
  assert.deepEqual(h.getCardKeys(), ['NSC-30']);
});

test('already-selected cards are excluded from the dropdown options', () => {
  const h = makePickerHarness(['NSC-10', 'NSC-20'], OPEN_CARDS);
  const tree = h.render();
  const opts = nodes(tree).filter((n) => n.tag === 'option' && n.props?.value);
  const values = opts.map((o) => o.props.value).filter(Boolean);
  assert.ok(!values.includes('NSC-10'), 'NSC-10 already selected, excluded from dropdown');
  assert.ok(!values.includes('NSC-20'), 'NSC-20 already selected, excluded from dropdown');
  assert.ok(values.includes('NSC-30'), 'NSC-30 available');
});

test('no dropdown rendered when all open cards are already selected', () => {
  const h = makePickerHarness(['NSC-10', 'NSC-20', 'NSC-30'], OPEN_CARDS);
  const tree = h.render();
  const sel = byTestId(tree, 'obj-card-select-o1');
  assert.equal(sel, undefined, 'dropdown hidden when no available cards remain');
});

test('"+ New card" button renders NewCardDialog with open=false initially', () => {
  const h = makePickerHarness([], OPEN_CARDS);
  const tree = h.render();
  const dialog = h.findDialog(tree);
  assert.ok(dialog, 'NewCardDialog in tree');
  assert.equal(dialog.props.open, false, 'dialog closed initially');
  assert.ok(byTestId(tree, 'obj-card-new-o1'), '"+ New card" button present');
});

test('"+ New card" click opens NewCardDialog', () => {
  const h = makePickerHarness([], OPEN_CARDS, [{ key: 'NSC-10', title: 'Fix', status: 'todo' }]);
  byTestId(h.render(), 'obj-card-new-o1').props.onClick();
  const after = h.render();
  const dialog = h.findDialog(after);
  assert.ok(dialog, 'dialog element found after click');
  assert.equal(dialog.props.open, true, 'dialog opens after click');
});

test('when dialog closes after a new card in snapshot, it is auto-linked', () => {
  const before = [{ key: 'NSC-10', title: 'Fix', status: 'todo' }];
  const h = makePickerHarness([], OPEN_CARDS, before);
  // Click "New card" (captures snapshot before creation)
  byTestId(h.render(), 'obj-card-new-o1').props.onClick();
  // Simulate card appearing in snapshot (creation succeeded)
  h.updateSnapshot([...before, { key: 'NSC-99', title: 'Brand new', status: 'todo' }]);
  // Close dialog
  h.findDialog(h.render()).props.onClose();
  assert.deepEqual(h.getCardKeys(), ['NSC-99'], 'newly created card auto-linked');
});

test('when dialog is cancelled (snapshot unchanged), nothing is added', () => {
  const before = [{ key: 'NSC-10', title: 'Fix', status: 'todo' }];
  const h = makePickerHarness([], OPEN_CARDS, before);
  byTestId(h.render(), 'obj-card-new-o1').props.onClick();
  // snapshot unchanged (user cancelled)
  h.findDialog(h.render()).props.onClose();
  assert.deepEqual(h.getCardKeys(), [], 'no key added on cancel');
});

test('chips show card key; linked card title is shown if in openCards', () => {
  const h = makePickerHarness(['NSC-10', 'NSC-99'], OPEN_CARDS); // NSC-99 not in openCards
  const tree = h.render();
  const chips = nodes(tree).find((n) => n.props?.['data-testid'] === 'obj-card-chips-o1');
  assert.ok(chips, 'chips container');
  const chipTexts = nodes(chips).filter((n) => n.tag === 'span').map((n) => n.props.children).flat(Infinity).join(' ');
  assert.match(String(chipTexts), /NSC-10/, 'NSC-10 key shown');
  assert.match(String(chipTexts), /NSC-99/, 'unknown key still shown as chip');
});
