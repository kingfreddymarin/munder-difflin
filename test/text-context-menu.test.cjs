'use strict';
// NSC-223: right-click in a text field or on selected text shows native Copy/Paste/Select All.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { textContextMenuTemplate } = loadTs('src/main/text-context-menu.ts');

const flags = (o = {}) => ({ canCut: true, canCopy: true, canPaste: true, canSelectAll: true, ...o });
const roles = (t) => t.map((i) => i.role ?? '-');

test('an input or textarea gets Cut, Copy, Paste and Select All, enabled by Chromium edit flags', () => {
  const t = textContextMenuTemplate({ isEditable: true, selectionText: '', editFlags: flags({ canCut: false, canCopy: false }) });
  assert.deepEqual(roles(t), ['cut', 'copy', 'paste', '-', 'selectAll']);
  assert.deepEqual(t.filter((i) => i.role).map((i) => i.enabled), [false, false, true, true]);
});

test('selected read-only text gets Copy and Select All only', () => {
  assert.deepEqual(roles(textContextMenuTemplate({ isEditable: false, selectionText: 'agent log line', editFlags: flags({ canPaste: false }) })), ['copy', '-', 'selectAll']);
});

test('a right-click on plain UI with no selection shows no menu', () => {
  assert.deepEqual(textContextMenuTemplate({ isEditable: false, selectionText: '  ', editFlags: flags() }), []);
});

test('clipboard items never register accelerators (dictation paste stays inline)', () => {
  const t = textContextMenuTemplate({ isEditable: true, selectionText: 'x', editFlags: flags() });
  for (const i of t.filter((x) => x.role)) assert.equal(i.registerAccelerator, false);
});

test('every window wires the menu on webContents context-menu', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /wc\.on\('context-menu', \(_e, params\) => \{\s*const template = textContextMenuTemplate\(params\);\s*if \(template\.length\) Menu\.buildFromTemplate\(template\)\.popup\(\{ window: win \}\);/);
});
