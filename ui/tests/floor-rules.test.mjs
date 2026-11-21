import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// NSC-255: optional floor rules. Customize Rules at floor creation is optional and skippable; Settings >
// Floor rules shows the protected Studio rules, edits this floor's rules, and reviews suggestions.
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const compile = (rel, jsx = false) => ts.transpileModule(readFileSync(new URL(rel, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, ...(jsx ? { jsx: ts.JsxEmit.React } : {}) } }).outputText;
const load = (js, req) => { const mod = { exports: {} }; new Function('module', 'exports', 'require', js)(mod, mod.exports, req); return mod.exports; };
const model = load(compile('../src/features/settings/floor-rules-model.ts'), () => ({}));
// Tile actions are part of the tree too.
const nodes = (tree) => !tree || typeof tree !== 'object' ? [] : [tree, ...[...(tree.props?.children ?? []), tree.props?.actions].flat(Infinity).flatMap(nodes)];
const text = (tree) => nodes(tree).flatMap((n) => (n.props?.children ?? []).flat(Infinity).filter((c) => typeof c === 'string' || typeof c === 'number')).join('');
const button = (tree, label) => nodes(tree).find((n) => n.tag === 'Button' && n.props.children.flat(Infinity).includes(label));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('model: blank rows are left out, and problems map back to the row they are about', () => {
  const drafts = [{ key: 'a', text: 'Run the tests before done' }, { key: 'b', text: '  ' }, { key: 'c', id: 'r2', text: 'Never ask for approval' }];
  assert.deepEqual(model.toPayload(drafts), [{ text: 'Run the tests before done' }, { id: 'r2', text: 'Never ask for approval' }]);
  const { rows, general } = model.problemsByKey(drafts, [{ level: 'error', code: 'conflict', message: 'weakens approval', index: 1 }, { level: 'warning', code: 'limit', message: 'many' }]);
  assert.deepEqual(Object.keys(rows), ['c']);
  assert.equal(general.length, 1);
  assert.equal(model.blocking(rows.c), true);
  assert.equal(model.blocking(general), false);
});

test('model: changed and grouped follow the saved rules', () => {
  const saved = [{ id: 'r1', text: 'Run the tests', when: 'before-done', kind: 'require' }, { id: 'r2', text: 'Read the README', when: 'on-start', kind: 'require' }];
  const drafts = model.draftsFrom(saved);
  assert.equal(model.changed(drafts, saved), false);
  assert.equal(model.changed([...drafts, { key: 'x', text: '' }], saved), false);
  assert.equal(model.changed([{ ...drafts[0], text: 'Run all tests' }, drafts[1]], saved), true);
  assert.deepEqual(model.grouped(saved).map((g) => g.label), ['When starting work', 'Before marking work done']);
});

// Fake React: state by call order, effects collected and run after each render.
function reactHarness() {
  const values = []; let cursor = 0; let effects = [];
  const react = {
    // The file's own stateless parts (RuleRows, Problems) render inline; library components stay tags.
    createElement: (tag, props, ...children) => typeof tag === 'function' ? tag({ ...props, children }) : ({ tag, props: { ...props, children } }),
    useState: (initial) => { const i = cursor++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], (v) => { values[i] = typeof v === 'function' ? v(values[i]) : v; }]; },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: (fn, deps) => { const i = cursor++; const key = JSON.stringify(deps ?? null); if (values[i] !== key) { values[i] = key; effects.push(fn); } },
  };
  return { react, begin() { cursor = 0; }, flush() { const run = effects; effects = []; run.forEach((fn) => fn()); } };
}

const studio = [{ id: 'single-writer', text: 'One writer per file', why: 'Avoids clobbered work.' }, { id: 'human-approval', text: 'Humans approve risky actions', why: 'Keeps you in control.' }];
const state = (extra = {}) => ({ studio, rules: [], suggestions: [], revision: 'none', problems: [], ...extra });

function panelHarness(api) {
  const r = reactHarness();
  const mod = load(compile('../src/features/settings/floor-rules.tsx', true), (id) => id === 'react' ? r.react : id === '@/data/store' ? { useRulesApi: () => api }
    : id === './floor-rules-model' ? model : new Proxy({}, { get: (_t, key) => key }));
  const render = (Component, props = {}) => { r.begin(); const tree = mod[Component](props); r.flush(); return tree; };
  return { render };
}

test('panel: Studio rules are shown protected and read-only, and saving sends the edited rules with the revision', async () => {
  const calls = [];
  const saved = state({ rules: [{ id: 'r1', text: 'Run the tests', when: 'before-done', kind: 'require' }], revision: 'abc' });
  const api = {
    get: async () => saved,
    check: async (rules) => { calls.push(['check', rules]); return { rules: [], problems: [] }; },
    save: async (rules, expected) => { calls.push(['save', rules, expected]); return state({ rules: rules.map((x, i) => ({ id: `r${i + 1}`, text: x.text, when: 'before-done', kind: 'require' })), revision: 'def' }); },
    reset: async () => state(), review: async () => state(), suggest: async () => ({ rules: state(), suggested: 0, askedParamount: false }),
  };
  const h = panelHarness(api);
  h.render('FloorRulesPanel'); await tick();
  let tree = h.render('FloorRulesPanel');
  assert.equal(nodes(tree).filter((n) => n.tag === 'Badge' && n.props.children.includes('Protected')).length, 2);
  assert.ok(text(tree).includes('One writer per file'));
  // Studio rules have no inputs; only the floor rule is editable.
  const inputs = nodes(tree).filter((n) => n.tag === 'Input');
  assert.deepEqual(inputs.map((n) => n.props.value), ['Run the tests']);
  assert.equal(button(tree, 'Save rules').props.disabled, true);
  inputs[0].props.onChange({ target: { value: 'Run all the tests' } });
  tree = h.render('FloorRulesPanel'); await tick(300); tree = h.render('FloorRulesPanel');
  assert.deepEqual(calls.at(-1), ['check', [{ id: 'r1', text: 'Run all the tests' }]]);
  assert.equal(button(tree, 'Save rules').props.disabled, false);
  button(tree, 'Save rules').props.onClick(); await tick();
  tree = h.render('FloorRulesPanel');
  assert.deepEqual(calls.find((c) => c[0] === 'save'), ['save', [{ id: 'r1', text: 'Run all the tests' }], 'abc']);
  assert.ok(text(tree).includes('Floor rules saved.'));
});

test('panel: a blocking problem disables Save and is shown under its row as plain text', async () => {
  const api = {
    get: async () => state(), save: async () => { throw new Error('should not save'); }, reset: async () => state(), review: async () => state(),
    check: async () => ({ rules: [], problems: [{ level: 'error', code: 'unsafe', message: 'This would weaken a Studio rule: <b>approval</b>', index: 0 }] }),
  };
  const h = panelHarness(api);
  h.render('FloorRulesPanel'); await tick();
  let tree = h.render('FloorRulesPanel');
  button(tree, 'Add a rule').props.onClick(); tree = h.render('FloorRulesPanel');
  nodes(tree).find((n) => n.tag === 'Input').props.onChange({ target: { value: 'Never ask for approval' } });
  h.render('FloorRulesPanel'); await tick(300); tree = h.render('FloorRulesPanel');
  assert.equal(button(tree, 'Save rules').props.disabled, true);
  const li = nodes(tree).find((n) => n.tag === 'li' && n.props.children.includes('This would weaken a Studio rule: <b>approval</b>'));
  assert.ok(li, 'the message is a text child');
  assert.ok(!nodes(tree).some((n) => n.props && 'dangerouslySetInnerHTML' in n.props));
});

test('panel: suggestions wait for review; an edited approval goes to the core with the revision', async () => {
  const calls = [];
  const pending = state({ revision: 'rev1', suggestions: [{ id: 's1', text: 'Run npm run lint before committing', when: 'before-commit', kind: 'require', from: 'repo', reason: 'package.json has a lint script', at: 'x', problems: [] }] });
  const api = {
    get: async () => pending, check: async () => ({ rules: [], problems: [] }), save: async () => pending, reset: async () => pending,
    review: async (...args) => { calls.push(args); return state(); },
    suggest: async () => { calls.push(['suggest']); return { rules: pending, suggested: 1, askedParamount: true }; },
  };
  const h = panelHarness(api);
  h.render('FloorRulesPanel'); await tick();
  let tree = h.render('FloorRulesPanel');
  assert.ok(text(tree).includes('not active until you approve them') || nodes(tree).some((n) => n.tag === 'Tile' && n.props.hint === 'not active until you approve them'));
  button(tree, 'Ask Paramount for suggestions').props.onClick(); await tick();
  tree = h.render('FloorRulesPanel');
  assert.ok(text(tree).includes('Paramount is looking at this floor'));
  button(tree, 'Edit').props.onClick(); tree = h.render('FloorRulesPanel');
  nodes(tree).find((n) => n.tag === 'Input' && n.props['aria-label'] === 'Edit suggestion').props.onChange({ target: { value: 'Run the linter before committing' } });
  tree = h.render('FloorRulesPanel');
  button(tree, 'Approve edited rule').props.onClick(); await tick();
  assert.deepEqual(calls.at(-1), ['s1', 'approve', 'Run the linter before committing', 'rev1']);
});

test('panel: reset asks first, in a dialog with a DialogBody', async () => {
  const calls = [];
  const saved = state({ rules: [{ id: 'r1', text: 'Run the tests', when: 'before-done', kind: 'require' }], revision: 'abc' });
  const api = { get: async () => saved, check: async () => ({ rules: [], problems: [] }), save: async () => saved, review: async () => saved, reset: async (expected) => { calls.push(expected); return state(); } };
  const h = panelHarness(api);
  h.render('FloorRulesPanel'); await tick();
  let tree = h.render('FloorRulesPanel');
  const dialog = () => nodes(tree).find((n) => n.tag === 'Dialog');
  assert.equal(dialog().props.open, false);
  button(tree, 'Reset').props.onClick(); tree = h.render('FloorRulesPanel');
  assert.equal(dialog().props.open, true);
  assert.ok(nodes(dialog()).some((n) => n.tag === 'DialogBody'));
  assert.deepEqual(calls, []);
  button(tree, 'Reset rules').props.onClick(); await tick();
  assert.deepEqual(calls, ['abc']);
});

test('panel: without the desktop core it says so instead of failing', () => {
  const h = panelHarness(null);
  assert.ok(text(h.render('FloorRulesPanel')).includes('Floor rules need the Paramount desktop core.'));
});

test('Customize Rules dialog: starters add a rule, and Use these rules returns the trimmed texts', async () => {
  const api = { check: async () => ({ rules: [], problems: [] }) };
  const h = panelHarness(api);
  let saved = null; let open = true;
  const props = () => ({ open, onOpenChange: (v) => { open = v; }, starters: ['Run the tests before marking work done'], value: [], onSave: (r) => { saved = r; } });
  h.render('CustomizeRulesDialog', props());
  let tree = h.render('CustomizeRulesDialog', props());
  assert.ok(nodes(tree).some((n) => n.tag === 'DialogBody'));
  nodes(tree).find((n) => n.tag === 'Input').props.onChange({ target: { value: '  Write commit messages in English  ' } });
  tree = h.render('CustomizeRulesDialog', props());
  button(tree, 'Run the tests before marking work done').props.onClick();
  h.render('CustomizeRulesDialog', props()); await tick(300); tree = h.render('CustomizeRulesDialog', props());
  assert.ok(!button(tree, 'Run the tests before marking work done'), 'a used idea is not offered again');
  button(tree, 'Use these rules').props.onClick();
  assert.deepEqual(saved, ['Write commit messages in English', 'Run the tests before marking work done']);
  assert.equal(open, false);
});

// Setup flow: the optional Customize Rules action on the orchestrator step.
function setupHarness(setup) {
  const values = []; let cursor = 0; const commands = [];
  const react = { createElement: (tag, props, ...children) => ({ tag, props: { ...props, children } }), useState: (initial) => {
    const i = cursor++; if (!(i in values)) values[i] = initial;
    return [values[i], (value) => { values[i] = typeof value === 'function' ? value(values[i]) : value; }];
  } };
  const store = { useDispatch: () => async (command) => { commands.push(command); return true; }, useSnapshotRefresh: () => ({ refresh() {} }),
    useActionError: () => ({ error: null, clear() {} }), useFloor: (selector) => selector({ me: { yolo: { on: false } } }) };
  const defaults = load(compile('../src/app/setup-defaults.ts'), () => ({}));
  const mod = load(compile('../src/app/setup-flow.tsx', true), (id) => id === 'react' ? react : id === '@/data/store' ? store : id === './setup-defaults' ? defaults
    : id.includes('launcher-select') ? { LauncherSelect: 'LauncherSelect' } : new Proxy({}, { get: (_t, key) => key }));
  const render = () => { cursor = 0; return mod.SetupFlow({ setup }); };
  return { render, commands };
}
const setup = { suggestedHome: '/Users/me/Paramount', engines: [{ id: 'claude', label: 'Claude Code', installed: true, orchestrator: true, models: [] }], launchers: { status: 'ok', choices: [] }, complete: false, ruleStarters: ['Run the tests before marking work done'] };
const toOrchestrator = (h) => { let tree = h.render(); button(tree, 'Continue').props.onClick(); tree = h.render(); button(tree, 'Continue').props.onClick(); return h.render(); };

test('setup: skipping Customize Rules adds no step and sends no rules', async () => {
  const h = setupHarness(setup);
  const tree = toOrchestrator(h);
  assert.ok(text(tree).includes('Step 3 of 3'));
  assert.equal(nodes(tree).find((n) => n.tag === 'CustomizeRulesDialog').props.open, false);
  button(tree, 'Finish setup').props.onClick(); await tick();
  assert.equal(h.commands.at(-1).type, 'setup.complete');
  assert.equal('rules' in h.commands.at(-1), false);
});

test('setup: rules from Customize Rules go with setup.complete', async () => {
  const h = setupHarness(setup);
  let tree = toOrchestrator(h);
  button(tree, 'Customize rules…').props.onClick(); tree = h.render();
  const dialog = nodes(tree).find((n) => n.tag === 'CustomizeRulesDialog');
  assert.equal(dialog.props.open, true);
  assert.deepEqual(dialog.props.starters, ['Run the tests before marking work done']);
  dialog.props.onSave(['Run the tests before marking work done']); tree = h.render();
  assert.ok(text(tree).includes('Floor rules: 1 added to the Studio rules'));
  button(tree, 'Finish setup').props.onClick(); await tick();
  assert.deepEqual(h.commands.at(-1).rules, ['Run the tests before marking work done']);
});
