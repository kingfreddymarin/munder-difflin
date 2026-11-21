import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const component = (name, modules) => {
  const code = ts.transpileModule(readFileSync(new URL('../src/app/' + name + '.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, id => modules[id] ?? {});
  return mod.exports;
};

const Button = ({ children, variant, size, ...props }) => React.createElement('button', props, children);
const Badge = ({ children }) => React.createElement('span', {}, children);
const { FloorOverviewContent } = component('floor-overview', {
  react: React, '@/components/animate-ui/components/buttons/button': { Button }, '@/components/ui/badge': { Badge }
});
const floor = (id, label, current) => ({
  id, name: 'Studio', home: '/' + id + '/Studio', current,
  agents: [{ id: 'god', label: label + ' agent', status: 'working' }],
  tasks: [{ id: 'NSC-1', label: label + ' task', status: 'todo' }]
});
const floors = [floor('a', 'Alpha', true), floor('b', 'Beta', false)];
const makeProps = overrides => ({
  floors, selected: null, select() {}, back() {}, newFloor() {}, openControls() {},
  loadError: false, focusError: false, focusing: false, ...overrides
});
const render = overrides => renderToStaticMarkup(React.createElement(FloorOverviewContent, makeProps(overrides)));
function find(node, predicate) {
  if (!React.isValidElement(node)) return;
  if (predicate(node)) return node;
  return React.Children.toArray(node.props.children).map(child => find(child, predicate)).find(Boolean);
}

test('All floors shows both floors with identical IDs, without losing their origin', () => {
  const html = render();
  for (const label of ['Alpha agent', 'Beta agent', 'Alpha task', 'Beta task', '/a/Studio', '/b/Studio']) {
    assert.ok(html.includes(label));
  }
  assert.equal([...html.matchAll(/NSC-1/g)].length, 2);
  assert.match(html, /aria-current="page">All floors</);
});

test('a floor tab scopes both lists and routes controls to its own floor', () => {
  let selected;
  let opened;
  const tree = FloorOverviewContent(makeProps({ select: id => { selected = id; } }));
  find(tree, node => node.props.title === '/b/Studio').props.onClick();
  assert.equal(selected, 'b');
  const html = render({ selected });
  assert.match(html, /Beta task/);
  assert.doesNotMatch(html, /Alpha task|Alpha agent/);
  const scoped = FloorOverviewContent(makeProps({ selected, openControls: view => { opened = view; } }));
  find(scoped, node => node.props.children === 'Open floor controls').props.onClick();
  assert.equal(opened, floors[1]);
  assert.match(render({ selected, floors: [floors[0]] }), /aria-current="page">All floors</, 'a departed floor falls back to All floors');
});

test('the same labelled toggle is reachable in Settings and New Floor', () => {
  const { FloorViewToggle } = component('floor-view-mode', {
    react: React, '@/components/animate-ui/components/radix/switch': { Switch: 'input' }
  });
  let enabled;
  const mode = { enabled: false, setEnabled(value) { enabled = value; } };
  const tree = FloorViewToggle({ mode });
  const toggle = find(tree, node => node.props['aria-label'] === 'Show floors in one window');
  assert.equal(toggle.props.checked, false);
  toggle.props.onCheckedChange(true);
  assert.equal(enabled, true);
  const source = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
  assert.match(source('../src/features/settings/floor-location.tsx'), /<FloorViewSettings \/>/);
  assert.match(source('../src/app/floor-chooser.tsx'), /!launch && viewMode && <FloorViewToggle mode=\{viewMode\}/);
  assert.match(source('../src/App.tsx'), /<FloorViewProvider><SetupGateOrApp \/><\/FloorViewProvider>/);
});
