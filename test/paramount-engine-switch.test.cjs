'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preserveEngineSession, switchEngineTransaction } = loadTs('src/main/paramount-engine-switch.ts');

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
