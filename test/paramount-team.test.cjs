'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { dispatchParamount } = loadTs('src/main/paramount.ts');
const { nextCardKey, uniqueAgentId, readAgentModels, agentModelPick } = loadTs('src/main/paramount-team.ts');

const CATALOG = {
  version: 1,
  providers: {
    claude: [
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-future', label: 'Future', minAppVersion: '9.0.0' }
    ],
    codex: [{ label: 'CLI default' }, { id: 'gpt-x', label: 'GPT X' }]
  }
};

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-team-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-team-cwd-'));
  const state = {
    tasks: [{ id: 'NSC-1' }, { id: 'NSC-7' }, { id: 'OLD-40' }],
    agents: { jim: { name: 'Jim', provider: 'claude' }, pam: { name: 'Pam', provider: 'codex' } },
    events: [], steps: [], spawned: []
  };
  const team = {
    hiveRoot: () => root,
    addTask: (task) => { if (state.tasks.some((t) => t.id === task.id)) return false; state.tasks.push(task); return true; },
    modelCatalog: () => CATALOG,
    appVersion: '0.5.5',
    defaultModel: () => 'claude-sonnet-4-6',
    defaultCommand: () => 'claude',
    autoMode: () => false,
    defaultCwd: () => work,
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    commandAvailable: () => true,
    spawnHire: async (spawn) => { state.spawned.push(spawn); return { ok: true }; },
    ...overrides
  };
  const deps = {
    tasks: () => ({ tasks: state.tasks }),
    agents: () => state.agents,
    appendEvent: (event) => state.events.push(event),
    publish: () => {},
    logStep: (step) => state.steps.push(step),
    team
  };
  return { state, deps, root, work };
}

test('card.create adds the next key on the ledger prefix and emits one event', () => {
  const { state, deps } = fixture();
  const result = dispatchParamount({ type: 'card.create', title: 'Fix the build', assignee: 'jim', priority: 1 }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.card.key, 'NSC-8');
  const card = state.tasks.find((t) => t.id === 'NSC-8');
  assert.equal(card.title, 'Fix the build');
  assert.equal(card.assignee, 'jim');
  assert.equal(card.status, 'todo');
  assert.equal(state.events.length, 1);
});

test('card.create rejects bad input with an errorId and code', () => {
  const { state, deps } = fixture();
  for (const command of [
    { type: 'card.create', title: '  ' },
    { type: 'card.create', title: 'x', priority: 9 },
    { type: 'card.create', title: 'x', status: 'done' },
    { type: 'card.create', title: 'x', token: 'secret' }
  ]) {
    const result = dispatchParamount(command, deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_INPUT');
    assert.match(result.errorId, /\S/);
  }
  assert.equal(dispatchParamount({ type: 'card.create', title: 'x', assignee: 'ghost' }, deps).code, 'NOT_FOUND');
  assert.equal(state.events.length, 0);
});

test('card.create without team deps is UNSUPPORTED, not silently ignored', () => {
  const { deps } = fixture();
  delete deps.team;
  const result = dispatchParamount({ type: 'card.create', title: 'x' }, deps);
  assert.equal(result.code, 'UNSUPPORTED');
});

test('nextCardKey follows the most used prefix and starts at P-1', () => {
  assert.equal(nextCardKey([]), 'P-1');
  assert.equal(nextCardKey(['A-1', 'A-2', 'B-9']), 'A-3');
  assert.equal(nextCardKey(['free-form', 'X-10']), 'X-11');
});

test('configured ticket prefix only advances keys in that namespace', () => {
  assert.equal(nextCardKey(['NSC-9', 'LAB-2', 'LAB-5'], 'LAB'), 'LAB-6');
  const { deps } = fixture({ ticketKeyPrefix: () => 'LAB' });
  const result = dispatchParamount({ type: 'card.create', title: 'Check launch' }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.card.key, 'LAB-1');
});

test('team.models lists engines from the catalog, filtered by version, with the default and picks', () => {
  const { deps } = fixture();
  const result = dispatchParamount({ type: 'team.models' }, deps);
  assert.equal(result.ok, true);
  const claude = result.models.engines.find((e) => e.id === 'claude');
  assert.deepEqual(claude.models.map((m) => m.id), ['claude-sonnet-4-6', 'claude-opus-4-8']);
  assert.equal(result.models.defaultModel, 'claude-sonnet-4-6');
  assert.deepEqual(result.models.agents.jim, { engine: 'claude' });
  assert.deepEqual(result.models.agents.pam, { engine: 'codex' });
});

test('agent.update model saves a pick that the spawn path reads, and empty clears it', () => {
  const { state, deps, root } = fixture();
  const set = dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { model: 'claude-opus-4-8' } }, deps);
  assert.equal(set.ok, true);
  assert.equal(agentModelPick(root, 'jim'), 'claude-opus-4-8');
  assert.deepEqual(dispatchParamount({ type: 'team.models' }, deps).models.agents.jim, { engine: 'claude', model: 'claude-opus-4-8' });
  const clear = dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { model: '' } }, deps);
  assert.equal(clear.ok, true);
  assert.equal(agentModelPick(root, 'jim'), undefined);
  assert.equal(state.events.length, 3);
});

test('agent.update model refuses unknown models, other engines and mixed patches', () => {
  const { deps } = fixture();
  assert.equal(dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { model: 'gpt-x' } }, deps).code, 'INVALID_INPUT');
  assert.equal(dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { model: 'gpt-x', engine: 'codex' } }, deps).code, 'UNSUPPORTED');
  assert.equal(dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { model: 'claude-opus-4-8', name: 'J' } }, deps).code, 'INVALID_INPUT');
  assert.equal(dispatchParamount({ type: 'agent.update', agentId: 'nobody', patch: { model: 'claude-opus-4-8' } }, deps).code, 'NOT_FOUND');
  // A non-model agent.update still goes to the core handler.
  const rename = dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { color: 'red' } }, { ...deps, renameAgent: () => ({ ok: true }) });
  assert.equal(rename.code, 'UNSUPPORTED');
});

test('a corrupt picks file is reported, never reset silently', () => {
  const { deps, root } = fixture();
  fs.writeFileSync(path.join(root, 'paramount-agent-models.json'), '[]');
  assert.throws(() => readAgentModels(root), /corrupt/);
  const result = dispatchParamount({ type: 'team.models' }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INTERNAL');
});

test('agent.hire without confirm returns the plan and spawns nothing', () => {
  const { state, deps, work } = fixture();
  const result = dispatchParamount({ type: 'agent.hire', manifest: { spec: 'munder-difflin/hire@1', name: 'Jim', description: 'Reviewer', model: 'claude-opus-4-8', skills: ['md-audit'] } }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.hire.confirmed, false);
  assert.equal(result.hire.agentId, 'jim-2');
  assert.equal(result.hire.cwd, work);
  assert.match(result.hire.command, /^claude .*--model claude-opus-4-8/);
  assert.deepEqual(result.hire.ignored, ['skills']);
  assert.equal(state.spawned.length, 0);
});

test('agent.hire with confirm spawns once and delivers the goal through spawnHire', async () => {
  const { state, deps } = fixture();
  const result = await dispatchParamount({ type: 'agent.hire', confirm: true, manifest: { spec: 'munder-difflin/hire@1', name: 'Dwight', goal: 'Sell paper', provider: 'codex' } }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.hire.confirmed, true);
  assert.equal(state.spawned.length, 1);
  assert.equal(state.spawned[0].bin, 'codex');
  assert.equal(state.spawned[0].goal, 'Sell paper');
  assert.equal(state.events.length, 1);
});

test('agent.hire refuses invalid manifests, missing folders, missing CLIs and failed spawns', async () => {
  const bad = fixture();
  assert.equal(dispatchParamount({ type: 'agent.hire', manifest: { name: 'No spec' } }, bad.deps).code, 'INVALID_INPUT');
  assert.equal(dispatchParamount({ type: 'agent.hire', manifest: { spec: 'munder-difflin/hire@1', name: 'A', commandFlags: ['--dangerously-skip-permissions'] } }, bad.deps).code, 'INVALID_INPUT');
  assert.equal(dispatchParamount({ type: 'agent.hire', cwd: '/definitely/not/here', manifest: { spec: 'munder-difflin/hire@1', name: 'A' } }, bad.deps).code, 'INVALID_INPUT');
  const noCli = fixture({ commandAvailable: () => false });
  const missing = await dispatchParamount({ type: 'agent.hire', confirm: true, manifest: { spec: 'munder-difflin/hire@1', name: 'A' } }, noCli.deps);
  assert.equal(missing.code, 'UNSUPPORTED');
  assert.equal(noCli.state.spawned.length, 0);
  const broken = fixture({ spawnHire: async () => ({ ok: false, error: 'pty exploded' }) });
  const failed = await dispatchParamount({ type: 'agent.hire', confirm: true, manifest: { spec: 'munder-difflin/hire@1', name: 'A' } }, broken.deps);
  assert.equal(failed.code, 'INTERNAL');
  assert.match(failed.message, /pty exploded/);
  assert.equal(broken.state.events.length, 0);
});

test('uniqueAgentId never reuses a registry id', () => {
  assert.equal(uniqueAgentId('Jim Halpert', []), 'jim-halpert');
  assert.equal(uniqueAgentId('Jim', ['jim', 'jim-2']), 'jim-3');
  assert.equal(uniqueAgentId('!!!', []), 'agent');
});
