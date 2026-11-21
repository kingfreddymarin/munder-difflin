'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');
const { dispatchParamount } = loadTs('src/main/paramount.ts');
const { isBoardDispatchSender } = loadTs('src/main/paramount-board.ts');

const card = {
  id: 'NSC-1', title: 'Check the build', description: 'Inspect the build report.',
  status: 'blocked', dependsOn: ['NSC-0'], priority: 2, createdAt: '2026-11-21',
  refs: [{ kind: 'build', system: 'github', id: '10', url: 'https://github.com/example/build' }]
};
const command = { type: 'card.dispatch', key: card.id, agentId: 'worker-pam', expectedAssignee: null };

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'paramount-board-dispatch-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const agents = {
    'god-1': { provider: 'claude' },
    'worker-pam': { provider: 'codex' },
    'worker-jim': { provider: 'claude' },
    'worker-proxy': { provider: 'qwen' },
    prep: { provider: 'claude', isAssistant: true }
  };
  writeFileSync(join(hive.root(), 'registry.json'), JSON.stringify({ godId: 'god-1', agents }));
  for (const id of Object.keys(agents)) mkdirSync(join(hive.agentDir(id), 'inbox', '.done'), { recursive: true });
  hive.writeTasks([card, { ...card, id: 'NSC-2', status: 'done' }]);
  const events = [];
  const deps = (manager) => ({
    board: { dispatchTask: manager.dispatchBoardTask.bind(manager) },
    appendEvent: (event) => events.push(event),
    publish() {}
  });
  const run = (input = command, manager = hive) => dispatchParamount(input, deps(manager));
  return { home, hive, run, events };
}

test('Board dispatch checks the top-level Paramount window identity and normalizes hash routes', () => {
  assert.equal(isBoardDispatchSender(true, 'paramount://app/index.html#/board?card=NSC-1', 'paramount://app/index.html'), true);
  assert.equal(isBoardDispatchSender(true, 'http://127.0.0.1:5173/#/board', 'http://127.0.0.1:5173'), true);
  assert.equal(isBoardDispatchSender(false, 'paramount://app/index.html', 'paramount://app/index.html'), false);
  assert.equal(isBoardDispatchSender(true, 'https://app/index.html', 'paramount://app/index.html'), false);
  assert.equal(isBoardDispatchSender(true, 'paramount://app/embedded.html', 'paramount://app/index.html'), false);
});

test('sends one human work order, persists its receipt and assignee, and reuses the receipt after a restart', (t) => {
  const { hive, home, run, events } = fixture(t);
  const first = run();
  const [message] = hive.inbox('worker-pam');
  assert.equal(first.ok, true);
  assert.equal(first.event.id, message.id);
  assert.equal(message.from, 'human');
  assert.equal(message.to, 'worker-pam');
  assert.equal(message.act, 'request');
  assert.equal(message.conversation, 'task:NSC-1');
  assert.match(message.subject, /NSC-1.*Check the build/);
  assert.match(message.body, /Inspect the build report/);
  const [{ assignee, boardDispatch, ...saved }, untouched] = hive.tasks().tasks;
  assert.equal(assignee, 'worker-pam');
  assert.equal(boardDispatch.messageId, message.id);
  assert.deepEqual(saved, card);
  assert.equal(untouched.id, 'NSC-2');
  const restarted = new HiveManager(() => home);
  assert.equal(run(command, restarted).event.id, message.id);
  assert.equal(run({ ...command, expectedAssignee: 'worker-pam' }, restarted).event.id, message.id);
  assert.deepEqual(restarted.inbox('worker-pam').map((item) => item.id), [message.id]);
  assert.deepEqual(restarted.inbox('god-1'), []);
  assert.equal(events.length, 1);
});

test('rejects stale selections, completed tasks, reserved or ineligible recipients and renderer-supplied content', (t) => {
  const { hive, run, events } = fixture(t);
  hive.setArchived('worker-jim', true);
  assert.deepEqual(hive.boardDispatchAgents().sort(), ['god-1', 'worker-pam']);
  for (const [patch, code] of [
    [{ to: 'god-1' }, 'INVALID_INPUT'], [{ body: 'renderer input' }, 'INVALID_INPUT'],
    [{ expectedAssignee: undefined }, 'INVALID_INPUT'], [{ expectedAssignee: 'stale' }, 'CONFLICT'],
    [{ key: 'NSC-2' }, 'CONFLICT'], [{ key: 'missing' }, 'NOT_FOUND'],
    ...['broadcast', '../god-1', 'human', 'god', 'missing', 'worker-jim', 'worker-proxy', 'prep'].map((agentId) => [{ agentId }, 'NOT_FOUND'])
  ]) {
    const result = run({ ...command, ...patch });
    assert.equal(result.code, code, JSON.stringify(patch));
    assert.ok(result.errorId);
  }
  assert.deepEqual(hive.tasks().tasks[0], card);
  assert.deepEqual(hive.inbox('worker-pam'), []);
  assert.deepEqual(hive.inbox('god-1'), []);
  assert.equal(events.length, 0);
});

test('a missing inbox leaves the existing assignee intact and never sends to the orchestrator', (t) => {
  const { hive, run } = fixture(t);
  const first = run();
  const inbox = join(hive.agentDir('worker-jim'), 'inbox');
  renameSync(inbox, inbox + '.unavailable');
  const reassign = { ...command, agentId: 'worker-jim', expectedAssignee: 'worker-pam' };
  assert.equal(run(reassign).code, 'NOT_FOUND');
  assert.equal(hive.tasks().tasks[0].assignee, 'worker-pam');
  assert.equal(run(command).event.id, first.event.id);
  assert.deepEqual(hive.inbox('god-1'), []);
  renameSync(inbox + '.unavailable', inbox);
  const retry = run(reassign);
  assert.equal(retry.ok, true);
  assert.equal(hive.tasks().tasks[0].assignee, 'worker-jim');
  assert.equal(hive.inbox('worker-jim')[0].id, retry.event.id);
  assert.equal(hive.inbox('worker-pam').length, 1);
});

test('an interrupted assignment reconciles a handled mailbox receipt without sending twice', (t) => {
  const { hive, home, run, events } = fixture(t);
  const patch = hive.patchTask.bind(hive);
  hive.patchTask = (id, fields) => {
    if (fields.boardDispatch?.delivered) throw new Error('simulated final write failure');
    return patch(id, fields);
  };
  assert.equal(run().code, 'UNCERTAIN_STATE');
  const [message] = hive.inbox('worker-pam');
  assert.equal(hive.tasks().tasks[0].assignee, undefined);
  const inbox = join(hive.agentDir('worker-pam'), 'inbox');
  renameSync(join(inbox, message.id + '.json'), join(inbox, '.done', message.id + '.json'));
  const restarted = new HiveManager(() => home);
  assert.equal(run({ ...command, agentId: 'worker-jim' }, restarted).code, 'UNCERTAIN_STATE');
  assert.equal(run(command, restarted).event.id, message.id);
  assert.equal(restarted.tasks().tasks[0].assignee, 'worker-pam');
  assert.deepEqual(restarted.inbox('worker-pam'), []);
  assert.equal(events.length, 1);
});
