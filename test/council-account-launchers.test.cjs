'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const load = require('./load-ts.cjs');
const account = load('src/main/council-account-launchers.ts');
const { dispatchParamount } = load('src/main/paramount.ts');
const { floorSetupState } = load('src/main/paramount-floor-setup.ts');
const defs = {
  dc: 'function dc() {\n unset CLAUDE_CONFIG_DIR\n command claude --dangerously-skip-permissions "$@"\n}',
  dcm: 'function dcm() {\n CLAUDE_CONFIG_DIR="$HOME/.claude-minion" command claude --dangerously-skip-permissions "$@"\n}',
  dcx: 'function dcx() {\n unset CODEX_HOME\n command codex --yolo "$@"\n}',
  dcxm: 'alias dcxm="env CODEX_HOME=$HOME/.codex-minion codex"'
};
function fixture(t, keys = Object.keys(defs)) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'council-launcher-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.zshrc');
  const write = (keys) => fs.writeFileSync(file, keys.map((k) => defs[k]).join('\n'));
  write(keys);
  for (const dir of ['.claude', '.claude-minion', '.codex', '.codex-minion']) fs.mkdirSync(path.join(home, dir));
  const probe = (shell, script, timeout) => {
    const result = spawnSync(shell, ['-d', '-ic', script], { env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', TERM: 'dumb' }, encoding: 'utf8', timeout });
    return { stdout: result.stdout, status: result.status, error: result.error };
  };
  const discover = () => account.discoverShellLaunchers(probe, 2000, home, '/bin/zsh');
  const pick = (id) => { const p = discover().choices.find((c) => c.id === id); return { id: p.id, fingerprint: p.fingerprint, ...(p.unrestricted ? { allowUnrestricted: true } : {}) }; };
  return { home, file, write, discover, pick, root: path.join(home, 'hive') };
}
for (const keys of [[], ['dcm'], ['dcx', 'dcxm'], Object.keys(defs)]) test(`discovery offers exactly declared aliases/functions: ${keys.join(',') || 'absent'}`, (t) => {
  const f = fixture(t, keys); const d = f.discover();
  assert.equal(d.status, 'ok'); assert.deepEqual(d.choices.map((c) => c.id), keys);
  assert.equal(d.choices.length, d.profiles.length);
});
test('sourced declarations resolve without invoking launchers or unrelated functions', (t) => {
  const f = fixture(t);
  const sentinel = path.join(f.home, 'must-not-exist');
  fs.writeFileSync(path.join(f.home, 'aliases.sh'), Object.values(defs).join('\n') + `\nfunction unrelated() {\n touch ${sentinel}\n}\n`);
  fs.writeFileSync(f.file, `source ~/aliases.sh 2>/dev/null || true\n`);
  assert.equal(f.discover().choices.length, 4);
  assert.equal(fs.existsSync(sentinel), false);
  fs.appendFileSync(f.file, "\nalias dc='$(touch " + sentinel + ")'\n");
  assert.equal(f.discover().status, 'failed'); assert.equal(fs.existsSync(sentinel), false);
});
test('timeout/failure are explicit and reveal neither credential text nor email', (t) => {
  const f = fixture(t);
  const timed = account.discoverShellLaunchers(() => ({ stdout: '', status: null, error: { code: 'ETIMEDOUT' } }), 1, f.home, '/bin/zsh');
  assert.equal(timed.status, 'timeout'); assert.equal(timed.choices.length, 0);
  fs.writeFileSync(f.file, 'alias dc="TOKEN=secret@example.test claude"');
  const d = f.discover(); assert.equal(d.status, 'failed');
  assert.doesNotMatch(JSON.stringify(account.publicDiscovery(d)), /secret|example.test|TOKEN/);
});
test('selection rejects removed/changed launchers, mismatched provider and unacknowledged permissions', (t) => {
  const f = fixture(t); const p = f.pick('dcm');
  assert.throws(() => account.validateLauncher({ ...p, allowUnrestricted: false }, 'claude', f.discover()), /consent/);
  assert.throws(() => account.validateLauncher(p, 'codex', f.discover()), /provider/);
  f.write(['dc']); assert.throws(() => account.validateLauncher(p, 'claude', f.discover()), /no longer available/);
  f.write(['dcm']); fs.writeFileSync(f.file, defs.dcm.replace('.claude-minion', '.claude-new')); 
  assert.throws(() => account.validateLauncher(p, 'claude', f.discover()), /changed/);
});
test('Claude Telegram channel flag is accepted exactly and does not grant unrestricted execution', (t) => {
  const f = fixture(t, ['dc']);
  const channel = 'plugin:telegram@claude-plugins-official';
  fs.writeFileSync(f.file, `function dc() {\n unset CLAUDE_CONFIG_DIR\n command claude --channels ${channel} "$@"\n}`);
  const discovery = f.discover();
  assert.equal(discovery.status, 'ok');
  const profile = discovery.profiles[0];
  assert.deepEqual(profile.args, ['--channels', channel]);
  assert.equal(profile.unrestricted, false);
  assert.equal(account.validateLauncher({ id: profile.id, fingerprint: profile.fingerprint }, 'claude', discovery).unrestricted, false);

  for (const value of ['plugin:other@claude-plugins-official', 'plugin:telegram@attacker', '--dangerously-bypass-approvals-and-sandbox']) {
    fs.writeFileSync(f.file, `function dc() {\n command claude --channels ${value} "$@"\n}`);
    assert.equal(f.discover().status, 'failed', value);
  }
});
for (const id of Object.keys(defs)) test(`${id}: fake executable records exact argv and isolated account home`, (t) => {
  const f = fixture(t); const pick = f.pick(id);
  const provider = id.startsWith('dcx') ? 'codex' : 'claude';
  account.saveLauncherPick(f.root, 'agent', pick, 'jim');
  const p = account.resolveLauncherForSpawn({ root: f.root, agentId: 'jim', provider, isGod: false, isTemp: false }, f.discover());
  const binDir = path.join(f.home, 'bin'); fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, provider), '#!/bin/sh\nprintf "%s\\n" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" "$@"\n', { mode: 0o700 });
  const accountEnv = account.launcherEnvironment(p);
  const expectedHome = path.join(f.home, provider === 'claude' ? id === 'dcm' ? '.claude-minion' : '.claude' : id === 'dcxm' ? '.codex-minion' : '.codex');
  assert.equal(accountEnv[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'], expectedHome);
  const result = spawnSync(p.bin, [...p.args, '--model', 'fixture-model', '--resume', 'fixture-session'], { env: { PATH: binDir + ':/usr/bin:/bin', CLAUDE_CONFIG_DIR: 'inherited-wrong', CODEX_HOME: 'inherited-wrong', ...accountEnv }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[provider === 'claude' ? 0 : 1], expectedHome);
  assert.deepEqual(lines.slice(2), [...p.args, '--model', 'fixture-model', '--resume', 'fixture-session']);
  const metadata = account.publicDiscovery(f.discover());
  assert.doesNotMatch(JSON.stringify(metadata), new RegExp(f.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
test('orchestrator, agent restore and temp defaults persist independently, no registry/config changes', (t) => {
  const f = fixture(t);
  account.saveLauncherPick(f.root, 'orchestrator', f.pick('dcm'));
  account.saveLauncherPick(f.root, 'temps', f.pick('dcxm'));
  account.saveLauncherPick(f.root, 'agent', f.pick('dc'), 'jim');
  const resolve = (extra) => account.resolveLauncherForSpawn({ root: f.root, provider: 'claude', isGod: false, isTemp: false, isNew: true, ...extra }, f.discover());
  assert.equal(resolve({ agentId: 'god', isGod: true }).id, 'dcm');
  assert.equal(resolve({ agentId: 'jim' }).id, 'dc');
  assert.equal(resolve({ agentId: 'worker-1', isTemp: true, provider: 'codex' }).id, 'dcxm');
  // A saved pick for another engine is ignored: that engine's default account (owner run of ceeb4aaf).
  assert.equal(resolve({ agentId: 'worker-1', isTemp: true, provider: 'claude' }), undefined);
  assert.equal(resolve({ agentId: 'ordinary' }), undefined);
  assert.equal(resolve({ isGod: true, explicit: null }), undefined);
  assert.equal(fs.existsSync(path.join(f.root, 'registry.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'config.json')), false);
  const file = path.join(f.root, 'council/extensions/account-launchers.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); parsed.version = 99; fs.writeFileSync(file, JSON.stringify(parsed));
  assert.throws(() => account.readLauncherState(f.root), /unsupported/);
  assert.equal(resolve({ explicit: null }), undefined);
});
test('missing authentication home fails before spawn; resume never searches another home', (t) => {
  const f = fixture(t); const pick = f.pick('dcxm');
  fs.rmdirSync(path.join(f.home, '.codex-minion'));
  assert.throws(() => account.resolveLauncherForSpawn({ root: f.root, explicit: pick, provider: 'codex', isGod: false, isTemp: false }, f.discover()), /Authenticate/);
  const main = path.join(f.home, '.codex'); fs.mkdirSync(path.join(main, 'sessions/2026'), { recursive: true });
  fs.writeFileSync(path.join(main, 'sessions/2026/rollout-fixture-session.jsonl'), '{}');
  assert.equal(account.launcherSessionExists(main, 'codex', 'fixture-session'), true);
  assert.equal(account.launcherSessionExists(path.join(f.home, '.codex-minion'), 'codex', 'fixture-session'), false);
  assert.equal(account.launcherSessionExists(main, 'codex', '../escape'), false);
});
function teamFixture(f) {
  const launched = [], events = [];
  const deps = { tasks: () => ({ tasks: [] }), agents: () => ({ jim: { provider: 'claude' } }), appendEvent: (e) => events.push(e), publish: () => {}, team: {
    hiveRoot: () => f.root, launcherDiscovery: f.discover, modelCatalog: () => ({ version: 1, providers: { claude: [{ id: 'claude-fixture', label: 'Fixture' }], codex: [{ id: 'gpt-fixture', label: 'Fixture' }] } }), appVersion: '0.5.5', defaultModel: () => undefined,
    orchestratorProvider: () => 'claude', orchestratorModel: () => undefined, orchestratorId: () => undefined, hasLivePty: () => false, defaultCommand: () => 'claude', autoMode: () => false, defaultCwd: () => f.home, isDirectory: () => true, commandAvailable: () => true,
    spawnHire: async (spawn) => { launched.push(spawn); return { ok: true }; }
  } };
  return { deps, launched, events, run: (cmd) => dispatchParamount(cmd, deps) };
}
test('team models expose only the selected account identity needed for inline sign-in recovery', (t) => {
  const f = fixture(t); const team = teamFixture(f);
  const pick = f.pick('dcm');
  account.saveLauncherPick(f.root, 'agent', pick, 'jim');
  const result = team.run({ type: 'team.models' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.agents.jim.launcher, { id: 'dcm', fingerprint: pick.fingerprint, label: 'dcm · Alternate' });
  assert.equal(result.models.agents.jim.accountSelection, 'selected');
  assert.doesNotMatch(JSON.stringify(result.models), /accountHome|token|credential/i);
});
test('team.models preserves stale account identity and never reports it as provider default', (t) => {
  const f = fixture(t); const team = teamFixture(f); const pick = f.pick('dcm');
  account.saveLauncherPick(f.root, 'agent', pick, 'jim');
  f.write(['dc']);
  const result = team.run({ type: 'team.models' });
  assert.equal(result.ok, true);
  assert.equal(result.models.agents.jim.accountSelection, 'stale');
  assert.deepEqual(result.models.agents.jim.launcher, { id: 'dcm', fingerprint: pick.fingerprint, label: 'dcm (saved selection)' });
  assert.equal(result.models.agents.jim.installed, true, 'CLI availability remains separate from selected-account availability');
});
test('team.models distinguishes unreadable saved selection from provider default', (t) => {
  const f = fixture(t); const team = teamFixture(f); const pick = f.pick('dcm');
  account.saveLauncherPick(f.root, 'agent', pick, 'jim');
  fs.writeFileSync(path.join(f.root, 'council/extensions/account-launchers.json'), '{"version":99,"agents":{}}');
  const result = team.run({ type: 'team.models' });
  assert.equal(result.ok, true);
  assert.equal(result.models.agents.jim.accountSelection, 'unavailable');
  assert.equal(result.models.agents.jim.launcher, undefined);
});
test('hire boundary validates profile/model, passes selection into real spawn adapter, and revalidates confirmation', async (t) => {
  const f = fixture(t); const team = teamFixture(f);
  const launcher = f.pick('dcm'); const cmd = { type: 'agent.hire', manifest: { spec: 'munder-difflin/hire@1', name: 'Fixture', provider: 'claude', model: 'claude-fixture' }, launcher };
  const preview = await team.run(cmd); assert.equal(preview.ok, true); assert.match(preview.hire.launcher, /dcm/); assert.equal(team.launched.length, 0);
  const started = await team.run({ ...cmd, confirm: true }); assert.equal(started.ok, true); assert.deepEqual(team.launched[0].launcher, launcher);
  // A launcher for another engine falls back to this engine's default, with a note (owner run of ceeb4aaf).
  // An explicit cross-engine model on an ordinary hire is still refused (review row 16).
  assert.equal((await team.run({ ...cmd, manifest: { ...cmd.manifest, model: 'gpt-fixture' } })).ok, false);
  const wrongLauncher = await team.run({ ...cmd, manifest: { ...cmd.manifest, provider: 'codex', model: 'gpt-fixture' } });
  assert.equal(wrongLauncher.ok, true); assert.equal(wrongLauncher.hire.launcher, undefined); assert.match(wrongLauncher.hire.notes.join(' '), /Launcher dcm runs .*, not /);
  f.write([]); const result = await team.run({ ...cmd, confirm: true }); assert.equal(result.ok, false); assert.match(result.errorId, /\S/); assert.equal(team.launched.length, 1);
});
test('first-run setup writes only Council launcher extension and baseline patch; snapshots expose discovered choices', (t) => {
  const f = fixture(t); const patches = [];
  const setup = { launcherDiscovery: f.discover, config: () => ({}), engines: () => [{ id: 'claude', label: 'Claude', installed: true, orchestrator: true, models: ['claude-fixture'] }], suggestedHome: () => f.home, ensureHome: () => ({ ok: true }), complete: (p) => patches.push(p), appendEvent: () => {}, publish: () => {} };
  const deps = { ...teamFixture(f).deps, floorSetup: setup };
  assert.equal(floorSetupState(setup).launchers.choices.length, 4);
  const result = dispatchParamount({ type: 'setup.complete', home: f.home, engine: 'claude', launcher: f.pick('dcm') }, deps);
  assert.equal(result.ok, true); assert.equal(account.readLauncherState(f.root).orchestrator.id, 'dcm');
  assert.equal('launcher' in patches[0], false);
});
test('runtime wiring uses common profile resolver before provisioning and preserves selected homes', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const core = code.slice(code.indexOf('async function spawnAgentCore'), code.indexOf("ipcMain.handle('paramount:dispatch'"));
  assert.ok(core.indexOf('resolveLauncherForSpawn(') < core.indexOf('await hive.ensureAgent('));
  assert.match(core, /preserveAccountHome: !!account/);
  assert.match(core, /if \(account\) opts.env = .*launcherEnvironment\(account\)/);
  assert.match(core, /account \? \(launcherSessionExists\(account.home/);
  assert.match(core, /councilLauncher: launcher/);
});

test('shell precedence and conditional definitions determine availability', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'if false; then\nalias dc="claude"\nfi');
  assert.equal(f.discover().status, 'ok'); assert.equal(f.discover().choices.length, 0);
  fs.writeFileSync(f.file, 'function dc() { command claude --dangerously-skip-permissions "$@"; }\nalias dc="claude"');
  const d = f.discover(); assert.equal(d.status, 'ok'); assert.equal(d.choices.length, 1); assert.equal(d.choices[0].unrestricted, false);
});
test('selected accounts remove inherited credentials after all PTY environment layers; baseline keeps its behavior', () => {
  const { buildPtyEnv } = load('src/main/ptyEnv.ts');
  const parent = { OPENAI_API_KEY: 'private-token', CLAUDE_CODE_OAUTH_TOKEN: 'other-token', CODEX_HOME: '/wrong' };
  const env = buildPtyEnv(parent, '/bin', { CODEX_HOME: '/selected', OPENAI_API_KEY: 'injected-token' }, 'darwin', account.LAUNCHER_AUTH_ENV);
  assert.equal(env.CODEX_HOME, '/selected'); assert.equal('OPENAI_API_KEY' in env, false); assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false);
  assert.equal(buildPtyEnv(parent, '/bin').OPENAI_API_KEY, 'private-token');
  assert.deepEqual(parent, { OPENAI_API_KEY: 'private-token', CLAUDE_CODE_OAUTH_TOKEN: 'other-token', CODEX_HOME: '/wrong' });
});
test('corrupt extension settings report failure without taking baseline model choices away', (t) => {
  const f = fixture(t); account.saveLauncherPick(f.root, 'temps', f.pick('dcxm'));
  fs.writeFileSync(path.join(f.root, 'council/extensions/account-launchers.json'), '{"version":99,"agents":{}}');
  const team = teamFixture(f); const result = team.run({ type: 'team.models' });
  assert.equal(result.ok, true); assert.equal(result.models.launchers.status, 'failed'); assert.ok(result.models.engines.length > 0); assert.equal(result.models.launcherState, undefined);
});
for (const keys of [[], ['dcm'], ['dcx', 'dcxm'], Object.keys(defs)]) test(`live shell table probe: ${keys.join(',') || 'absent'}; launchers are never invoked`, (t) => {
  const f = fixture(t, keys);
  const bin = path.join(f.home, 'bin'); fs.mkdirSync(bin);
  const marker = path.join(f.home, 'launcher-was-executed');
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  const probe = (shell, script, timeout) => {
    const result = spawnSync(shell, ['-d', '-ic', script], { env: { HOME: f.home, ZDOTDIR: f.home, PATH: bin + ':/usr/bin:/bin', TERM: 'dumb' }, encoding: 'utf8', timeout, maxBuffer: 256000 });
    return { stdout: result.stdout, status: result.status, error: result.error };
  };
  const d = account.discoverShellLaunchers(probe, 2000, f.home, '/bin/zsh');
  assert.equal(d.status, 'ok'); assert.deepEqual(d.choices.map((c) => c.id), keys); assert.equal(fs.existsSync(marker), false);
  if (keys.includes('dcm')) {
    const pick = { ...d.choices.find((c) => c.id === 'dcm'), allowUnrestricted: true };
    const selection = { id: pick.id, fingerprint: pick.fingerprint, allowUnrestricted: true };
    fs.appendFileSync(f.file, '\nunfunction dcm\n');
    const removed = account.discoverShellLaunchers(probe, 2000, f.home, '/bin/zsh');
    assert.equal(removed.status, 'ok'); assert.throws(() => account.validateLauncher(selection, 'claude', removed), /no longer available/);
  }
});
test('live table probe suppresses startup chatter, fails partial output, timeout and unsupported shells explicitly', () => {
  const failed = account.discoverShellLaunchers(() => ({ stdout: 'private@example.test API_KEY=do-not-print', status: 1 }), 1, '/fake', '/bin/zsh');
  assert.equal(failed.status, 'failed'); assert.doesNotMatch(JSON.stringify(failed), /private@|do-not-print/);
  const timeout = account.discoverShellLaunchers(() => ({ stdout: '', status: null, error: { code: 'ETIMEDOUT' } }), 1, '/fake', '/bin/zsh');
  assert.equal(timeout.status, 'timeout'); assert.equal(timeout.choices.length, 0);
  assert.equal(account.discoverShellLaunchers(() => ({ stdout: '', status: 0 }), 1, '/fake', '/bin/zsh').status, 'failed');
  assert.equal(account.discoverShellLaunchers(undefined, 1, '/fake', '/bin/fish').status, 'failed');
});
test('bash function/alias introspection uses the same validated profile format', (t) => {
  const f = fixture(t); fs.copyFileSync(f.file, path.join(f.home, '.bashrc'));
  const probe = (shell, script, timeout) => {
    const result = spawnSync(shell, ['--noprofile', '-ic', script], { env: { HOME: f.home, PATH: '/usr/bin:/bin', TERM: 'dumb' }, encoding: 'utf8', timeout });
    return { stdout: result.stdout, status: result.status, error: result.error };
  };
  const d = account.discoverShellLaunchers(probe, 2000, f.home, '/bin/bash');
  assert.equal(d.status, 'ok'); assert.equal(d.choices.length, 4);
});
test('invalid false/empty selections cannot silently become the provider default', async (t) => {
  const f = fixture(t); const team = teamFixture(f);
  for (const launcher of [false, '', 0, {}, { id: 'dc' }]) {
    assert.throws(() => account.resolveLauncherForSpawn({ root: f.root, explicit: launcher, isGod: false, isTemp: false, provider: 'claude' }, f.discover()), /launcher|selection/i);
    const result = await team.run({ type: 'agent.hire', manifest: { spec: 'munder-difflin/hire@1', name: 'Bad', provider: 'claude' }, launcher });
    assert.equal(result.ok, false); assert.equal(team.launched.length, 0);
  }
});
test('account-home mode skips Codex credential copying/hook installation; baseline injection stays unchanged', async (t) => {
  const f = fixture(t);
  const { HiveManager } = load('src/main/hive.ts');
  const hive = new HiveManager(() => f.home);
  let installs = 0;
  hive.installCodexHooks = () => { installs++; return path.join(f.home, 'fake-agent-codex-home'); };
  const selected = await hive.ensureAgent({ id: 'selected-account', name: 'Fixture', provider: 'codex', cwd: f.home }, { preserveAccountHome: true });
  assert.equal(installs, 0); assert.equal(selected.env.CODEX_HOME, undefined);
  assert.ok(!selected.args.includes('--dangerously-bypass-hook-trust'));
  assert.match(selected.degraded, /account home preserved/);
  assert.match(selected.args.at(-1), /HIVE PROTOCOL/);
  const baseline = await hive.ensureAgent({ id: 'baseline-account', name: 'Fixture', provider: 'codex', cwd: f.home });
  assert.equal(installs, 1); assert.ok(baseline.args.includes('--dangerously-bypass-hook-trust'));
  assert.equal(baseline.env.CODEX_HOME, path.join(f.home, 'fake-agent-codex-home'));
});
test('a main agent with a legacy id saves the orchestrator profile used by automatic startup', (t) => {
  const f = fixture(t); const team = teamFixture(f);
  team.deps.agents = () => ({ michael: { provider: 'claude', isGod: true } });
  team.deps.team.orchestratorId = () => 'michael';
  const result = team.run({ type: 'launchers.configure', scope: 'agent', agentId: 'michael', launcher: f.pick('dcm') });
  assert.equal(result.ok, true); assert.equal(account.readLauncherState(f.root).orchestrator.id, 'dcm');
  const models = team.run({ type: 'team.models' }); assert.equal(models.models.orchestratorId, 'michael');
  assert.equal(account.resolveLauncherForSpawn({ root: f.root, agentId: 'michael', isGod: true, isTemp: false, provider: 'claude' }, f.discover()).id, 'dcm');
  assert.equal(account.launcherDisplayCommand('/home/private@example.test/claude --model fixture'), '/home/[redacted-email]/claude --model fixture');
});
test('provider and account are derived from the resolved definition rather than the alias spelling', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'alias dc=\'env CODEX_HOME=$HOME/.codex-minion codex\'\nalias dcxm=\'claude\'\n');
  const d = f.discover(); assert.equal(d.status, 'ok');
  assert.deepEqual(d.choices.map((c) => [c.id, c.provider, c.label]), [['dc', 'codex', 'dc · Alternate'], ['dcxm', 'claude', 'dcxm · Main']]);
  assert.throws(() => account.validateLauncher(f.pick('dc'), 'claude', d), /provider/);
});
test('first-run defaults persist for new agents/temps; existing baseline accounts never switch implicitly', (t) => {
  const f = fixture(t); const dcm = f.pick('dcm'), dcxm = f.pick('dcxm');
  const patches = [];
  const deps = { ...teamFixture(f).deps, floorSetup: { launcherDiscovery: f.discover, config: () => ({}), suggestedHome: () => f.home,
    engines: () => [{ id: 'claude', label: 'Claude', orchestrator: true, installed: true, models: [] }], ensureHome: () => ({ ok: true }), complete: (p) => patches.push(p), appendEvent() {}, publish() {} } };
  const cmd = { type: 'setup.complete', home: f.home, engine: 'claude', launcher: dcm, launcherDefaults: { claude: dcm, codex: dcxm }, tempLauncher: dcxm };
  assert.equal(dispatchParamount(cmd, deps).ok, true);
  const state = account.readLauncherState(f.root); assert.deepEqual(state.defaults, { claude: dcm, codex: dcxm }); assert.deepEqual(state.temps, dcxm);
  const input = { root: f.root, agentId: 'new-worker', provider: 'claude', isGod: false, isTemp: false, isNew: true };
  assert.equal(account.resolveLauncherForSpawn(input, f.discover()).id, 'dcm');
  assert.equal(account.resolveLauncherForSpawn({ ...input, isNew: false }, f.discover()), undefined);
  assert.equal(account.resolveLauncherForSpawn({ ...input, provider: 'codex', isTemp: true }, f.discover()).id, 'dcxm');
  assert.equal('launcherDefaults' in patches[0], false); assert.equal(patches[0].godModel, '');
  assert.equal(dispatchParamount({ ...cmd, launcherDefaults: { claude: dcxm } }, deps).ok, false);
  f.write(['dc']); assert.equal(dispatchParamount(cmd, deps).ok, false);
});
test('Settings default reconfiguration validates actual provider and preserves other defaults', (t) => {
  const f = fixture(t); const team = teamFixture(f);
  assert.equal(team.run({ type: 'launchers.configure', scope: 'default', provider: 'claude', launcher: f.pick('dcm') }).ok, true);
  assert.equal(team.run({ type: 'launchers.configure', scope: 'default', provider: 'codex', launcher: f.pick('dcxm') }).ok, true);
  assert.equal(team.run({ type: 'launchers.configure', scope: 'default', provider: 'claude', launcher: f.pick('dcxm') }).ok, false);
  assert.equal(team.run({ type: 'launchers.configure', scope: 'default', provider: 'claude', launcher: null }).ok, true);
  assert.equal(account.readLauncherState(f.root).defaults.claude, undefined); assert.equal(account.readLauncherState(f.root).defaults.codex.id, 'dcxm');
});
test('bare aliases retain the shell-resolved account home; changed environment requires reselection', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'export CLAUDE_CONFIG_DIR="$HOME/.claude-minion"\nalias dc=\'claude\'\n');
  const d = f.discover(); assert.equal(d.status, 'ok'); assert.equal(d.profiles[0].home, path.join(f.home, '.claude-minion')); assert.equal(d.choices[0].label, 'dc · Alternate');
  const pick = f.pick('dc'); fs.writeFileSync(f.file, 'alias dc=\'claude\'\n');
  assert.throws(() => account.validateLauncher(pick, 'claude', f.discover()), /changed/);
});

// Owner run of ceeb4aaf (failures/2026-11-12T2126-ceeb4aaf-hire-orchestrator): the Studio floor's god is
// registered on claude, Council's settings say godProvider codex, and the saved orchestrator launcher is
// dcxm (Codex). Every orchestrator start and hire failed ("Selected launcher does not match this
// provider" x9, "Pick one model supported by this provider" x4).
test('a claude god with godProvider codex and a Codex orchestrator launcher starts on claude; hires work', async (t) => {
  const f = fixture(t); const team = teamFixture(f);
  account.saveLauncherPick(f.root, 'orchestrator', f.pick('dcxm'));
  account.saveLauncherPick(f.root, 'temps', f.pick('dcxm'));
  const agents = { god: { name: 'Paramount', provider: 'claude', isGod: true, role: 'Paramount orchestrator' } };
  Object.assign(team.deps, { agents: () => agents });
  Object.assign(team.deps.team, { orchestratorProvider: () => 'codex', orchestratorModel: () => undefined, orchestratorId: () => 'god', setupComplete: () => true });
  // What the hire sheet shows for the orchestrator: the registered god's engine, and why dcxm is ignored.
  const models = await team.run({ type: 'team.models' });
  assert.equal(models.ok, true);
  assert.equal(models.models.orchestratorProvider, 'claude');
  assert.equal(models.models.orchestratorConfiguredProvider, 'codex');
  assert.match(models.models.orchestratorLauncherNote, /dcxm runs .* It is ignored/);
  // Automatic start: on claude, without the Codex launcher.
  const ensured = await team.run({ type: 'orchestrator.ensure' });
  assert.equal(ensured.ok, true, JSON.stringify(ensured));
  assert.equal(team.launched.length, 1);
  assert.equal(team.launched[0].provider, 'claude');
  assert.equal(team.launched[0].launcher, null, "claude's default account");
  // The sheet's old payload (Codex launcher and model) for the orchestrator: claude, with notes.
  agents.god.archived = true;
  const fromSheet = await team.run({ type: 'agent.hire', orchestrator: true, confirm: false, launcher: f.pick('dcxm'), manifest: { spec: 'munder-difflin/hire@1', name: 'Paramount', provider: 'codex', model: 'gpt-fixture' } });
  assert.equal(fromSheet.ok, true, JSON.stringify(fromSheet));
  assert.equal(fromSheet.hire.engine, 'claude');
  assert.equal(fromSheet.hire.launcher, undefined);
  assert.equal(fromSheet.hire.notes.length, 2);
  // A claude hire with the Codex temps launcher saved: hired on claude's default account.
  const hire = await team.run({ type: 'agent.hire', confirm: true, launcher: f.pick('dcxm'), manifest: { spec: 'munder-difflin/hire@1', name: 'Worker', provider: 'claude' } });
  assert.equal(hire.ok, true, JSON.stringify(hire));
  assert.equal(team.launched.at(-1).provider, 'claude');
  assert.equal(team.launched.at(-1).launcher, null);
  // Setting the orchestrator launcher is checked against the god's engine, not the configured one.
  assert.equal((await team.run({ type: 'launchers.configure', scope: 'orchestrator', launcher: f.pick('dcxm') })).ok, false);
  assert.equal((await team.run({ type: 'launchers.configure', scope: 'orchestrator', launcher: f.pick('dcm') })).ok, true);
});

test('the god never falls back to the new-agent default launcher: its session lives in the account it ran in', async (t) => {
  // Isolated check of b22e04ed on a copy of the Studio floor: the Codex orchestrator launcher was ignored,
  // but the god fell back to claude's new-agent default dcm (another account), and its resume was refused
  // ("Session is unavailable in the selected account").
  const f = fixture(t); const team = teamFixture(f);
  account.saveLauncherPick(f.root, 'orchestrator', f.pick('dcxm'));
  account.saveLauncherPick(f.root, 'default', f.pick('dcm'), 'claude');
  const agents = { god: { name: 'Frodzy', provider: 'claude', isGod: true, sessionId: 's-1' } };
  Object.assign(team.deps, { agents: () => agents });
  Object.assign(team.deps.team, { orchestratorProvider: () => 'codex', orchestratorId: () => 'god', setupComplete: () => true });
  assert.equal((await team.run({ type: 'orchestrator.ensure' })).ok, true);
  assert.equal(team.launched[0].launcher, null, "the CLI's own default account, not dcm");
  // Used for this start only: the owner's saved orchestrator launcher is not overwritten by the fallback.
  assert.equal(team.launched[0].saveLauncher, false);
  assert.equal(account.readLauncherState(f.root).orchestrator.id, 'dcxm');
  const index = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.match(index, /if \(launcher !== undefined && saveLauncher !== false && hive\.root\(\)\) \{\s*try \{ saveLauncherPick\(/);
  // At spawn the same rule: an existing god resolves no launcher; a new claude agent gets dcm.
  const resolve = (extra) => account.resolveLauncherForSpawn({ root: f.root, provider: 'claude', isGod: false, isTemp: false, ...extra }, f.discover());
  assert.equal(resolve({ agentId: 'god', isGod: true, isNew: false }), undefined);
  // A new ordinary claude hire with the Codex launcher sent by the form gets claude's new-agent default.
  const hire = await team.run({ type: 'agent.hire', launcher: f.pick('dcxm'), manifest: { spec: 'munder-difflin/hire@1', name: 'Worker', provider: 'claude' } });
  assert.equal(hire.ok, true); assert.match(hire.hire.launcher, /dcm/); assert.match(hire.hire.notes[0], /default launcher dcm/);
});
