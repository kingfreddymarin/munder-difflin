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
  assert.equal(externalTools({ codex: { path: null, required: true } })[0].level, 'required');
});

test('found tools are ready; an older core without the lookup reports nothing rather than a false "missing"', () => {
  assert.deepEqual(externalTools({ claude: { path: '/opt/homebrew/bin/claude' }, mempalace: { path: '/u/.local/bin/mempalace' } }).map((p) => p.state), ['ready', 'ready']);
  assert.deepEqual(externalTools({}), []);
});

test('the snapshot carries the lookup from main and the setup dialog lists required blockers', () => {
  const main = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(main, /tools: \{ claude: \{ path: ptyManager\.commandPath\('claude'\) \}, codex: \{ path: ptyManager\.commandPath\('codex'\), required:/);
  assert.match(main, /mempalace: \{ path: ptyManager\.commandPath\('mempalace'\) \} \}/);
  const provider = readFileSync(new URL('../src/data/electron-provider.ts', import.meta.url), 'utf8');
  assert.match(provider, /prerequisites\.push\(\.\.\.externalTools\(/);
  const gate = readFileSync(new URL('../src/app/setup-gate.tsx', import.meta.url), 'utf8');
  assert.match(gate, /p\.level === 'required'|useSetupBlockers/);
  assert.doesNotMatch(gate, /fall back to your engines/, 'a missing claude CLI has no fallback');
});

test('an installed engine keeps account-specific status and directs sign-in to an in-app action', () => {
  const { engineSignIns } = mod.exports;
  const list = engineSignIns({ codex: { state: 'expired', fix: 'Run `codex login` in Terminal, then start the agent again.', seen: '2026-11-12T21:20:00.000Z' }, claude: { state: 'signed-in' } });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'signin-codex'); assert.equal(list[0].level, 'required'); assert.equal(list[0].state, 'missing');
  assert.match(list[0].why, /action below/);
  assert.match(engineSignIns({ claude: { state: 'signed-out' } })[0].why, /action below/);
  assert.equal(engineSignIns({ codex: { state: 'unknown', accountId: 'dcxm', accountLabel: 'dcxm · Alternate' } })[0].state, 'unknown', 'uncertain status stays visible as unknown, not as signed out');
  const alternate = engineSignIns({ codex: { state: 'signed-out', accountId: 'dcxm', accountLabel: 'dcxm · Alternate', accountHome: '/accounts/alt' } })[0];
  assert.equal(alternate.signInAccountId, 'dcxm');
  assert.equal(alternate.signInAccountLabel, 'dcxm · Alternate');
  assert.equal(alternate.loginCommand, undefined);
});

test('Continue anyway covers the blockers it was pressed for; a new one opens the dialog again', () => {
  const { setupDismissedFor } = mod.exports;
  const claude = { name: 'Claude Code CLI (claude)', level: 'required', state: 'missing' };
  const codex = { name: 'Codex sign-in', level: 'required', state: 'missing' };
  assert.equal(setupDismissedFor({ dismissed: true, degraded: [claude.name] }, [claude]), true);
  assert.equal(setupDismissedFor({ dismissed: true, degraded: [claude.name] }, [claude, codex]), false);
  assert.equal(setupDismissedFor({}, []), false);
});
