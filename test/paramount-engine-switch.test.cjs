'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preserveEngineSession, switchEngineTransaction, withAgentLifecycleLock } = loadTs('src/main/paramount-engine-switch.ts');
const { PtyManager } = loadTs('src/main/pty.ts');

test('retired provider session history is recorded separately from the active registry session id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-switch-history-'));
  preserveEngineSession(root, 'jim', { provider: 'claude', at: '2026-11-12T00:00:00Z', sessionId: 'claude-session', model: 'sonnet', launcherId: 'dc' });
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'paramount-agent-engine-history.json'), 'utf8'));
  assert.deepEqual(saved.agents.jim, [{ provider: 'claude', at: '2026-11-12T00:00:00Z', sessionId: 'claude-session', model: 'sonnet', launcherId: 'dc' }]);
});

test('failed target start rolls back after the old session stopped and never overlaps processes', async () => {
  const order = [];
  const result = await switchEngineTransaction({
    stopCurrent: async () => { order.push('stop-old'); return { ok: true }; },
    startTarget: async () => { order.push('start-target'); return { ok: false, error: 'target login failed' }; },
    persistTarget: async () => { order.push('persist'); },
    stopTarget: async () => { order.push('stop-target'); return { ok: true }; },
    rollback: async () => { order.push('restore-old'); return { ok: true }; },
  });
  assert.deepEqual(order, ['stop-old', 'start-target', 'restore-old']);
  assert.deepEqual(result, { ok: false, error: 'target login failed' });
});

test('selection persistence failure stops the target before attempting rollback', async () => {
  const order = [];
  const result = await switchEngineTransaction({
    stopCurrent: async () => { order.push('stop-old'); return { ok: true }; },
    startTarget: async () => { order.push('start-target'); return { ok: true }; },
    persistTarget: async () => { order.push('persist'); throw new Error('disk full'); },
    stopTarget: async () => { order.push('stop-target'); return { ok: true }; },
    rollback: async () => { order.push('restore-old'); return { ok: true }; },
  });
  assert.deepEqual(order, ['stop-old', 'start-target', 'persist', 'stop-target', 'restore-old']);
  assert.deepEqual(result, { ok: false, error: 'disk full' });
});

test('a live target that cannot stop prevents rollback, avoiding duplicate processes', async () => {
  const order = [];
  const result = await switchEngineTransaction({
    stopCurrent: async () => ({ ok: true }),
    startTarget: async () => ({ ok: true }),
    persistTarget: async () => { throw new Error('disk full'); },
    stopTarget: async () => { order.push('stop-target'); return { ok: false, error: 'process busy' }; },
    rollback: async () => { order.push('restore-old'); return { ok: true }; },
  });
  assert.deepEqual(order, ['stop-target']);
  assert.deepEqual(result, { ok: false, error: 'disk full', rollbackError: 'process busy' });
});

test('a real PTY target that exits immediately is rejected before preferences persist', { skip: process.platform === 'win32' }, async (t) => {
  const manager = new PtyManager();
  const exited = new Promise((resolve) => manager.setExitHandler((id, code) => resolve({ id, code })));
  const order = [];
  const start = manager.spawn({ id: 'switch-immediate-exit', cwd: process.cwd(), command: '/bin/sh', args: ['-c', 'exit 23'] });
  assert.equal(start.ok, true, start.error);
  const result = await switchEngineTransaction({
    stopCurrent: async () => ({ ok: true }),
    startTarget: async () => ({ ok: true }),
    targetViable: async () => {
      const status = await manager.waitForExit('switch-immediate-exit', 500);
      return status.exited ? { ok: false, error: `exit ${status.exitCode}` } : { ok: true };
    },
    persistTarget: async () => order.push('persist'),
    stopTarget: async () => ({ ok: true }),
    rollback: async () => { order.push('rollback'); return { ok: true }; }
  });
  assert.deepEqual(await exited, { id: 'switch-immediate-exit', code: 23 });
  assert.deepEqual(order, ['rollback']);
  assert.deepEqual(result, { ok: false, error: 'exit 23' });
});

test('per-agent lifecycle lock rejects contenders and releases after success or throw', async () => {
  let release;
  const active = withAgentLifecycleLock('agent-race', () => new Promise((resolve) => { release = resolve; }));
  assert.equal(await withAgentLifecycleLock('agent-race', async () => 'stale contender'), undefined);
  release('first');
  assert.equal(await active, 'first');
  await assert.rejects(withAgentLifecycleLock('agent-race', async () => { throw new Error('rollback failed'); }), /rollback failed/);
  assert.equal(await withAgentLifecycleLock('agent-race', async () => 'retry'), 'retry');
});
