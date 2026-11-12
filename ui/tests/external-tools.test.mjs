import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Owner 2026-11-12: the .dmg is the only download. On first launch Paramount says plainly what it
// still needs from this Mac: the claude CLI (required, it runs every agent) and MemPalace (optional).
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const js = ts.transpileModule(readFileSync(new URL('../src/data/external-tools.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} }; new Function('module', 'exports', 'require', js)(mod, mod.exports, () => ({}));
const { externalTools } = mod.exports;

test('a missing claude CLI is a required, missing prerequisite with a plain reason; MemPalace is optional', () => {
  const list = externalTools({ claude: { path: null }, mempalace: { path: null } });
  const claude = list.find((p) => p.id === 'claude-cli');
  assert.equal(claude.level, 'required');
  assert.equal(claude.state, 'missing');
  assert.match(claude.why, /cannot run agents without it/);
  const palace = list.find((p) => p.id === 'mempalace');
  assert.equal(palace.level, 'optional');
  assert.equal(palace.state, 'missing');
});

test('found tools are ready; an older core without the lookup reports nothing rather than a false "missing"', () => {
  assert.deepEqual(externalTools({ claude: { path: '/opt/homebrew/bin/claude' }, mempalace: { path: '/u/.local/bin/mempalace' } }).map((p) => p.state), ['ready', 'ready']);
  assert.deepEqual(externalTools({}), []);
});

test('the snapshot carries the lookup from main and the setup dialog lists required blockers', () => {
  const main = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(main, /tools: \{ claude: \{ path: ptyManager\.commandPath\('claude'\) \}, mempalace: \{ path: ptyManager\.commandPath\('mempalace'\) \} \}/);
  const provider = readFileSync(new URL('../src/data/electron-provider.ts', import.meta.url), 'utf8');
  assert.match(provider, /prerequisites\.push\(\.\.\.externalTools\(/);
  const gate = readFileSync(new URL('../src/app/setup-gate.tsx', import.meta.url), 'utf8');
  assert.match(gate, /p\.level === 'required'|useSetupBlockers/);
  assert.doesNotMatch(gate, /fall back to your engines/, 'a missing claude CLI has no fallback');
});
