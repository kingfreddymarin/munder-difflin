'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { dispatchParamount } = loadTs('src/main/paramount.ts');

function fixture() {
  const state = {
    tasks: [{ id: 'P-1', title: 'Ship it', humanQA: [{ q: 'Old?', a: 'yes' }, { q: '**Pick one**\n- A\n- B', from: 'jim' }] }],
    agents: { jim: { name: 'Jim' }, god: { name: 'Michael' } },
    mail: [{ id: 'm-1', from: 'jim', to: 'human', subject: 'Need a key' }],
    sent: [], events: [], preferences: {}
  };
  const deps = {
    tasks: () => ({ tasks: state.tasks }),
    patchTask: (id, patch) => { const t = state.tasks.find((x) => x.id === id); if (!t) return false; Object.assign(t, patch); return true; },
    missions: () => [], saveMissions: () => {},
    agents: () => state.agents,
    renameAgent: () => ({ ok: true }), setAgentTokenCap: () => {}, setNotifications: () => {},
    savePreference: (key, value) => { state.preferences[key] = { ...state.preferences[key], ...value }; },
    appendEvent: (e) => state.events.push(e), publish: () => {},
    send: (msg) => { state.sent.push(msg); return { ok: true }; },
    message: (id) => state.mail.find((m) => m.id === id) ?? null,
    godId: () => 'god'
  };
  return { state, deps };
}

test('ask.reply records a decision on the card and mails god and the asking agent', () => {
  const { state, deps } = fixture();
  const r = dispatchParamount({ type: 'ask.reply', messageId: 'P-1:1', mode: 'decision', text: 'B' }, deps);
  assert.equal(r.ok, true);
  const qa = state.tasks[0].humanQA[1];
  assert.equal(qa.a, 'B');
  assert.equal(qa.mode, 'decision');
  assert.ok(qa.answeredAt);
  assert.deepEqual(state.sent.map((m) => m.to), ['god', 'jim']);
  assert.match(state.sent[0].body, /DECISION: B/);
  assert.equal(state.events.length, 1);
});

test('ask.reply refuses an answered ask with CONFLICT and writes nothing', () => {
  const { state, deps } = fixture();
  const r = dispatchParamount({ type: 'ask.reply', messageId: 'P-1:0', mode: 'answer', text: 'again' }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONFLICT');
  assert.ok(r.errorId);
  assert.equal(state.sent.length, 0);
  assert.equal(state.events.length, 0);
});

test('ask.reply to a direct hive question mails the sender with in_reply_to', () => {
  const { state, deps } = fixture();
  const r = dispatchParamount({ type: 'ask.reply', messageId: 'm-1', mode: 'done', text: 'key added' }, deps);
  assert.equal(r.ok, true);
  assert.equal(state.sent[0].to, 'jim');
  assert.equal(state.sent[0].in_reply_to, 'm-1');
  assert.match(state.sent[0].body, /DONE/);
});

test('ask.reply with an unknown id is NOT_FOUND; a bad mode is INVALID_INPUT', () => {
  const { deps } = fixture();
  assert.equal(dispatchParamount({ type: 'ask.reply', messageId: 'nope', mode: 'answer', text: 'x' }, deps).code, 'NOT_FOUND');
  assert.equal(dispatchParamount({ type: 'ask.reply', messageId: 'P-1:1', mode: 'shout', text: 'x' }, deps).code, 'INVALID_INPUT');
});

test('ask.reply is UNSUPPORTED without a mail dep, and UNCERTAIN_STATE when mail fails after the card write', () => {
  const { deps } = fixture();
  delete deps.send;
  assert.equal(dispatchParamount({ type: 'ask.reply', messageId: 'P-1:1', mode: 'answer', text: 'x' }, deps).code, 'UNSUPPORTED');
  const second = fixture();
  second.deps.send = () => ({ ok: false, error: 'disk full' });
  const r = dispatchParamount({ type: 'ask.reply', messageId: 'P-1:1', mode: 'answer', text: 'x' }, second.deps);
  assert.equal(r.code, 'UNCERTAIN_STATE');
  assert.equal(second.state.tasks[0].humanQA[1].a, 'x');
});

test('ask.dismiss marks the open ask dismissed and keeps the question', () => {
  const { state, deps } = fixture();
  assert.equal(dispatchParamount({ type: 'ask.dismiss', messageId: 'P-1:1' }, deps).ok, true);
  const qa = state.tasks[0].humanQA[1];
  assert.ok(qa.dismissedAt);
  assert.equal(qa.a, undefined);
  assert.equal(dispatchParamount({ type: 'ask.dismiss', messageId: 'P-1:1' }, deps).code, 'CONFLICT');
});

test('home.layout validates and persists the layout under preferences.home', () => {
  const { state, deps } = fixture();
  const ok = dispatchParamount({ type: 'home.layout', layout: { density: 'compact', order: ['ask', 'activity'], tiles: { ask: { size: 'lg', hidden: false } } } }, deps);
  assert.equal(ok.ok, true);
  assert.equal(state.preferences.home.density, 'compact');
  assert.deepEqual(state.preferences.home.order, ['ask', 'activity']);
  assert.equal(dispatchParamount({ type: 'home.layout', layout: { density: 'huge' } }, deps).code, 'INVALID_INPUT');
  assert.equal(dispatchParamount({ type: 'home.layout', layout: { tiles: { ask: { size: 'lg', token: 'x' } } } }, deps).code, 'INVALID_INPUT');
  assert.equal(dispatchParamount({ type: 'home.layout', layout: {} }, deps).code, 'INVALID_INPUT');
});

test('chats.view persists hideUpdates and caps hiddenIds', () => {
  const { state, deps } = fixture();
  const ids = Array.from({ length: 600 }, (_, i) => `m${i}`);
  assert.equal(dispatchParamount({ type: 'chats.view', hideUpdates: true, hiddenIds: ids }, deps).ok, true);
  assert.equal(state.preferences.chats.hideUpdates, true);
  assert.equal(state.preferences.chats.hiddenIds.length, 500);
  assert.equal(state.preferences.chats.hiddenIds[499], 'm599');
  assert.equal(dispatchParamount({ type: 'chats.view', hideUpdates: 'yes' }, deps).code, 'INVALID_INPUT');
});

// STD-4: Main Objectives are set on Home and saved under preferences.objectives.items.
test('home.objectives validates, normalizes and replaces the saved list', () => {
  const { state, deps } = fixture();
  const ok = dispatchParamount({ type: 'home.objectives', objectives: [
    { id: 'o1', title: '  Ship the DMG ', why: 'testers need it', owner: 'jim', cardKeys: ['P-1'], health: 'at-risk' },
    { id: 'o2', title: 'Floor runs unattended', why: '  ', owner: '', health: 'on-track' }] }, deps);
  assert.equal(ok.ok, true);
  assert.deepEqual(state.preferences.objectives.items, [
    { id: 'o1', title: 'Ship the DMG', health: 'at-risk', why: 'testers need it', owner: 'jim', cardKeys: ['P-1'] },
    { id: 'o2', title: 'Floor runs unattended', health: 'on-track' }]);
  assert.equal(dispatchParamount({ type: 'home.objectives', objectives: [] }, deps).ok, true);
  assert.deepEqual(state.preferences.objectives.items, [], 'saving an empty list clears it');
});

test('home.objectives refuses malformed objectives without writing', () => {
  const { state, deps } = fixture();
  const bad = [
    { objectives: 'x' },
    { objectives: [{ id: 'o1', title: '', health: 'on-track' }] },
    { objectives: [{ id: 'o1', title: 'A', health: 'great' }] },
    { objectives: [{ id: 'o1', title: 'A', health: 'blocked' }, { id: 'o1', title: 'B', health: 'blocked' }] },
    { objectives: [{ id: 'o1', title: 'A', health: 'blocked', token: 'secret' }] },
    { objectives: [{ id: 'o1', title: 'A', health: 'blocked', cardKeys: 'P-1' }] },
    { objectives: Array.from({ length: 21 }, (_, i) => ({ id: `o${i}`, title: 'A', health: 'on-track' })) },
  ];
  for (const body of bad) assert.equal(dispatchParamount({ type: 'home.objectives', ...body }, deps).code, 'INVALID_INPUT', JSON.stringify(body).slice(0, 80));
  assert.equal(state.preferences.objectives, undefined);
});
