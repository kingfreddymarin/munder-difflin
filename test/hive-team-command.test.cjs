'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { static isSupported() { return false; } } }
};
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const run = promisify(execFile);

test('the hive command creates and assigns team chains through the live hook socket', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-teams-'));
  const hive = new HiveManager(() => home);
  // This fixture needs the generated shim and real socket. Background hive
  // commits can outlive the test and race the deletion of its temporary home.
  hive.commit = () => {};
  const hooks = new HookServer(hive, () => null, () => ({ notifications: false }));
  t.after(() => { hooks.stop(); fs.rmSync(home, { recursive: true, force: true }); });

  const god = await hive.ensureAgent({ id: 'god', name: 'God', provider: 'claude', cwd: home, isGod: true });
  const worker = await hive.ensureAgent({ id: 'worker', name: 'Worker', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'reviewer', name: 'Reviewer', provider: 'claude', cwd: home });
  assert.ok(god.env.HIVE_TEAM_TOKEN);
  assert.equal(worker.env.HIVE_TEAM_TOKEN, undefined);

  hooks.start();
  if (!hooks.server.listening) await once(hooks.server, 'listening');
  const shim = path.join(hive.root(), 'bin', 'hive-team.cjs');
  const call = async (env, ...args) => JSON.parse((await run(process.execPath, [shim, ...args], {
    env: { ...process.env, ...env }
  })).stdout);

  await assert.rejects(call({ ...worker.env, HIVE_TEAM_TOKEN: god.env.HIVE_TEAM_TOKEN }, 'list'), /Only the active floor orchestrator/);
  await assert.rejects(call({ ...god.env, HIVE_TEAM_TOKEN: 'invalid' }, 'list'), /Only the active floor orchestrator/);
  const team = await call(god.env, 'create', 'Release team', 'Ship the build', 'god', 'worker');
  assert.equal(team.objective, 'Ship the build');
  assert.deepEqual(team.memberIds, ['god', 'worker']);

  const updated = await call(god.env, 'assign', team.id, 'reviewer', 'worker');
  assert.deepEqual(updated.parents, { reviewer: 'worker' });
  await assert.rejects(call(god.env, 'assign', team.id, 'worker', 'reviewer'), /cycle/);
  await assert.rejects(call(god.env, 'assign', team.id, 'god', 'reviewer'), /lead is the root/);
  assert.deepEqual(await call(god.env, 'list'), [updated]);
  assert.doesNotMatch(fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8'), new RegExp(god.env.HIVE_TEAM_TOKEN));
});
