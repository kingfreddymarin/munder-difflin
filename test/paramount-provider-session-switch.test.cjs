'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');

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
