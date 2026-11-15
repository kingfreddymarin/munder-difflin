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
  assert.deepEqual(order, ['stop-old', 'start-target', 'stop-target', 'restore-old']);
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

test('same-provider history keeps distinct account fingerprints and orchestrator identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-account-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = { provider: 'claude', at: '2026-11-15T00:00:00Z', sessionId: 'work-session', model: 'sonnet', launcherId: 'profile-work', launcherFingerprint: 'a'.repeat(64), isGod: true };
  const next = { ...previous, sessionId: 'personal-session', launcherId: 'profile-personal', launcherFingerprint: 'b'.repeat(64) };
  preserveEngineSession(root, 'god', previous);
  preserveEngineSession(root, 'god', next);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'paramount-agent-engine-history.json'), 'utf8'));
  assert.deepEqual(saved.agents.god, [previous, next]);
  assert.equal(fs.statSync(path.join(root, 'paramount-agent-engine-history.json')).mode & 0o777, 0o600);
});

test('throwing target cleanup reports rollbackError and never starts the old process', async () => {
  let rollbackCalls = 0;
  const result = await switchEngineTransaction({
    stopCurrent: async () => ({ ok: true }), startTarget: async () => ({ ok: true }),
    targetViable: async () => ({ ok: false, error: 'target readiness failed' }),
    persistTarget: async () => { assert.fail('not ready'); },
    stopTarget: async () => { throw new Error('target kill failed'); },
    rollback: async () => { rollbackCalls++; return { ok: true }; },
  });
  assert.deepEqual(result, { ok: false, error: 'target readiness failed', rollbackError: 'target kill failed' });
  assert.equal(rollbackCalls, 0);
});

test('throwing rollback reports both target and restoration failures', async () => {
  const result = await switchEngineTransaction({
    stopCurrent: async () => ({ ok: true }), startTarget: async () => ({ ok: false, error: 'target login failed' }),
    persistTarget: async () => { assert.fail('target did not start'); }, stopTarget: async () => ({ ok: true }),
    rollback: async () => { throw new Error('old metadata restore failed'); },
  });
  assert.deepEqual(result, { ok: false, error: 'target login failed', rollbackError: 'old metadata restore failed' });
});
test('a target that throws after partial start must be cleaned before rollback', async () => {
 let rolled=false;
 const result=await switchEngineTransaction({stopCurrent:async()=>({ok:true}),startTarget:async()=>{throw new Error('partial spawn');},persistTarget:async()=>{},stopTarget:async()=>({ok:false,error:'cleanup uncertain'}),rollback:async()=>{rolled=true;return {ok:true};}});
 assert.equal(rolled,false);assert.equal(result.rollbackError,'cleanup uncertain');
});

test('switch diagnostics correlate ordered rollback phases without forwarding sensitive errors', async () => {
  const events = [];
  const result = await switchEngineTransaction({
    observe: event => events.push(event),
    stopCurrent: async () => ({ ok: true }),
    startTarget: async () => ({ ok: false, error: 'secret@example.com /private/account token=secret' }),
    persistTarget: async () => assert.fail('failed target cannot persist'),
    stopTarget: async () => ({ ok: true }),
    rollback: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(events.map(({phase, outcome}) => [phase, outcome]), [
    ['stop-current', 'start'], ['stop-current', 'ok'], ['start-target', 'start'], ['start-target', 'fail'],
    ['stop-target', 'start'], ['stop-target', 'ok'], ['rollback', 'start'], ['rollback', 'ok'],
  ]);
  assert.equal(new Set(events.map(e => e.cid)).size, 1);
  assert.match(events[0].cid, /^[a-f0-9-]{36}$/);
  assert.ok(events.every(e => Object.keys(e).sort().join(',') === 'cid,outcome,phase'));
  assert.doesNotMatch(JSON.stringify(events), /secret|private|token/);
});

test('broken diagnostic sink cannot prevent a successful switch', async () => {
  const phases = [];
  const result = await switchEngineTransaction({
    observe: event => { phases.push(event.phase); throw new Error('disk unavailable'); },
    stopCurrent: async () => ({ ok: true }), startTarget: async () => ({ ok: true }),
    targetViable: async () => ({ ok: true }), persistTarget: async () => {},
    stopTarget: async () => assert.fail('no cleanup expected'), rollback: async () => assert.fail('no rollback expected'),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual([...new Set(phases)], ['stop-current', 'start-target', 'check-viability', 'persist-target']);
});
