'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');
const { switchEngineTransaction } = loadTs('src/main/paramount-engine-switch.ts');

test('provider changes clear the active session pointer; rollback explicitly restores it', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-provider-session-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home });
  hive.recordSession('jim', 'claude-session-id');
  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'codex', cwd: home }, { preserveAccountHome: true });
  assert.equal(hive.registry().agents.jim.provider, 'codex');
  assert.equal(hive.lastSession('jim'), undefined, 'a Claude session id is not active on Codex');
  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home }, { sessionId: 'claude-session-id' });
  assert.equal(hive.lastSession('jim'), 'claude-session-id', 'rollback explicitly restores the previous session');
});

test('stopped-agent switch rollback restores the session pointer through HiveManager', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-stopped-switch-rollback-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; });
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'stopped', name: 'Stopped', provider: 'claude', cwd: home });
  hive.recordSession('stopped', 'claude-session-id');
  const prior = hive.registry().agents.stopped;
  const result = await switchEngineTransaction({
    stopCurrent: async () => ({ ok: true }),
    startTarget: async () => {
      await hive.ensureAgent({ id: 'stopped', name: prior.name, provider: 'codex', cwd: home });
      return { ok: true };
    },
    persistTarget: async () => { throw new Error('preference write failed'); },
    stopTarget: async () => ({ ok: true }),
    rollback: async () => {
      await hive.ensureAgent({ id: 'stopped', name: prior.name, provider: 'claude', role: prior.role, cwd: prior.cwd }, { sessionId: 'claude-session-id' });
      return { ok: true };
    }
  });
  assert.equal(result.ok, false);
  assert.equal(hive.registry().agents.stopped.provider, 'claude');
  assert.equal(hive.lastSession('stopped'), 'claude-session-id');
});
