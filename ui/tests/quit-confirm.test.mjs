import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Munder's quit warning in Council: main defers a quit while agents run and asks the window.
// Without a listener the app could not be quit at all while an agent ran.
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const js = ts.transpileModule(readFileSync(new URL('../src/app/quit-confirm.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;

function harness() {
  const calls = { confirm: 0, cancel: 0 }; let listener = null; const values = []; let cursor = 0;
  const bridge = { onCloseRequested: (cb) => { listener = cb; return () => {}; }, confirmClose: async () => { calls.confirm++; }, cancelClose: async () => { calls.cancel++; } };
  const react = { createElement: (tag, props, ...children) => ({ tag, props: { ...props, children } }),
    useState: (init) => { const i = cursor++; if (!(i in values)) values[i] = init; return [values[i], (v) => { values[i] = typeof v === 'function' ? v(values[i]) : v; }]; },
    useEffect: (fn) => { fn(); } };
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, (id) => id === 'react' ? react : id === '@/data/bridge' ? { findBridge: () => bridge } : { Button: 'Button' });
  const render = () => { cursor = 0; return mod.exports.QuitConfirm(); };
  return { render, calls, ask: (info) => listener(info) };
}
const nodes = (n) => (!n || typeof n !== 'object' ? [] : [n, ...(n.props.children ?? []).flat(Infinity).flatMap(nodes)]);
const button = (tree, text) => nodes(tree).find((n) => n.tag === 'Button' && n.props.children.flat(Infinity).join('').includes(text));

test('a deferred quit asks; "Stop agents and quit" confirms, Cancel cancels', async () => {
  const h = harness();
  assert.equal(h.render(), null, 'nothing shown until main asks');
  h.ask({ ptyCount: 2 });
  let tree = h.render();
  assert.equal(nodes(tree).find((n) => n.props?.role === 'alertdialog')?.props['data-testid'], 'quit-confirm');
  button(tree, 'Cancel').props.onClick();
  assert.equal(h.calls.cancel, 1);
  assert.equal(h.render(), null);
  h.ask({ ptyCount: 1 });
  tree = h.render();
  await button(tree, 'Stop agents and quit').props.onClick();
  await new Promise(setImmediate);
  assert.equal(h.calls.confirm, 1);
});

test('the dialog is mounted on every screen (setup, refusal, app)', () => {
  assert.match(readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), /<TestLabel \/><QuitConfirm \/><SetupGateOrAppBody \/>/);
});
