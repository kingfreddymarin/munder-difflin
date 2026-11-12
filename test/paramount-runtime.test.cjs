'use strict';
// Council runtime (Munder useRestoreTeam parity): agents live at quit come back
// resumed on the next launch, exactly once, and a second runtime never doubles them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { createParamountRuntime, RUNTIME_FILE, LOCK_FILE } = loadTs('src/main/paramount-runtime.ts');

function floor() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-runtime-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cwd-'));
  return { root, cwd };
}

/** A fake process: `live` is the set of agents with a terminal; respawn makes them live. */
function host(root, opts = {}) {
  const live = new Set(opts.live ?? []);
  const archived = new Set(opts.archived ?? []);
  const agents = opts.agents ?? {};
  const calls = { respawn: [], log: [] };
  const deps = {
    hiveRoot: () => (opts.noFloor ? null : root),
    liveAgents: () => [...live].map((id) => agents[id]),
    isLive: (id) => live.has(id),
    isArchived: (id) => archived.has(id),
    isDirectory: (p) => fs.existsSync(p),
    respawn: async (agent) => {
      calls.respawn.push(agent.id);
      if (opts.failRespawn?.includes(agent.id)) return { ok: false, error: 'boom' };
      live.add(agent.id);
      return { ok: true };
    },
    pid: opts.pid ?? 1001,
    processAlive: (pid) => (opts.alivePids ?? []).includes(pid),
    log: (step) => calls.log.push(step),
    now: () => Date.parse('2026-11-12T10:00:00Z')
  };
  return { deps, live, archived, calls };
}

const record = (root) => JSON.parse(fs.readFileSync(path.join(root, RUNTIME_FILE), 'utf8')).agents.map((a) => a.id).sort();

test('agents live at quit are restored on relaunch, resumed, exactly once; god is left to the orchestrator path', async () => {
  const { root, cwd } = floor();
  const agents = { god: { id: 'god', name: 'God', provider: 'claude', cwd, isGod: true }, w1: { id: 'w1', name: 'W1', provider: 'claude', cwd }, w2: { id: 'w2', name: 'W2', provider: 'codex', cwd } };
  const before = host(root, { agents, live: ['god', 'w1', 'w2'] });
  const first = createParamountRuntime(before.deps);
  await first.beat();
  assert.deepEqual(record(root), ['god', 'w1', 'w2']);
  first.quit();

  const after = host(root, { agents, pid: 2002 }); // relaunch: nothing live yet
  const second = createParamountRuntime(after.deps);
  await second.beat();
  assert.deepEqual(after.calls.respawn.sort(), ['w1', 'w2']);
  await second.beat(); // later beats never restore again
  assert.deepEqual(after.calls.respawn.sort(), ['w1', 'w2']);
  assert.deepEqual(record(root), ['w1', 'w2']);
});

test('an agent already live is not spawned twice; an agent the human stopped stays stopped', async () => {
  const { root, cwd } = floor();
  const agents = { w1: { id: 'w1', name: 'W1', provider: 'claude', cwd }, w2: { id: 'w2', name: 'W2', provider: 'claude', cwd } };
  const a = host(root, { agents, live: ['w1', 'w2'] });
  await createParamountRuntime(a.deps).beat();
  const b = host(root, { agents, live: ['w1'], archived: ['w2'], pid: 2002 });
  await createParamountRuntime(b.deps).beat();
  assert.deepEqual(b.calls.respawn, []);
});

test('a second runtime on the same floor neither restores nor records while the first is alive', async () => {
  const { root, cwd } = floor();
  const agents = { w1: { id: 'w1', name: 'W1', provider: 'claude', cwd } };
  await createParamountRuntime(host(root, { agents, live: ['w1'], pid: 1001 }).deps).beat();
  const savedAt = fs.statSync(path.join(root, RUNTIME_FILE)).mtimeMs;
  const second = host(root, { agents, pid: 2002, alivePids: [1001] });
  await createParamountRuntime(second.deps).beat();
  assert.deepEqual(second.calls.respawn, []);
  assert.equal(fs.statSync(path.join(root, RUNTIME_FILE)).mtimeMs, savedAt);
  assert.equal(second.calls.log.at(-1).code, 'SECOND_RUNTIME');
  // Once the first process is gone, its stale lock is taken over.
  const third = host(root, { agents, pid: 3003, alivePids: [] });
  await createParamountRuntime(third.deps).beat();
  assert.deepEqual(third.calls.respawn, ['w1']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8')).pid, 3003);
});

test('after quit, terminals closing during shutdown do not erase the record', async () => {
  const { root, cwd } = floor();
  const agents = { w1: { id: 'w1', name: 'W1', provider: 'claude', cwd } };
  const h = host(root, { agents, live: ['w1'] });
  const runtime = createParamountRuntime(h.deps);
  await runtime.beat();
  runtime.quit();
  h.live.clear();
  await runtime.beat();
  assert.deepEqual(record(root), ['w1']);
  assert.equal(fs.existsSync(path.join(root, LOCK_FILE)), false);
});

test('a failed restore stays restorable, with a reason; a missing folder is reported, not spawned', async () => {
  const { root, cwd } = floor();
  const agents = { w1: { id: 'w1', name: 'W1', provider: 'claude', cwd }, w2: { id: 'w2', name: 'W2', provider: 'claude', cwd: path.join(cwd, 'gone') } };
  await createParamountRuntime(host(root, { agents, live: ['w1', 'w2'] }).deps).beat();
  const h = host(root, { agents, pid: 2002, failRespawn: ['w1'] });
  await createParamountRuntime(h.deps).beat();
  assert.deepEqual(h.calls.respawn, ['w1']);
  assert.deepEqual(record(root), ['w1', 'w2']);
  const codes = h.calls.log.filter((l) => l.step === 'restore').map((l) => `${l.agentId}:${l.code}`).sort();
  assert.deepEqual(codes, ['w1:SPAWN_FAILED', 'w2:CWD_MISSING']);
});

test('no floor yet (setup not finished): nothing is read or written', async () => {
  const { root } = floor();
  const h = host(root, { noFloor: true });
  await createParamountRuntime(h.deps).beat();
  assert.deepEqual(fs.readdirSync(root), []);
});

test('index.ts: the runtime stops recording only once a quit is certain, before terminals are killed', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  // Not on before-quit: with agents running, main defers that quit to the warning, which can be cancelled.
  assert.doesNotMatch(code, /registerParamountRuntime\([^\n]*onQuit: \(fn\) => app\.on\('before-quit', fn\)/);
  assert.match(code, /onQuit: \(fn\) => \{ beforeTeardown\.push\(fn\); app\.on\('will-quit', fn\);( keepFloorReleaseLast\(\);)? \}/);
  const start = code.indexOf('function teardownAndQuit(');
  assert.ok(start > 0);
  const teardown = code.slice(start);
  assert.ok(teardown.indexOf('for (const fn of beforeTeardown)') < teardown.indexOf('ptyManager.killAll()'));
});
