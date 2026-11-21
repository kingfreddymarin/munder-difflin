import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// A floor another app holds shows the refusal screen instead of the app (and starts no
// orchestrator); a hook socket that failed to bind shows an error banner, never silence.
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function banner(hookSocket) {
  const js = ts.transpileModule(src('src/app/hook-socket-banner.tsx'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  const mod = { exports: {} };
  const react = { createElement: (tag, props, ...children) => ({ tag, props: { ...props, children } }) };
  new Function('module', 'exports', 'require', 'React', js)(mod, mod.exports, (id) => id === 'react' ? react : { useFloor: (sel) => sel({ hookSocket }) }, react);
  return mod.exports.HookSocketBanner();
}
const text = (n) => (!n || typeof n !== 'object' ? String(n ?? '') : (n.props.children ?? []).flat(Infinity).map(text).join(''));

test('a failed hook socket shows an error banner; a healthy or not-yet-bound one does not', () => {
  const shown = banner({ listening: false, lastError: 'EADDRINUSE', attempts: 3 });
  assert.equal(shown.props.role, 'alert');
  assert.match(text(shown), /Agent hooks are not connected \(EADDRINUSE\)/);
  assert.match(text(shown), /without approval checks and no cost is recorded/);
  assert.equal(banner({ listening: true, lastError: null, attempts: 1 }), null);
  assert.equal(banner({ listening: false, lastError: 'NOROOT', attempts: 0 }), null);
  assert.equal(banner(undefined), null);
});

test('the app gate shows the refusal screen for a held floor, and the shell carries the hook banner', () => {
  const app = src('src/App.tsx');
  assert.match(app, /floorLock\?\.state === 'refused'[^\n]*return <FloorRefused/);
  assert.match(src('src/app/app-shell.tsx'), /<HookSocketBanner \/>/);
  const refused = src('src/app/floor-refused.tsx');
  assert.match(refused, /floor\.retry/);
  assert.match(refused, /floor\.choose-another/);
  assert.match(refused, /has not read or changed anything on this floor/);
});

test('no orchestrator start on a floor this app does not hold', () => {
  assert.match(src('src/app/use-orchestrator-startup.ts'), /if \(setup\.floorLock && setup\.floorLock\.state !== 'open'\) return;/);
});
