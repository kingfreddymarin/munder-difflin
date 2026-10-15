'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { dispatchParamount } = loadTs('src/main/paramount.ts');
const { cardRefs, createBoardDeps, openAppUrl } = loadTs('src/main/paramount-board.ts');

const PR = 'https://dev.azure.com/org/proj/_git/repo/pullrequest/23572';
const WI = 'https://dev.azure.com/org/proj/_workitems/edit/19871';

function fixture({ installed = true, board = true } = {}) {
  const state = {
    tasks: [
      { id: 'NSC-30', dir: '/work/compute', tags: ['Varium'], refs: [
        { kind: 'pr', system: 'ado', id: '23572', url: PR },
        { kind: 'workitem', system: 'ado', id: '19871', url: WI },
        { kind: 'build', system: 'ado', id: '61204', url: 'javascript:alert(1)' },
      ] },
      { id: 'NSC-31' },
      { id: 'NSC-32', dir: '/missing' },
    ],
    events: [], preferences: {}, opened: [], openErrors: [],
  };
  const deps = {
    tasks: () => ({ tasks: state.tasks }),
    patchTask: () => true, missions: () => [], saveMissions: () => {}, agents: () => ({}),
    renameAgent: () => ({ ok: true }), setAgentTokenCap: () => {}, setNotifications: () => {}, savePreference: () => {},
    appendEvent: (event) => { state.events.push(event); },
    publish: () => {},
    ...(board ? { board: createBoardDeps({
      savePreference: (value) => { state.preferences.board = value; },
      isDirectory: (path) => path === '/work/compute',
      handlerFor: () => (installed ? 'App' : ''),
      open: async (url) => { state.opened.push(url); },
      onOpenError: (url, error) => { state.openErrors.push({ url, error }); },
    }) } : {}),
  };
  return { state, deps };
}

test('board.columns persists a valid order and emits one event', () => {
  const { state, deps } = fixture();
  const result = dispatchParamount({ type: 'board.columns', order: ['doing', 'todo', 'done', 'blocked'] }, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(state.preferences.board, { columns: ['doing', 'todo', 'done', 'blocked'] });
  assert.equal(state.events.length, 1);
});

test('board.columns rejects duplicates, unknown columns and extra keys without writing (known bad)', () => {
  for (const command of [
    { type: 'board.columns', order: ['todo', 'todo'] },
    { type: 'board.columns', order: ['todo', 'later'] },
    { type: 'board.columns', order: [] },
    { type: 'board.columns', order: ['todo'], token: 'x' },
  ]) {
    const { state, deps } = fixture();
    const result = dispatchParamount(command, deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_INPUT');
    assert.ok(result.errorId);
    assert.equal(state.preferences.board, undefined);
    assert.equal(state.events.length, 0);
  }
});

test('card.open opens the card dir in Warp and VS Code through their URL schemes', () => {
  const { state, deps } = fixture();
  assert.equal(dispatchParamount({ type: 'card.open', key: 'NSC-30', app: 'warp' }, deps).ok, true);
  assert.equal(dispatchParamount({ type: 'card.open', key: 'NSC-30', app: 'vscode' }, deps).ok, true);
  assert.deepEqual(state.opened, [openAppUrl('warp', '/work/compute'), openAppUrl('vscode', '/work/compute')]);
  assert.equal(state.opened[0], 'warp://action/new_tab?path=%2Fwork%2Fcompute');
  assert.equal(state.opened[1], 'vscode://file/work/compute');
});

test('card.open fails with a code and errorId when the card, dir or app is missing (known bad)', () => {
  const cases = [
    [{ key: 'NSC-99', app: 'warp' }, 'NOT_FOUND', {}],
    [{ key: 'NSC-31', app: 'warp' }, 'NOT_FOUND', {}],
    [{ key: 'NSC-32', app: 'vscode' }, 'NOT_FOUND', {}],
    [{ key: 'NSC-30', app: 'finder' }, 'INVALID_INPUT', {}],
    [{ key: 'NSC-30', app: 'warp' }, 'NOT_FOUND', { installed: false }],
    [{ key: 'NSC-30', app: 'warp' }, 'UNSUPPORTED', { board: false }],
  ];
  for (const [command, code, options] of cases) {
    const { state, deps } = fixture(options);
    const result = dispatchParamount({ type: 'card.open', ...command }, deps);
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.equal(result.code, code, JSON.stringify(command));
    assert.match(result.errorId, /.+/);
    assert.equal(state.opened.length, 0);
    assert.equal(state.events.length, 0);
  }
});

test('card.link opens only an https URL stored on the card (known bad: foreign or unsafe URL)', () => {
  const { state, deps } = fixture();
  assert.equal(dispatchParamount({ type: 'card.link', key: 'NSC-30', url: WI }, deps).ok, true);
  assert.deepEqual(state.opened, [WI]);
  const foreign = dispatchParamount({ type: 'card.link', key: 'NSC-30', url: 'https://evil.example/x' }, deps);
  assert.equal(foreign.code, 'NOT_FOUND');
  const unsafe = dispatchParamount({ type: 'card.link', key: 'NSC-30', url: 'javascript:alert(1)' }, deps);
  assert.equal(unsafe.code, 'INVALID_INPUT');
  assert.deepEqual(state.opened, [WI]);
});

test('a late open failure is reported, not swallowed', async () => {
  const errors = [];
  const deps = createBoardDeps({ savePreference() {}, isDirectory: () => true, handlerFor: () => 'App',
    open: async () => { throw new Error('no handler'); }, onOpenError: (url, error) => errors.push({ url, error }) });
  deps.openUrl(PR);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].url, PR);
});

test('cardRefs keeps only well-formed https refs', () => {
  const refs = cardRefs(fixture().state.tasks[0]);
  assert.deepEqual(refs.map((ref) => ref.id), ['23572', '19871']);
  assert.deepEqual(cardRefs({ refs: 'nope' }), []);
});
