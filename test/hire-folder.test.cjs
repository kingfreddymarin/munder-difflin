'use strict';
// Owner hit 2026-11-12 (E-mwdspis5-11325983): hiring with an empty Folder failed with
// 'Choose the folder the agent works in' because a non-orchestrator hire fell back to the first
// registered repo and there were none. Owner decision: an empty folder is the floor root for every
// hire (the gated floor home), as for the orchestrator.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { dispatchParamount } = loadTs('src/main/paramount.ts');
const INDEX = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');

function deps(t, floorRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-hire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spawned = [];
  const team = {
    launcherDiscovery: () => ({ status: 'ok', choices: [], profiles: [] }), hiveRoot: () => root,
    modelCatalog: () => ({ version: 1, providers: { claude: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }] } }), appVersion: '0.5.7',
    defaultModel: () => undefined, orchestratorProvider: () => 'claude', orchestratorModel: () => undefined, orchestratorId: () => undefined,
    hasLivePty: () => false, defaultCommand: () => 'claude', autoMode: () => false,
    // As index.ts wires it now: the gated floor home for every hire, with no registered repos.
    defaultCwd: () => floorRoot,
    isDirectory: (p) => fs.existsSync(p), commandAvailable: () => true,
    spawnHire: async (spawn) => { spawned.push(spawn); return { ok: true }; },
  };
  return { spawned, deps: { tasks: () => ({ tasks: [] }), agents: () => ({}), appendEvent() {}, publish() {}, logStep() {}, team } };
}
const hire = { type: 'agent.hire', confirm: true, manifest: { spec: 'munder-difflin/hire@1', name: 'Ryan' } };

test('an empty folder with no registered repos hires into the floor root', async (t) => {
  const floorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'council-floor-'));
  t.after(() => fs.rmSync(floorRoot, { recursive: true, force: true }));
  const f = deps(t, floorRoot);
  const r = await dispatchParamount(hire, f.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(f.spawned[0].plan.cwd, floorRoot);
});

test('while another app holds the floor, an empty folder says why instead of guessing', async (t) => {
  const f = deps(t, null);
  const r = await dispatchParamount(hire, f.deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_INPUT');
  assert.match(r.message, /no floor root to use/);
  assert.equal(f.spawned.length, 0);
});

test('index.ts: every hire\'s empty folder is the gated floor home, not the first registered repo', () => {
  assert.match(INDEX, /defaultCwd: \(\) => floorHome\(\),/);
  assert.doesNotMatch(INDEX, /defaultCwd:[^\n]*registeredRepos/);
});
