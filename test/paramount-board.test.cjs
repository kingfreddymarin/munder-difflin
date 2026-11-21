'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { dispatchParamount } = loadTs('src/main/paramount.ts');
const { cardRefs, createBoardDeps, isBoardOwnerSender, openAppUrl } = loadTs('src/main/paramount-board.ts');

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

test('owner card edits patch only validated fields and publish the saved command', () => {
  const { state, deps } = fixture();
  deps.canMutateBoard = () => true;
  deps.agents = () => ({ worker: {} });
  const writes = [];
  const published = [];
  deps.patchTask = (id, patch) => { writes.push({ id, patch }); return true; };
  deps.publish = (event) => published.push(event);

  const result = dispatchParamount({ type: 'card.update', key: 'NSC-31', patch: { title: '  New title  ', assignee: 'worker' } }, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(writes, [{ id: 'NSC-31', patch: { title: 'New title', assignee: 'worker', updatedAt: result.event.at } }]);
  assert.deepEqual(state.events, published);
  assert.deepEqual(result.event.command.patch, { title: 'New title', assignee: 'worker' });
});

test('owner authorization and supplied fields are checked before a Board write', () => {
  const { state, deps } = fixture();
  deps.patchTask = () => assert.fail('Unexpected write');
  deps.publish = () => assert.fail('Unexpected publish');
  const command = { type: 'card.update', key: 'NSC-31', patch: { title: 'Updated' } };
  assert.equal(dispatchParamount(command, deps).code, 'FORBIDDEN');
  assert.equal(dispatchParamount({ type: 'card.archive', key: 'NSC-31' }, deps).code, 'FORBIDDEN');
  deps.canMutateBoard = () => true;
  for (const patch of [{}, { status: 'done' }, { title: ' ' }, { title: 'two\nlines' },
    { description: 42 }, { priority: null }, { assignee: 'missing-agent' }]) {
    assert.equal(dispatchParamount({ ...command, patch }, deps).code, 'INVALID_INPUT');
  }
  assert.equal(dispatchParamount({ ...command, actor: 'you' }, deps).code, 'INVALID_INPUT');
  assert.equal(dispatchParamount({ ...command, key: 'missing-card' }, deps).code, 'NOT_FOUND');
  assert.deepEqual(state.events, []);
});

test('archive patches Board visibility and keeps workflow status and routing metadata', () => {
  const { state, deps } = fixture();
  const card = Object.assign(state.tasks[1], { status: 'doing', slack: { channel: 'channel', thread_ts: '123' }, result: 'original' });
  deps.canMutateBoard = () => true;
  let writes = 0;
  deps.patchTask = (id, patch) => {
    assert.equal(id, card.id);
    assert.deepEqual(Object.keys(patch), ['boardArchivedAt']);
    Object.assign(card, patch);
    writes++;
    return true;
  };
  const command = { type: 'card.archive', key: card.id };
  const result = dispatchParamount(command, deps);
  assert.equal(result.ok, true);
  assert.equal(card.boardArchivedAt, result.event.at);
  assert.equal(card.status, 'doing');
  assert.equal(card.result, 'original');
  assert.deepEqual(card.slack, { channel: 'channel', thread_ts: '123' });
  assert.equal(dispatchParamount(command, deps).ok, true);
  assert.equal(writes, 1);
});

test('a failed patch publishes no success event', () => {
  const { state, deps } = fixture();
  deps.canMutateBoard = () => true;
  deps.patchTask = () => false;
  deps.publish = () => assert.fail('Unexpected publish');
  assert.equal(dispatchParamount({ type: 'card.update', key: 'NSC-31', patch: { title: 'Lost race' } }, deps).code, 'CONFLICT');
  assert.deepEqual(state.events, []);
});

test('owner Board IPC requires a known window, the top frame and the configured UI', () => {
  for (const ui of ['paramount://app/index.html', 'http://127.0.0.1:4173/']) {
    const owner = { knownWindow: true, mainFrame: true, url: `${ui}#/board` };
    assert.equal(isBoardOwnerSender(owner, ui), true);
    assert.equal(isBoardOwnerSender({ ...owner, knownWindow: false }, ui), false);
    assert.equal(isBoardOwnerSender({ ...owner, mainFrame: false }, ui), false);
    assert.equal(isBoardOwnerSender({ ...owner, url: 'https://example.com/index.html' }, ui), false);
    assert.equal(isBoardOwnerSender({ ...owner, url: new URL('/other.html', ui).href }, ui), false);
  }
});
