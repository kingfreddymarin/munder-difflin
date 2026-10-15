'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { dispatchParamount } = loadTs('src/main/paramount.ts');

function fixture() {
  const state = {
    tasks: [{ id: 'P-1', humanQA: [{ q: 'Proceed?' }] }],
    missions: [{ id: 'daily', label: 'Daily', enabled: false }],
    agents: { jim: { name: 'Jim' } },
    events: [], preferences: {}, notifications: true
  };
  const deps = {
    tasks: () => ({ tasks: state.tasks }),
    patchTask: (id, patch) => {
      const task = state.tasks.find((t) => t.id === id);
      if (!task) return false;
      if (process.env.PARAMOUNT_KNOWN_BAD === '1') return true;
      Object.assign(task, patch);
      return true;
    },
    missions: () => state.missions,
    saveMissions: (missions) => { state.missions = missions; },
    agents: () => state.agents,
    renameAgent: (id, name) => { state.agents[id].name = name; return { ok: true }; },
    setAgentTokenCap: (id, cap) => { state.agents[id].cap = cap; },
    setNotifications: (on) => { state.notifications = on; },
    savePreference: (key, value) => { state.preferences[key] = value; },
    appendEvent: (event) => { state.events.push(event); },
    publish: () => {}
  };
  return { state, deps };
}

test('answers the named open question and emits one event', () => {
  const { state, deps } = fixture();
  const result = dispatchParamount({ type: 'question.answer', messageId: 'P-1:0', option: 'yes' }, deps);
  assert.equal(result.ok, true);
  assert.equal(state.tasks[0].humanQA[0].a, 'yes');
  assert.equal(state.events.length, 1);
});

test('rejects a missing question with no mutation or event (known bad)', () => {
  const { state, deps } = fixture();
  const result = dispatchParamount({ type: 'question.answer', messageId: 'P-999:0', option: 'yes' }, deps);
  assert.equal(result.ok, false);
  assert.equal(state.tasks[0].humanQA[0].a, undefined);
  assert.equal(state.events.length, 0);
});

test('notification action resolves a linked task question', () => {
  const { state, deps } = fixture();
  assert.equal(dispatchParamount({ type: 'notification.act', notificationId: 'P-1:0', action: 'yes' }, deps).ok, true);
  assert.equal(state.tasks[0].humanQA[0].a, 'yes');
});

test('toggle preserves other missions and rejects unknown id', () => {
  const { state, deps } = fixture();
  state.missions.push({ id: 'weekly', label: 'Weekly', enabled: true });
  assert.equal(dispatchParamount({ type: 'automation.toggle', id: 'missing', enabled: true }, deps).ok, false);
  assert.equal(dispatchParamount({ type: 'automation.toggle', id: 'daily', enabled: true }, deps).ok, true);
  assert.deepEqual(state.missions.map((m) => m.enabled), [true, true]);
  assert.equal(state.events.length, 1);
});

test('privileged unsupported action fails closed', () => {
  const { state, deps } = fixture();
  assert.equal(dispatchParamount({ type: 'access.set', agentId: 'jim', sourceId: 'ado', access: 'rw' }, deps).ok, false);
  assert.equal(state.events.length, 0);
});

test('agent token cap converts UI millions to fork tokens', () => {
  const { state, deps } = fixture();
  assert.equal(dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { tokensCap: 2.5 } }, deps).ok, true);
  assert.equal(state.agents.jim.cap, 2_500_000);
  assert.equal(dispatchParamount({ type: 'agent.update', agentId: 'jim', patch: { tokensCap: 0 } }, deps).ok, false);
});
