'use strict';
// NSC-193 (owner repros 2026-11-15: E-mwi8f3qa-979fabff diagnostics, E-mwiafn0z-cc458e0e
// launchers.refresh). A fresh profile in Setup has no harnessHome. The commands Setup really
// sends must work there; everything else must still fail without a floor log.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const obs = loadTs('src/main/paramountObservability.ts');
const { dispatchParamount } = loadTs('src/main/paramount.ts');

const ENGINES = [{ id: 'claude', label: 'Claude Code', orchestrator: true, installed: true, models: ['claude-opus-5-5'] }];

// Mirrors the real wiring: the audit append throws while no floor exists, and
// setup.complete makes the floor exist before it audits.
function world(root) {
  const floor = { root };
  const audited = [];
  const published = [];
  const saves = [];
  const hasFloor = () => floor.root !== null;
  const appendEvent = (e) => { if (!hasFloor()) throw new Error('hive disabled (no harnessHome)'); audited.push(e); };
  const deps = {
    tasks: () => ({ tasks: [] }), patchTask: () => true, missions: () => [], saveMissions: () => {},
    agents: () => ({}), renameAgent: () => ({ ok: true }), setAgentTokenCap: () => {}, setNotifications: () => {},
    savePreference: () => { if (!hasFloor()) throw new Error('hive disabled (no harnessHome)'); },
    appendEvent,
    floorLogAvailable: hasFloor,
    publish: (e) => published.push(e),
    diagnostics: ({ logLines, cid }) => obs.buildDiagnostics({ root: floor.root, app: { version: '0.4.6' }, os: { platform: 'darwin' }, config: { harnessHome: floor.root }, logLines }, cid),
    saveDiagnostics: async (file) => { saves.push(file); return { canceled: false, path: `/picked/${file.name}` }; },
    team: {
      refreshLaunchers: () => {}, hiveRoot: () => floor.root, orchestratorId: () => null,
      modelCatalog: () => [], appVersion: '0.4.6', launcherDiscovery: () => ({ status: 'ok', choices: [], profiles: [] })
    },
    rules: { hiveRoot: () => floor.root },
    floorSetup: {
      launcherDiscovery: () => ({ status: 'ok', choices: [], profiles: [] }),
      config: () => ({ onboardingComplete: false, harnessHome: floor.root }),
      suggestedHome: () => '/tmp/Paramount', engines: () => ENGINES,
      ensureHome: () => ({ ok: true }),
      complete: (patch) => { floor.root = patch.harnessHome; },
      appendEvent,
      publish: (e) => published.push(e)
    }
  };
  return { deps, audited, published, saves };
}

const SETUP_SAFE = [
  ['launchers.refresh', { type: 'launchers.refresh' }],
  ['diagnostics.bundle', { type: 'diagnostics.bundle' }],
  ['diagnostics.save', { type: 'diagnostics.save', name: 'paramount-diagnostics-20261115-202921.json' }],
  // NSC-255: Customize Rules checks draft rules before the floor exists.
  ['rules.check', { type: 'rules.check', rules: [{ text: 'Run the tests before marking a task done.' }] }]
];

test('the pre-floor allowlist is exactly the commands Setup sends that write no floor', () => {
  const { PRE_FLOOR_SETUP_COMMANDS } = loadTs('src/main/paramount-pre-floor.ts');
  assert.deepEqual([...PRE_FLOOR_SETUP_COMMANDS].sort(), SETUP_SAFE.map(([t]) => t).sort());
});

for (const [type, command] of SETUP_SAFE) {
  test(`before a floor: ${type} succeeds, is published, and writes no floor audit`, async () => {
    const w = world(null);
    const result = await dispatchParamount(command, w.deps);
    assert.equal(result.ok, true, `${type}: ${result.code} ${result.message ?? ''}`);
    assert.equal(typeof result.event.correlationId, 'string');
    assert.equal(w.audited.length, 0);
    assert.equal(w.published.length, 1);
  });

  test(`with a floor: ${type} is still audited on the floor log`, async () => {
    const w = world(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-prefloor-')));
    const result = await dispatchParamount(command, w.deps);
    assert.equal(result.ok, true);
    assert.equal(w.audited.length, 1);
    assert.equal(w.audited[0].correlationId, result.event.correlationId);
  });
}

test('before a floor: setup.complete creates the floor and audits on it', async () => {
  const w = world(null);
  const result = await dispatchParamount({ type: 'setup.complete', home: '/tmp/new-floor', engine: 'claude', model: 'claude-opus-5-5' }, w.deps);
  assert.equal(result.ok, true, `${result.code} ${result.message ?? ''}`);
  assert.equal(w.audited.length, 1);
});

// Not sent by Setup, or they write to a floor: no exemption.
const FAIL_CLOSED = [
  { type: 'team.models' },
  { type: 'launchers.configure', scope: 'temps', launcher: null },
  { type: 'setup.dismiss', degraded: [] },
  { type: 'account.notify', id: 'desktop', on: true }
];
for (const command of FAIL_CLOSED) {
  test(`before a floor: ${command.type} still fails with an error id`, async () => {
    const w = world(null);
    const result = await dispatchParamount(command, w.deps);
    assert.equal(result.ok, false, command.type);
    assert.equal(typeof result.errorId, 'string');
    assert.equal(w.audited.length, 0);
    assert.equal(w.published.length, 0);
  });
}
