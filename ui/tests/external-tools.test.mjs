import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Provider CLI requirements follow the engines selected by configuration and active agents.
const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');
const js = ts.transpileModule(readFileSync(new URL('../src/data/external-tools.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} }; new Function('module', 'exports', 'require', js)(mod, mod.exports, () => ({}));
const { externalTools } = mod.exports;

test('a missing claude CLI is a required, missing prerequisite with a plain reason; MemPalace is optional', () => {
  const list = externalTools({ claude: { path: null }, mempalace: { path: null } }, new Set(['claude']));
  const claude = list.find((p) => p.id === 'claude-cli');
  assert.equal(claude.level, 'required');
  assert.equal(claude.state, 'missing');
  assert.match(claude.why, /selected claude engine needs this command/);
  const palace = list.find((p) => p.id === 'mempalace');
  assert.equal(palace.level, 'optional');
  assert.equal(palace.state, 'missing');
  assert.equal(externalTools({ codex: { path: null, required: false } }, new Set(['codex']))[0].level, 'required');
});

test('found tools are ready; an older core without the lookup reports nothing rather than a false "missing"', () => {
  assert.deepEqual(externalTools({ claude: { path: '/opt/homebrew/bin/claude' }, mempalace: { path: '/u/.local/bin/mempalace' } }).map((p) => p.state), ['ready', 'ready']);
  assert.deepEqual(externalTools({}), []);
});

test('cold or failed command discovery stays unknown instead of prompting an install', () => {
  const list = externalTools({ claude: { path: null, state: 'checking' }, codex: { path: null, state: 'unknown', required: true }, mempalace: { path: null, state: 'missing' } }, new Set(['claude', 'codex']));
  assert.equal(list.find((p) => p.id === 'claude-cli').state, 'unknown');
  assert.match(list.find((p) => p.id === 'claude-cli').detail, /Checking/);
  assert.equal(list.find((p) => p.id === 'codex-cli').state, 'unknown');
  assert.equal(list.find((p) => p.id === 'mempalace').state, 'missing');
});

test('CLI readiness follows selected providers for Claude-only, Codex-only and mixed floors', () => {
  const tools = { claude: { path: null, state: 'missing' }, codex: { path: null, state: 'missing' } };
  const claudeOnly = externalTools(tools, new Set(['claude']));
  assert.equal(claudeOnly.find((p) => p.id === 'claude-cli').level, 'required');
  assert.equal(claudeOnly.find((p) => p.id === 'codex-cli').level, 'recommended');

  const codexOnly = externalTools(tools, new Set(['codex']));
  assert.equal(codexOnly.find((p) => p.id === 'claude-cli').level, 'recommended');
  assert.equal(codexOnly.find((p) => p.id === 'codex-cli').level, 'required');

  const mixed = externalTools(tools, new Set(['claude', 'codex']));
  assert.equal(mixed.find((p) => p.id === 'claude-cli').level, 'required');
  assert.equal(mixed.find((p) => p.id === 'codex-cli').level, 'required');
  assert.equal(externalTools({}, new Set(['codex'])).length, 0, 'older cores without tool checks do not invent missing prerequisites');
});

test('the snapshot carries the lookup from main and the setup dialog lists required blockers', () => {
  const main = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(main, /snapshotCommandTools\(snapshotCommandDiscovery/);
  assert.match(main, /installedSnapshotEngines\(snapshotCommandDiscovery\)/);
  assert.match(main, /snapshotSignInPath\(snapshotCommandDiscovery, engine\)/);
  const provider = readFileSync(new URL('../src/data/electron-provider.ts', import.meta.url), 'utf8');
  assert.match(provider, /prerequisites\.push\(\.\.\.externalTools\(/);
  assert.match(provider, /const selectedProviders = selectedSignInProviders\(object\(config\), object\(native\.registry\)\)/);
  assert.match(provider, /externalTools\(object\(object\(native\.prereqs\)\.tools\), selectedProviders\)/);
  assert.match(provider, /engineSignIns\(object\(object\(native\.prereqs\)\.signIn\), selectedProviders, mutedProviders\)/);
  const gate = readFileSync(new URL('../src/app/setup-gate.tsx', import.meta.url), 'utf8');
  assert.match(gate, /p\.level === 'required'|useSetupBlockers/);
  assert.doesNotMatch(gate, /fall back to your engines/, 'a missing claude CLI has no fallback');
  const blockerHook = readFileSync(new URL('../src/components/app/prereq-list.tsx', import.meta.url), 'utf8');
  assert.match(blockerHook, /return setupBlockers\(prereqs\)/);
});

test('an installed engine keeps account-specific status and directs sign-in to an in-app action', () => {
  const { engineSignIns } = mod.exports;
  const list = engineSignIns({ codex: { state: 'expired', fix: 'Run `codex login` in Terminal, then start the agent again.', seen: '2026-11-12T21:20:00.000Z' }, claude: { state: 'signed-in' } });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'signin-codex'); assert.equal(list[0].level, 'recommended'); assert.equal(list[0].state, 'missing');
  assert.match(list[0].why, /action below/);
  const claude = engineSignIns({ claude: { state: 'signed-out' } })[0];
  assert.equal(claude.level, 'required');
  assert.match(claude.why, /action below/);
  assert.equal(engineSignIns({ codex: { state: 'unknown', accountId: 'dcxm', accountLabel: 'dcxm · Alternate' } })[0].state, 'unknown', 'uncertain status stays visible as unknown, not as signed out');
  const alternate = engineSignIns({ codex: { state: 'signed-out', accountId: 'dcxm', accountLabel: 'dcxm · Alternate', accountHome: '/accounts/alt' } })[0];
  assert.equal(alternate.signInAccountId, 'dcxm');
  assert.equal(alternate.signInAccountLabel, 'dcxm · Alternate');
  assert.equal(alternate.loginCommand, undefined);
});

test('sign-in and CLI readiness follow configured and active providers, excluding archived agents', () => {
  const { engineSignIns, selectedSignInProviders } = mod.exports;
  const signIns = { codex: { state: 'expired' }, claude: { state: 'signed-out' } };
  const registry = { agents: { claudeAgent: { provider: 'claude' }, retiredCodex: { provider: 'codex', archived: true } } };
  const claudeOnly = selectedSignInProviders({ godProvider: 'claude' }, registry);
  const claudeOnlyRows = engineSignIns(signIns, claudeOnly);
  assert.equal(claudeOnlyRows.find((p) => p.id === 'signin-claude').level, 'required');
  assert.equal(claudeOnlyRows.find((p) => p.id === 'signin-codex').level, 'recommended');

  const codexSelected = selectedSignInProviders({ godProvider: 'codex' }, { agents: {} });
  assert.equal(engineSignIns(signIns, codexSelected).find((p) => p.id === 'signin-codex').level, 'required');
  const activeCodex = selectedSignInProviders({ godProvider: 'claude' }, { agents: { coder: { provider: 'codex' } } });
  assert.equal(engineSignIns(signIns, activeCodex).find((p) => p.id === 'signin-codex').level, 'required');
  assert.doesNotMatch([...claudeOnly].join(','), /codex/, 'archived Codex agents do not make Codex a blocker');
  assert.ok(selectedSignInProviders({ godProvider: 'codex' }, { agents: { legacy: {} } }).has('claude'), 'agents without provider metadata still use the Claude default');
});

test('unknown/checking prerequisites never open global Setup, but confirmed missing prerequisites do', () => {
  const { setupBlockers, setupDismissedFor } = mod.exports;
  const unknownClaude = { name: 'Claude sign-in', level: 'required', state: 'unknown' };
  const missingClaude = { name: 'Claude CLI', level: 'required', state: 'missing' };
  assert.deepEqual(setupBlockers([unknownClaude]), []);
  assert.deepEqual(setupBlockers([unknownClaude, missingClaude]), [missingClaude]);
  assert.equal(setupDismissedFor({ dismissed: true, degraded: [] }, [unknownClaude]), true);
});

test('Continue anyway covers the blockers it was pressed for; a new one opens the dialog again', () => {
  const { setupDismissedFor } = mod.exports;
  const claude = { name: 'Claude Code CLI (claude)', level: 'required', state: 'missing' };
  const codex = { name: 'Codex sign-in', level: 'required', state: 'missing' };
  assert.equal(setupDismissedFor({ dismissed: true, degraded: [claude.name] }, [claude]), true);
  assert.equal(setupDismissedFor({ dismissed: true, degraded: [claude.name] }, [claude, codex]), false);
  assert.equal(setupDismissedFor({}, []), false);
});

// ─── "Don't ask again" login-reminder muting ──────────────────────────────

test('muting a provider excludes its sign-in row from automatic checks but not signed-in rows', () => {
  const { engineSignIns } = mod.exports;
  const signIn = { claude: { state: 'signed-out' }, codex: { state: 'expired' } };
  // With claude muted: claude sign-in row is gone; codex row still present
  const claudeMuted = engineSignIns(signIn, new Set(['claude', 'codex']), new Set(['claude']));
  assert.ok(!claudeMuted.find((p) => p.id === 'signin-claude'), 'muted claude sign-in must not appear');
  assert.ok(claudeMuted.find((p) => p.id === 'signin-codex'), 'codex sign-in appears when only claude is muted');

  // Muting is provider-independent: muting codex does not affect claude
  const codexMuted = engineSignIns(signIn, new Set(['claude', 'codex']), new Set(['codex']));
  assert.ok(codexMuted.find((p) => p.id === 'signin-claude'), 'claude sign-in appears when only codex is muted');
  assert.ok(!codexMuted.find((p) => p.id === 'signin-codex'), 'muted codex sign-in must not appear');

  // Muting both silences both
  const bothMuted = engineSignIns(signIn, new Set(['claude', 'codex']), new Set(['claude', 'codex']));
  assert.equal(bothMuted.length, 0, 'all sign-in rows hidden when both providers are muted');
});

test('muting never hides a signed-in row; signed-in rows are always shown', () => {
  const { engineSignIns } = mod.exports;
  const signedIn = { claude: { state: 'signed-in' }, codex: { state: 'signed-in' } };
  const allMuted = engineSignIns(signedIn, new Set(['claude', 'codex']), new Set(['claude', 'codex']));
  assert.ok(allMuted.find((p) => p.id === 'signin-claude' && p.state === 'ready'), 'signed-in claude shows even when muted');
  assert.ok(allMuted.find((p) => p.id === 'signin-codex' && p.state === 'ready'), 'signed-in codex shows even when muted');
});

test('unknown/failed auth states are muted too — only signed-in rows survive muting', () => {
  const { engineSignIns } = mod.exports;
  // A muted provider with unknown state (e.g. probe failed) is also excluded
  const unknownState = { claude: { state: 'unknown' } };
  const muted = engineSignIns(unknownState, new Set(['claude']), new Set(['claude']));
  assert.equal(muted.length, 0, 'unknown state is excluded when provider is muted');
});

test('mutedSignInProviders reads from preferences.signInReminders with provider independence', () => {
  const { mutedSignInProviders } = mod.exports;
  assert.deepEqual([...mutedSignInProviders({ signInReminders: { claude: true, codex: false } })], ['claude']);
  assert.deepEqual([...mutedSignInProviders({ signInReminders: { claude: false, codex: true } })], ['codex']);
  assert.deepEqual([...mutedSignInProviders({ signInReminders: { claude: true, codex: true } })].sort(), ['claude', 'codex']);
  assert.deepEqual([...mutedSignInProviders({})], [], 'absent signInReminders = nothing muted');
  assert.deepEqual([...mutedSignInProviders({ signInReminders: null })], [], 'null signInReminders = nothing muted');
  assert.deepEqual([...mutedSignInProviders({ signInReminders: [] })], [], 'array signInReminders = nothing muted');
});

test('reset (muted: false) re-enables reminders; existing sign-in state unaffected', () => {
  const { engineSignIns } = mod.exports;
  const signIn = { claude: { state: 'signed-out' } };
  // Muted — no rows
  assert.equal(engineSignIns(signIn, new Set(['claude']), new Set(['claude'])).length, 0);
  // Reset (empty muted set) — row returns
  assert.equal(engineSignIns(signIn, new Set(['claude']), new Set()).length, 1);
});

test('snapshot carries the signInReminders call and the electron provider threads mutedProviders', () => {
  const provider = readFileSync(new URL('../src/data/electron-provider.ts', import.meta.url), 'utf8');
  assert.match(provider, /mutedSignInProviders\(preferences\)/, 'electron-provider reads muted providers from preferences');
  assert.match(provider, /engineSignIns\(object\(object\(native\.prereqs\)\.signIn\), selectedProviders, mutedProviders\)/, 'electron-provider passes mutedProviders to engineSignIns');
  assert.match(provider, /mutedSignInReminders/, 'muted set is projected onto the snapshot');

  const main = readFileSync(new URL('../../src/main/paramount.ts', import.meta.url), 'utf8');
  assert.match(main, /case 'signIn\.muteReminder'/, 'paramount.ts handles the muteReminder command');
  assert.match(main, /savePreference\('signInReminders'/, 'paramount.ts persists muted choice under signInReminders');
  assert.match(main, /command\.provider !== 'claude' && command\.provider !== 'codex'/, 'paramount.ts validates provider is claude or codex');
});
