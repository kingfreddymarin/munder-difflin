'use strict';
// First-run floor setup (Munder parity): no floor until setup.complete, and setup
// writes the floor, the orchestrator engine/model and onboardingComplete in one call.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { dispatchFloorSetup, floorSetupState } = loadTs('src/main/paramount-floor-setup.ts');

const ENGINES = [
  { id: 'claude', label: 'Claude Code', orchestrator: true, installed: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
  { id: 'codex', label: 'Codex', orchestrator: true, installed: false, models: [] },
  { id: 'copilot', label: 'Copilot', orchestrator: false, installed: true, models: [] }
];

function fixture(config = { onboardingComplete: false, harnessHome: null }, ensure = { ok: true }) {
  const calls = { complete: [], ensure: [], events: [], published: [] };
  const deps = {
    launcherDiscovery: () => ({ status: 'ok', choices: [], profiles: [] }),
    config: () => config,
    suggestedHome: () => '/tmp/Paramount',
    engines: () => ENGINES,
    ensureHome: (p) => { calls.ensure.push(p); return ensure; },
    complete: (patch) => calls.complete.push(patch),
    appendEvent: (e) => calls.events.push(e),
    publish: (e) => calls.published.push(e)
  };
  const span = { cid: 'cid-1', fail: (code, message) => ({ ok: false, error: { code, message } }) };
  return { deps, calls, span, run: (cmd) => dispatchFloorSetup({ type: 'setup.complete', ...cmd }, deps, span) };
}

const good = { home: '/tmp/floor', engine: 'claude', model: 'claude-opus-5-5' };

test('a fresh profile is not set up and has no floor', () => {
  const { deps } = fixture();
  const state = floorSetupState(deps);
  assert.equal(state.complete, false);
  assert.equal(state.harnessHome, null);
  assert.equal(state.suggestedHome, '/tmp/Paramount');
  assert.equal(state.engines.length, 3);
});

test('setup.complete writes floor, engine, model and onboardingComplete in one call, then logs the event', () => {
  const f = fixture();
  const result = f.run({ ...good, autoMode: false });
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.ensure, ['/tmp/floor']);
  assert.deepEqual(f.calls.complete, [{ harnessHome: '/tmp/floor', godProvider: 'claude', godModel: 'claude-opus-5-5', autoMode: false, onboardingComplete: true }]);
  assert.equal(f.calls.events.length, 1);
  assert.equal(f.calls.published.length, 1);
  assert.equal(f.calls.events[0].correlationId, 'cid-1');
});

test('no model clears stale godModel with the existing empty-string representation', () => {
  const f = fixture();
  assert.equal(f.run({ home: '/tmp/floor', engine: 'claude' }).ok, true);
  assert.equal(f.calls.complete[0].godModel, '');
});

for (const [name, cmd, code] of [
  ['relative folder', { ...good, home: 'floor' }, 'INVALID_INPUT'],
  ['multi-line folder', { ...good, home: '/tmp/a\nb' }, 'INVALID_INPUT'],
  ['unknown engine', { ...good, engine: 'nope' }, 'INVALID_INPUT'],
  ['worker-only engine as orchestrator', { ...good, engine: 'copilot', model: undefined }, 'INVALID_INPUT'],
  ['engine not installed', { ...good, engine: 'codex', model: undefined }, 'CONFLICT'],
  ['model outside the catalog', { ...good, model: 'claude-opus-4-8' }, 'INVALID_INPUT'],
  ['unknown field', { ...good, harnessHome: '/x' }, 'INVALID_INPUT'],
  ['non-boolean autoMode', { ...good, autoMode: 'yes' }, 'INVALID_INPUT']
]) {
  test(`rejects ${name} and writes nothing`, () => {
    const f = fixture();
    const result = f.run(cmd);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.deepEqual(f.calls.complete, []);
    assert.deepEqual(f.calls.events, []);
  });
}

test('an already set-up floor is never set up again', () => {
  const f = fixture({ onboardingComplete: true, harnessHome: '/tmp/existing' });
  assert.equal(floorSetupState(f.deps).complete, true);
  const result = f.run(good);
  assert.equal(result.error.code, 'CONFLICT');
  assert.deepEqual(f.calls.ensure, []);
});

test('a folder that cannot be created stops setup before any config write', () => {
  const f = fixture(undefined, { ok: false, error: 'permission denied' });
  const result = f.run(good);
  assert.equal(result.error.code, 'INVALID_INPUT');
  assert.match(result.error.message, /permission denied/);
  assert.deepEqual(f.calls.complete, []);
});

test('other commands and a build without setup support', () => {
  const f = fixture();
  assert.equal(dispatchFloorSetup({ type: 'setup.dismiss', degraded: [] }, f.deps, f.span), null);
  assert.equal(dispatchFloorSetup({ type: 'setup.complete', ...good }, undefined, f.span).error.code, 'UNSUPPORTED');
});
