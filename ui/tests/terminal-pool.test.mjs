import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// terminal-pool.ts with Munder's renderer: Unicode 11 widths on create, a WebGL renderer leased on
// attach and released on detach, the DOM renderer when WebGL fails or its context is lost, and the
// same Terminal (so the same scrollback) after switching away and back.
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const ui = resolve(dirname(fileURLToPath(import.meta.url)), '..');

class FakeTerminal {
  constructor(options) { this.options = { ...options }; this.addons = []; this.unicode = { activeVersion: '6' }; this.cols = 80; this.rows = 24; this.element = null; this.disposed = false;
    this.parser = { registerOscHandler() {}, registerCsiHandler() {} }; this.buffer = { active: { viewportY: 0, baseY: 0, getLine() {} } }; }
  loadAddon(addon) { this.addons.push(addon); }
  open(el) { this.element = el; }
  attachCustomKeyEventHandler() {} onData() {} registerLinkProvider() {} write() {} writeln() {} refresh() {} focus() {}
  scrollLines() {} scrollToBottom() {} hasSelection() { return false; } reset() {} clearTextureAtlas() {}
  dispose() { this.disposed = true; }
}
class FakeFit { fit() {} }
class FakeUnicode11 {}
class FakeWebgl {
  static fail = false;
  constructor() { if (FakeWebgl.fail) throw new Error('no webgl2'); this.disposed = false; }
  onContextLoss(cb) { this.lose = cb; }
  dispose() { this.disposed = true; }
}
const element = () => ({ style: {}, parentElement: null, isConnected: false, clientWidth: 0, clientHeight: 0, addEventListener() {}, querySelectorAll: () => [],
  appendChild(child) { child.parentElement = this; child.isConnected = true; child.clientWidth = 800; child.clientHeight = 600; },
  removeChild(child) { child.parentElement = null; child.isConnected = false; }, remove() {} });
globalThis.document = { createElement: element };
globalThis.requestAnimationFrame = (cb) => cb();
const bridge = { onPtyData: () => () => {}, onPtyExit: () => () => {}, redrawPty: async () => ({ ok: true }), writePty: async () => ({ ok: true }), resizePty: async () => ({ ok: true }) };

const fakes = {
  '@xterm/xterm': { Terminal: FakeTerminal }, '@xterm/addon-fit': { FitAddon: FakeFit },
  '@xterm/addon-webgl': { WebglAddon: FakeWebgl }, '@xterm/addon-unicode11': { Unicode11Addon: FakeUnicode11 },
  '@/data/bridge': { findBridge: () => bridge },
};
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  cache.set(file, mod.exports);
  const req = (id) => {
    if (id.endsWith('.css')) return {};
    if (fakes[id]) return fakes[id];
    if (id.startsWith('@/')) return load(join(ui, 'src', id.slice(2)) + '.ts');
    if (id.startsWith('./')) return load(join(dirname(file), id.slice(2)) + '.ts');
    throw new Error(`unexpected import ${id}`);
  };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, req);
  cache.set(file, mod.exports);
  return mod.exports;
}
const pool = load(join(ui, 'src/components/app/terminal/terminal-pool.ts'));

test('a new terminal uses Unicode 11 widths, as in Munder', () => {
  const entry = pool.acquireTerminal('pty-u11', {}, 13);
  assert.ok(entry.term.addons.some((a) => a instanceof FakeUnicode11));
  assert.equal(entry.term.unicode.activeVersion, '11');
});

test('attach leases a WebGL renderer; detach releases it and keeps the terminal and its scrollback', () => {
  const entry = pool.acquireTerminal('pty-gl', {}, 13);
  const pane = element();
  pool.attachTerminal(entry, pane);
  const first = entry.webgl;
  assert.ok(first instanceof FakeWebgl);
  assert.ok(entry.term.addons.includes(first));
  pool.detachTerminal(entry, pane);
  assert.equal(first.disposed, true);
  assert.equal(entry.webgl, undefined);
  assert.equal(entry.term.disposed, false);
  // Switching back: the same pooled terminal, a fresh lease.
  assert.equal(pool.acquireTerminal('pty-gl', {}, 13), entry);
  pool.attachTerminal(entry, element());
  assert.ok(entry.webgl instanceof FakeWebgl && entry.webgl !== first);
});

test('without WebGL the terminal falls back to the DOM renderer instead of failing', () => {
  FakeWebgl.fail = true;
  try {
    const entry = pool.acquireTerminal('pty-dom', {}, 13);
    assert.doesNotThrow(() => pool.attachTerminal(entry, element()));
    assert.equal(entry.webgl, undefined);
    assert.equal(entry.opened, true);
  } finally { FakeWebgl.fail = false; }
});

test('a lost WebGL context hands painting to the DOM renderer and repaints', () => {
  const entry = pool.acquireTerminal('pty-lost', {}, 13);
  pool.attachTerminal(entry, element());
  const webgl = entry.webgl;
  webgl.lose();
  assert.equal(webgl.disposed, true);
  assert.equal(entry.webgl, undefined);
  assert.equal(entry.needsRendererRepaint, false, 'repainted on the next frames once on screen');
});

test('disposing a terminal releases its renderer', () => {
  const entry = pool.acquireTerminal('pty-gone', {}, 13);
  pool.attachTerminal(entry, element());
  const webgl = entry.webgl;
  pool.disposeTerminal('pty-gone');
  assert.equal(webgl.disposed, true);
  assert.equal(entry.term.disposed, true);
});
