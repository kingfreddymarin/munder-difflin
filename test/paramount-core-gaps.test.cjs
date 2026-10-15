'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { dispatchParamount } = loadTs('src/main/paramount.ts');

function fixture(overrides = {}) {
  const state = {
    autoMode: false, writes: 0, events: [], steps: [], runs: [],
    missions: [
      { id: 'heartbeat', label: 'Floor heartbeat', intervalMs: 120_000, enabled: false },
      { id: 'ops-standup', label: 'Standup', intervalMs: 3_600_000, enabled: true },
      { id: 'daily', label: 'Daily', intervalMs: 86_400_000, enabled: true }
    ],
    integrations: {
      ado: { enabled: false, needsSecret: false },
      slack: { enabled: false, needsSecret: true, hasSecret: false },
      github: { enabled: false, needsSecret: true, hasSecret: true }
    },
    cli: { claude: { installed: false, kind: 'npm', command: 'npm install -g @anthropic-ai/claude-code' }, codex: { installed: true, kind: 'npm', command: 'npm install -g @openai/codex' }, opencode: { installed: false, kind: 'manual' } },
    spawnOk: true
  };
  const deps = {
    tasks: () => ({ tasks: [] }), patchTask: () => true,
    missions: () => state.missions,
    saveMissions: (missions) => {
      if (process.env.PARAMOUNT_KNOWN_BAD === '1') return;
      state.writes += 1; state.missions = missions;
    },
    agents: () => ({}), renameAgent: () => ({ ok: true }), setAgentTokenCap: () => {}, setNotifications: () => {},
    savePreference: () => {},
    appendEvent: (event) => { state.events.push(event); }, publish: () => {},
    setFloorAutoMode: (on) => { state.writes += 1; state.autoMode = on; },
    setIntegrationConnected: (id, connected) => {
      const r = Object.hasOwn(state.integrations, id) ? state.integrations[id] : null;
      if (!r) return 'not_found';
      if (connected && r.needsSecret && !r.hasSecret) return 'needs_secret';
      state.writes += 1; r.enabled = connected; return 'ok';
    },
    prereqInstall: {
      plan: (id) => Object.hasOwn(state.cli, id) ? { id, label: id, ...state.cli[id] } : null,
      run: (plan) => { state.runs.push(plan.id); return state.spawnOk ? { ok: true, ptyId: `pty-${plan.id}` } : { ok: false, error: 'no pty' }; }
    },
    logStep: (step) => { state.steps.push(step); },
    ...overrides
  };
  return { state, deps };
}
function assertFailure(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.code, code, `${result.code}: ${result.message}`);
  assert.match(result.errorId, /\S/);
  assert.match(result.correlationId, /\S/);
}

// ─── floor.yolo ─────────────────────────────────────────────────────────────
test('floor.yolo persists autoMode and emits one event', () => {
  const { state, deps } = fixture();
  const result = dispatchParamount({ type: 'floor.yolo', patch: { on: true } }, deps);
  assert.equal(result.ok, true);
  assert.equal(state.autoMode, true);
  assert.equal(state.events.length, 1);
  assert.equal(result.event.correlationId, result.event.correlationId);
});

test('floor.yolo rejects fields the fork cannot enforce, with no write (known bad)', () => {
  const { state, deps } = fixture();
  assertFailure(dispatchParamount({ type: 'floor.yolo', patch: { on: true, autoOffHours: 2 } }, deps), 'UNSUPPORTED');
  assertFailure(dispatchParamount({ type: 'floor.yolo', patch: { keepHardRules: true } }, deps), 'UNSUPPORTED');
  assertFailure(dispatchParamount({ type: 'floor.yolo', patch: { on: 'yes' } }, deps), 'INVALID_INPUT');
  assertFailure(dispatchParamount({ type: 'floor.yolo', patch: {} }, deps), 'INVALID_INPUT');
  assertFailure(dispatchParamount({ type: 'floor.yolo' }, deps), 'INVALID_INPUT');
  assert.equal(state.writes, 0);
  assert.equal(state.events.length, 0);
});

test('floor.yolo is unsupported when the build lacks the setter', () => {
  const { deps } = fixture({ setFloorAutoMode: undefined });
  assertFailure(dispatchParamount({ type: 'floor.yolo', patch: { on: true } }, deps), 'UNSUPPORTED');
});

// ─── floor.iteration ────────────────────────────────────────────────────────
test('floor.iteration updates both cadences in one write and leaves other missions alone', () => {
  const { state, deps } = fixture();
  const result = dispatchParamount({ type: 'floor.iteration', patch: { heartbeatSec: 60, standupMin: 30 } }, deps);
  assert.equal(result.ok, true);
  assert.equal(state.writes, 1);
  assert.deepEqual(state.missions.map((m) => m.intervalMs), [60_000, 1_800_000, 86_400_000]);
  assert.equal(state.missions[0].enabled, false, 'enabled flag untouched');
  assert.equal(state.events.length, 1);
});

test('floor.iteration rejects speed, checkpoints, out-of-range and non-integer values (known bad)', () => {
  const { state, deps } = fixture();
  assertFailure(dispatchParamount({ type: 'floor.iteration', patch: { speed: 'fast' } }, deps), 'UNSUPPORTED');
  assertFailure(dispatchParamount({ type: 'floor.iteration', patch: { heartbeatSec: 60, checkpointEverySteps: 1 } }, deps), 'UNSUPPORTED');
  assertFailure(dispatchParamount({ type: 'floor.iteration', patch: { heartbeatSec: 5 } }, deps), 'INVALID_INPUT');
  assertFailure(dispatchParamount({ type: 'floor.iteration', patch: { heartbeatSec: 60.5 } }, deps), 'INVALID_INPUT');
  assertFailure(dispatchParamount({ type: 'floor.iteration', patch: { standupMin: 0 } }, deps), 'INVALID_INPUT');
  assertFailure(dispatchParamount({ type: 'floor.iteration', patch: { standupMin: 1441 } }, deps), 'INVALID_INPUT');
  assert.equal(state.writes, 0);
  assert.equal(state.events.length, 0);
});

test('floor.iteration fails NOT_FOUND without a partial write when a mission is missing', () => {
  const { state, deps } = fixture();
  state.missions = state.missions.filter((m) => m.id !== 'ops-standup');
  assertFailure(dispatchParamount({ type: 'floor.iteration', patch: { heartbeatSec: 60, standupMin: 30 } }, deps), 'NOT_FOUND');
  assert.equal(state.writes, 0);
  assert.equal(state.missions[0].intervalMs, 120_000);
});

// ─── account.connection ─────────────────────────────────────────────────────
test('account.connection enables and disables a registered integration', () => {
  const { state, deps } = fixture();
  assert.equal(dispatchParamount({ type: 'account.connection', id: 'ado', connected: true }, deps).ok, true);
  assert.equal(state.integrations.ado.enabled, true);
  assert.equal(dispatchParamount({ type: 'account.connection', id: 'github', connected: true }, deps).ok, true);
  assert.equal(dispatchParamount({ type: 'account.connection', id: 'ado', connected: false }, deps).ok, true);
  assert.equal(state.integrations.ado.enabled, false);
  assert.equal(state.events.length, 3);
});

test('account.connection refuses unknown ids and missing credentials with no write or event (known bad)', () => {
  const { state, deps } = fixture();
  assertFailure(dispatchParamount({ type: 'account.connection', id: 'nope', connected: true }, deps), 'NOT_FOUND');
  assertFailure(dispatchParamount({ type: 'account.connection', id: '__proto__', connected: true }, deps), 'NOT_FOUND');
  assertFailure(dispatchParamount({ type: 'account.connection', id: 'slack', connected: true }, deps), 'CONFLICT');
  assert.equal(state.writes, 0);
  assert.equal(state.events.length, 0);
});

test('account.connection never accepts, persists or echoes a credential', () => {
  const { state, deps } = fixture();
  const secret = 'sk-live-SUPERSECRET-123';
  for (const extra of [{ token: secret }, { secret }, { apiKey: secret }]) {
    const result = dispatchParamount({ type: 'account.connection', id: 'ado', connected: true, ...extra }, deps);
    assertFailure(result, 'INVALID_INPUT');
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  assert.equal(state.writes, 0);
  assert.equal(state.events.length, 0);
  const ok = dispatchParamount({ type: 'account.connection', id: 'ado', connected: true }, deps);
  assert.ok(!JSON.stringify([ok, state.events, state.steps]).includes(secret));
});

test('account.connection write failure reports a possibly applied change', () => {
  const { deps } = fixture({ setIntegrationConnected: () => { throw new Error('disk full'); } });
  assertFailure(dispatchParamount({ type: 'account.connection', id: 'ado', connected: true }, deps), 'UNCERTAIN_STATE');
});

// ─── prereq.install ─────────────────────────────────────────────────────────
test('prereq.install without confirm is read-only: it reports the exact command and runs nothing', () => {
  const { state, deps } = fixture();
  const result = dispatchParamount({ type: 'prereq.install', id: 'claude' }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.prereq.confirmed, false);
  assert.equal(result.prereq.command, 'npm install -g @anthropic-ai/claude-code');
  assert.equal(result.prereq.ptyId, undefined);
  assert.deepEqual(state.runs, []);
  assert.deepEqual(state.steps.map((s) => s.step), ['plan', 'confirm-required']);
});

test('prereq.install with confirm=true starts one visible installer and logs every step with the cid', () => {
  const { state, deps } = fixture();
  const result = dispatchParamount({ type: 'prereq.install', id: 'claude', confirm: true }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.prereq.confirmed, true);
  assert.equal(result.prereq.ptyId, 'pty-claude');
  assert.deepEqual(state.runs, ['claude']);
  assert.deepEqual(state.steps.map((s) => s.step), ['plan', 'confirmed', 'spawned']);
  assert.ok(state.steps.every((s) => s.cid === result.correlationId || s.cid === result.event.correlationId));
});

test('prereq.install only honours confirm === true (known bad)', () => {
  const { state, deps } = fixture();
  for (const confirm of ['true', 1, 'yes', null]) {
    assertFailure(dispatchParamount({ type: 'prereq.install', id: 'claude', confirm }, deps), 'INVALID_INPUT');
  }
  assert.deepEqual(state.runs, []);
});

test('prereq.install refuses unvetted ids, installed tools, the manual rung and extra fields', () => {
  const { state, deps } = fixture();
  assertFailure(dispatchParamount({ type: 'prereq.install', id: 'skid', confirm: true }, deps), 'UNSUPPORTED');
  assertFailure(dispatchParamount({ type: 'prereq.install', id: 'git', confirm: true }, deps), 'UNSUPPORTED');
  assertFailure(dispatchParamount({ type: 'prereq.install', id: '__proto__', confirm: true }, deps), 'UNSUPPORTED');
  assertFailure(dispatchParamount({ type: 'prereq.install', id: 'codex', confirm: true }, deps), 'CONFLICT');
  assertFailure(dispatchParamount({ type: 'prereq.install', id: 'opencode', confirm: true }, deps), 'UNSUPPORTED');
  assertFailure(dispatchParamount({ type: 'prereq.install', id: 'claude', confirm: true, command: 'rm -rf /' }, deps), 'INVALID_INPUT');
  assert.deepEqual(state.runs, []);
  assert.equal(state.events.length, 0);
});

test('prereq.install spawn failure is traced, emits no event and does not claim an install', () => {
  const { state, deps } = fixture();
  state.spawnOk = false;
  const result = dispatchParamount({ type: 'prereq.install', id: 'claude', confirm: true }, deps);
  assertFailure(result, 'INTERNAL');
  assert.equal(state.events.length, 0);
  assert.ok(state.steps.some((s) => s.step === 'spawn-failed'));
});

// ─── access.set / prereq.start stay unsupported, each with an errorId ───────
test('access.set validates input, then fails UNSUPPORTED with the open product question', () => {
  const { state, deps } = fixture();
  assertFailure(dispatchParamount({ type: 'access.set', agentId: 'jim', sourceId: 'ado', access: 'admin' }, deps), 'INVALID_INPUT');
  const result = dispatchParamount({ type: 'access.set', agentId: 'jim', sourceId: 'ado', access: 'rw' }, deps);
  assertFailure(result, 'UNSUPPORTED');
  assert.match(result.message, /product decision/);
  assert.equal(state.events.length, 0);
});

test('prereq.start fails UNSUPPORTED with an errorId and never runs anything', () => {
  const { state, deps } = fixture();
  assertFailure(dispatchParamount({ type: 'prereq.start', id: 'skid' }, deps), 'UNSUPPORTED');
  assertFailure(dispatchParamount({ type: 'prereq.start' }, deps), 'INVALID_INPUT');
  assert.deepEqual(state.runs, []);
  assert.equal(state.events.length, 0);
});
