'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { dispatchParamount, autoModeExpired } = loadTs('src/main/paramount.ts');
const { accessFor, withAccess, isReadMethod } = loadTs('src/main/accessMatrix.ts');

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
    spawnOk: true, starts: [], matrix: undefined, expiresAt: undefined,
    svc: { skid: { installed: true, running: false }, off: { installed: false, running: false }, up: { installed: true, running: true } }
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
    setFloorAutoMode: (on, expiresAt) => { state.writes += 1; state.autoMode = on; state.expiresAt = expiresAt; },
    setAccess: (agentId, sourceId, access) => { state.writes += 1; state.matrix = withAccess(state.matrix, agentId, sourceId, access); },
    prereqStart: {
      plan: (id) => Object.hasOwn(state.svc, id) ? { id, label: 'Skid', command: 'skid doctor', ...state.svc[id] } : null,
      run: (plan) => { state.starts.push(plan.id); return state.spawnOk ? { ok: true, ptyId: `pty-start-${plan.id}` } : { ok: false, error: 'no pty' }; }
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

// ─── floor.yolo autoOffHours ────────────────────────────────────────────────
test('floor.yolo autoOffHours persists an ISO expiry; turning off clears it', () => {
  const { state, deps } = fixture();
  const before = Date.now();
  assert.equal(dispatchParamount({ type: 'floor.yolo', patch: { on: true, autoOffHours: 2 } }, deps).ok, true);
  const at = Date.parse(state.expiresAt);
  assert.ok(at >= before + 2 * 3_600_000 - 1000 && at <= Date.now() + 2 * 3_600_000 + 1000);
  assert.equal(dispatchParamount({ type: 'floor.yolo', patch: { on: true } }, deps).ok, true);
  assert.equal(state.expiresAt, undefined, 'plain on carries no expiry');
  assert.equal(dispatchParamount({ type: 'floor.yolo', patch: { on: true, autoOffHours: null } }, deps).ok, true);
  assert.equal(state.expiresAt, undefined);
});

test('floor.yolo autoOffHours rejects bad values, off+hours and keepHardRules (known bad)', () => {
  const { state, deps } = fixture();
  for (const autoOffHours of [0, -1, 169, 'soon', NaN, Infinity]) {
    assertFailure(dispatchParamount({ type: 'floor.yolo', patch: { on: true, autoOffHours } }, deps), 'INVALID_INPUT');
  }
  assertFailure(dispatchParamount({ type: 'floor.yolo', patch: { on: false, autoOffHours: 2 } }, deps), 'INVALID_INPUT');
  const kh = dispatchParamount({ type: 'floor.yolo', patch: { on: true, keepHardRules: true } }, deps);
  assertFailure(kh, 'UNSUPPORTED');
  assert.match(kh.message, /keepHardRules/);
  assert.equal(state.writes, 0);
});

test('autoModeExpired: past and unreadable expire, future and unset do not', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.equal(autoModeExpired('2026-10-15T11:59:59Z', now), true);
  assert.equal(autoModeExpired('2026-10-15T12:00:00Z', now), true);
  assert.equal(autoModeExpired('2026-10-15T12:00:01Z', now), false);
  assert.equal(autoModeExpired('garbage', now), true, 'fails safe');
  assert.equal(autoModeExpired(undefined, now), false);
});

// ─── floor.iteration unsupported reason ─────────────────────────────────────
test('floor.iteration speed says it is unsupported in v1 so the UI can show why', () => {
  const { deps } = fixture();
  const result = dispatchParamount({ type: 'floor.iteration', patch: { speed: 'fast' } }, deps);
  assertFailure(result, 'UNSUPPORTED');
  assert.match(result.message, /not supported in v1/);
  assert.match(result.message, /speed/);
});

// ─── access.set ─────────────────────────────────────────────────────────────
test('access.set persists restrictive cells and clears the cell for rw', () => {
  const { state, deps } = fixture();
  assert.equal(dispatchParamount({ type: 'access.set', agentId: 'jim', sourceId: 'ado', access: 'r' }, deps).ok, true);
  assert.equal(accessFor(state.matrix, 'jim', 'ado'), 'r');
  assert.equal(dispatchParamount({ type: 'access.set', agentId: 'jim', sourceId: 'slack', access: 'none' }, deps).ok, true);
  assert.equal(accessFor(state.matrix, 'jim', 'slack'), 'none');
  assert.equal(accessFor(state.matrix, 'pam', 'ado'), 'rw', 'unset cell stays rw');
  assert.equal(dispatchParamount({ type: 'access.set', agentId: 'jim', sourceId: 'ado', access: 'rw' }, deps).ok, true);
  assert.deepEqual(state.matrix, { 'jim:slack': 'none' });
  assert.equal(state.events.length, 3);
});

test('access.set rejects bad input with no write (known bad)', () => {
  const { state, deps } = fixture();
  for (const c of [
    { agentId: 'jim', sourceId: 'ado', access: 'admin' },
    { agentId: 'ji:m', sourceId: 'ado', access: 'r' },
    { agentId: 'jim', sourceId: 'a:do', access: 'r' },
    { agentId: '', sourceId: 'ado', access: 'r' },
    { agentId: 'jim', sourceId: 'ado', access: 'r', token: 'x' },
    {}
  ]) assertFailure(dispatchParamount({ type: 'access.set', ...c }, deps), 'INVALID_INPUT');
  assert.equal(state.writes, 0);
  assert.equal(state.events.length, 0);
});

test('access.set is unsupported without a setter and uncertain if the write throws', () => {
  assertFailure(dispatchParamount({ type: 'access.set', agentId: 'jim', sourceId: 'ado', access: 'r' }, fixture({ setAccess: undefined }).deps), 'UNSUPPORTED');
  assertFailure(dispatchParamount({ type: 'access.set', agentId: 'jim', sourceId: 'ado', access: 'r' }, fixture({ setAccess: () => { throw new Error('disk'); } }).deps), 'UNCERTAIN_STATE');
});

test('access matrix helpers: unset is rw, unreadable fails closed, prototype keys are inert', () => {
  assert.equal(accessFor(undefined, 'a', 's'), 'rw');
  assert.equal(accessFor({ 'a:s': 'weird' }, 'a', 's'), 'none');
  assert.equal(accessFor({}, '__proto__', 'toString'), 'rw');
  const m = {}; const next = withAccess(m, 'a', 's', 'r');
  assert.deepEqual(m, {}, 'input not mutated');
  assert.equal(isReadMethod('get'), true);
  assert.equal(isReadMethod('POST'), false);
});

// ─── broker enforcement ─────────────────────────────────────────────────────
test('integration broker enforces none and r, logs a denial with errorId and ids only', async () => {
  const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
  const http = require('node:http');
  const upstream = http.createServer((req, res) => { res.end('ok'); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const denials = [];
  let matrix = {};
  const broker = new IntegrationBroker({
    getRecord: (id) => ({ id, enabled: true, baseUrl: base, authType: 'none' }),
    getSecret: () => undefined,
    access: (w, i) => accessFor(matrix, w, i),
    onDeny: (d) => denials.push(d)
  });
  const started = await broker.start(0);
  const token = broker.grant('jim', ['ado']);
  const call = (method) => fetch(`${broker.url()}/i/ado/x`, { method, body: method === 'POST' ? 'SECRET-PAYLOAD' : undefined, headers: { 'x-md-broker-token': token } });
  try {
    assert.equal((await call('POST')).status, 200, 'unset cell is rw');
    matrix = { 'jim:ado': 'r' };
    assert.equal((await call('GET')).status, 200);
    const blocked = await call('POST');
    assert.equal(blocked.status, 403);
    assert.match((await blocked.json()).error, /errorId [0-9a-f]+/);
    matrix = { 'jim:ado': 'none' };
    assert.equal((await call('GET')).status, 403);
    assert.equal(denials.length, 2);
    assert.deepEqual(Object.keys(denials[0]).sort(), ['errorId', 'integrationId', 'level', 'method', 'workerId']);
    assert.ok(!JSON.stringify(denials).includes('SECRET-PAYLOAD'));
    assert.ok(started.ok);
  } finally { broker.stop(); upstream.close(); }
});

// ─── prereq.start ───────────────────────────────────────────────────────────
test('prereq.start without confirm is a dry run that starts nothing', () => {
  const { state, deps } = fixture();
  const result = dispatchParamount({ type: 'prereq.start', id: 'skid' }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.prereq.confirmed, false);
  assert.equal(result.prereq.kind, 'start');
  assert.equal(result.prereq.command, 'skid doctor');
  assert.deepEqual(state.starts, []);
  assert.deepEqual(state.steps.map((s) => s.step), ['start-plan', 'start-confirm-required']);
});

test('prereq.start confirm=true runs once in one visible PTY with every step logged', () => {
  const { state, deps } = fixture();
  const result = dispatchParamount({ type: 'prereq.start', id: 'skid', confirm: true }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.prereq.ptyId, 'pty-start-skid');
  assert.deepEqual(state.starts, ['skid']);
  assert.deepEqual(state.steps.map((s) => s.step), ['start-plan', 'start-confirmed', 'start-spawned']);
  assert.ok(state.steps.every((s) => typeof s.cid === 'string' && s.cid));
});

test('prereq.start refuses running, uninstalled, unknown, bad confirm and extra fields (known bad)', () => {
  const { state, deps } = fixture();
  assertFailure(dispatchParamount({ type: 'prereq.start', id: 'up', confirm: true }, deps), 'CONFLICT');
  assertFailure(dispatchParamount({ type: 'prereq.start', id: 'off', confirm: true }, deps), 'UNSUPPORTED');
  assertFailure(dispatchParamount({ type: 'prereq.start', id: 'nope', confirm: true }, deps), 'UNSUPPORTED');
  assertFailure(dispatchParamount({ type: 'prereq.start', id: '__proto__', confirm: true }, deps), 'UNSUPPORTED');
  assertFailure(dispatchParamount({ type: 'prereq.start', id: 'skid', confirm: 'true' }, deps), 'INVALID_INPUT');
  assertFailure(dispatchParamount({ type: 'prereq.start', id: 'skid', confirm: true, command: 'rm -rf /' }, deps), 'INVALID_INPUT');
  assertFailure(dispatchParamount({ type: 'prereq.start' }, deps), 'INVALID_INPUT');
  assert.deepEqual(state.starts, []);
  assert.equal(state.events.length, 0);
});

test('prereq.start spawn failure is INTERNAL, logged, and emits no event', () => {
  const { state, deps } = fixture();
  state.spawnOk = false;
  assertFailure(dispatchParamount({ type: 'prereq.start', id: 'skid', confirm: true }, deps), 'INTERNAL');
  assert.ok(state.steps.some((s) => s.step === 'start-spawn-failed'));
  assert.equal(state.events.length, 0);
});

// ─── port probe (daemon started outside the app) ────────────────────────────
test('probePort sees a real local listener and reports a closed port as false', async () => {
  const { probePort } = loadTs('src/main/portProbe.ts');
  const net = require('node:net');
  const server = net.createServer((s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.equal(await probePort(port), true);
  } finally { await new Promise((r) => server.close(r)); }
  assert.equal(await probePort(port), false, 'closed after the listener stops');
});

test('probePort times out on a black hole instead of blocking (known bad)', async () => {
  const { probePort } = loadTs('src/main/portProbe.ts');
  const started = Date.now();
  assert.equal(await probePort(9, '10.255.255.1', 150), false);
  assert.ok(Date.now() - started < 2000);
});

test('an open service port makes prereq.start CONFLICT, and a closed one allows the dry run', async () => {
  const { probePort } = loadTs('src/main/portProbe.ts');
  const net = require('node:net');
  const server = net.createServer((s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const plan = (portOpen) => (id) => ({ id, label: 'Skid', installed: true, running: portOpen, command: 'skid doctor' });
  try {
    const open = await probePort(port);
    const a = fixture();
    a.deps.prereqStart.plan = plan(open);
    assertFailure(dispatchParamount({ type: 'prereq.start', id: 'skid', confirm: true }, a.deps), 'CONFLICT');
    assert.deepEqual(a.state.starts, []);
  } finally { await new Promise((r) => server.close(r)); }
  const closed = await probePort(port);
  const b = fixture();
  b.deps.prereqStart.plan = plan(closed);
  assert.equal(dispatchParamount({ type: 'prereq.start', id: 'skid' }, b.deps).ok, true);
});
