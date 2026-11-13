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

test('index.ts: terminals a quit, Switch floor or floor move stops keep their registry entry, so the runtime restores them', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  // Isolated check 2026-11-12 (build d14fe26f): after Switch floor, the hired agent was archived by
  // its terminal's exit and the reopened floor skipped it ("restored 0, skipped 2").
  assert.match(code, /teardownPty\(id, \{ keepEntry: !!failedStart \|\| allowQuit \}\);/);
  // allowQuit is set before any terminal is killed on each of those paths.
  for (const start of ['function teardownAndQuit(', "ipcMain.handle('config:changeHome'"]) {
    const body = code.slice(code.indexOf(start));
    assert.ok(body.indexOf('allowQuit = true;') > 0 && body.indexOf('allowQuit = true;') < body.indexOf('ptyManager.killAll()'), start);
  }
  // And a restore skips archived agents, which is why the flag matters.
  const runtime = fs.readFileSync(path.join(__dirname, '../src/main/paramount-runtime.ts'), 'utf8');
  assert.match(runtime, /if \(deps\.isLive\(agent\.id\) \|\| deps\.isArchived\(agent\.id\)\) \{ result\.skipped\.push/);
});

test('boot leaves agents recorded as live at the last quit for the runtime to restore (isolated check 2026-11-12)', () => {
  // archiveOrphanedAgents archived every non-live agent at boot, and restoreAgents skips archived
  // ones, so no hired agent came back after a quit or Switch floor (restore-summary restored 0).
  const code = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const fn = code.slice(code.indexOf('function archiveOrphanedAgents('), code.indexOf('function archiveOrphanedAgents(') + 1600);
  assert.match(fn, /const recorded = new Set\(root \? readRecord\(root\)\.map\(\(a\) => a\.id\) : \[\]\);/);
  assert.ok(fn.indexOf('if (recorded.has(id)) continue;') < fn.indexOf('hive.setArchived(id, true);'));
});

test('restore: a recorded agent left unarchived is respawned; an archived one (stopped by the human) is skipped', async (t) => {
  const { restoreAgents, RUNTIME_FILE } = loadTs('src/main/paramount-runtime.ts');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'council-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, RUNTIME_FILE), JSON.stringify({ schema: 'paramount-runtime-v1', savedAt: '', agents: [{ id: 'god', name: 'G', provider: 'claude', cwd: root, isGod: true }, { id: 'tester-2', name: 'T', provider: 'claude', cwd: root }, { id: 'stopped', name: 'S', provider: 'claude', cwd: root }] }));
  const spawned = [];
  const r = await restoreAgents(root, { isLive: () => false, isArchived: (id) => id === 'stopped', isDirectory: () => true, respawn: async (a) => { spawned.push(a.id); return { ok: true }; }, log() {} });
  assert.deepEqual(spawned, ['tester-2']);
  assert.deepEqual(r, { restored: ['tester-2'], skipped: ['god', 'stopped'], failed: [] });
});

test('the 4-second snapshot logs only failures, and the service probe only state changes (owner run of ceeb4aaf: 377 lines in 40 min)', async () => {
  const { traced } = loadTs('src/main/paramountObservability.ts');
  const lines = [];
  await traced('paramount.snapshot', (e) => lines.push(e), {}, async () => ({ ok: true }), { quiet: true });
  assert.deepEqual(lines, []);
  await traced('paramount.snapshot', (e) => lines.push(e), {}, async () => { throw new Error('boom'); }, { quiet: true });
  assert.ok(lines.some((l) => l.phase === 'end' && l.outcome === 'fail'));
  const code = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.match(code, /\}\), \{ rethrow: true, quiet: true \}\)\);\n\/\*\* Roots for agents\.discover\/import/);
  assert.match(code, /if \(lastProbeState\.get\(prereqId\) !== state\) \{/);
});

// Owner use of 63ea664e on the Varium floor (last run by Munder): boot archived dwight, kevin, kelly and
// jim, and only the god came back (restore-summary restored 0). Munder restores its team from its own
// renderer record, so a floor it ran has no Council record. The live team is seeded from the registry.
function orphanBoot(root, registry) {
  const ts = require('typescript'); const vm = require('node:vm');
  const code = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const src = code.slice(code.indexOf('function archiveOrphanedAgents('), code.indexOf('\n}\n', code.indexOf('function archiveOrphanedAgents(')) + 3);
  const runtime = loadTs('src/main/paramount-runtime.ts');
  const ctx = { console: { log() {}, error: console.error }, Date, readRecord: runtime.readRecord, seedRecordFromRegistry: runtime.seedRecordFromRegistry,
    ptyForAgent: () => undefined,
    hive: { enabled: () => true, root: () => root, registry: () => registry, setArchived: (id, v) => { registry.agents[id].archived = v; } } };
  vm.runInNewContext(ts.transpileModule(src + '\narchiveOrphanedAgents();', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, ctx);
  return runtime;
}
const munderFloor = (cwd) => ({ godId: 'god', agents: {
  god: { name: 'Michael', provider: 'claude', isGod: true, cwd },
  'dwight-mvqtyx2n': { name: 'Dwight', provider: 'claude', cwd }, 'kevin-mvqxdggy': { name: 'Kevin', provider: 'codex', cwd },
  'kelly-mvqxdx82': { name: 'Kelly', provider: 'claude', cwd }, 'jim-mw9iivm1': { name: 'Jim', provider: 'claude', cwd },
  'worker-abc': { name: 'Temp', provider: 'claude', role: 'worker', cwd }, old: { name: 'Old', provider: 'claude', cwd, archived: true } } });

for (const [label, prior] of [['no record', null], ['a record with only the god', [{ id: 'god', name: 'Michael', provider: 'claude', cwd: '.', isGod: true }]]]) {
  test(`a floor last run by Munder (${label}): its 4 agents stay unarchived and are restored at boot`, async (t) => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'council-munder-floor-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { restoreAgents, RUNTIME_FILE } = loadTs('src/main/paramount-runtime.ts');
    if (prior) fs.writeFileSync(path.join(root, RUNTIME_FILE), JSON.stringify({ schema: 'paramount-runtime-v1', savedAt: '', agents: prior.map((a) => ({ ...a, cwd: root })) }));
    const registry = munderFloor(root);
    orphanBoot(root, registry);
    const team = ['dwight-mvqtyx2n', 'kevin-mvqxdggy', 'kelly-mvqxdx82', 'jim-mw9iivm1'];
    for (const id of team) assert.notEqual(registry.agents[id].archived, true, `${id} not archived at boot`);
    assert.equal(registry.agents['worker-abc'].archived, true, 'a temp is still archived');
    const spawned = [];
    const r = await restoreAgents(root, { isLive: () => false, isArchived: (id) => registry.agents[id]?.archived === true, isDirectory: () => true,
      respawn: async (a) => { spawned.push(a.id); return { ok: true }; }, log() {} });
    assert.deepEqual(spawned.sort(), [...team].sort());
    assert.equal(r.restored.length, 4);
    assert.ok(!spawned.includes('old') && !spawned.includes('worker-abc'));
  });
}

test('a stale Council record (Munder hired more after it) gains the missing live agents; a stopped agent stays archived', (t) => {
  // Review K1 (b): Council ran the floor with Dwight, then Munder hired Kevin, Kelly and Jim. Only
  // Dwight was in Council's record, so the others were archived at the next Council open.
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'council-own-floor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { RUNTIME_FILE, readRecord } = loadTs('src/main/paramount-runtime.ts');
  fs.writeFileSync(path.join(root, RUNTIME_FILE), JSON.stringify({ schema: 'paramount-runtime-v1', savedAt: '', agents: [{ id: 'dwight-mvqtyx2n', name: 'Dwight', provider: 'claude', cwd: root }] }));
  const registry = munderFloor(root);
  orphanBoot(root, registry);
  const team = ['dwight-mvqtyx2n', 'jim-mw9iivm1', 'kelly-mvqxdx82', 'kevin-mvqxdggy'];
  assert.deepEqual(readRecord(root).map((a) => a.id).sort(), team);
  for (const id of team) assert.notEqual(registry.agents[id].archived, true, `${id} not archived at boot`);
  assert.equal(registry.agents.old.archived, true, 'stopped by the human: stays archived');
  assert.equal(registry.agents['worker-abc'].archived, true, 'a temp is still archived');
});

test('a record that already lists every live agent is not rewritten', (t) => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'council-own-floor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { RUNTIME_FILE, seedRecordFromRegistry } = loadTs('src/main/paramount-runtime.ts');
  const ids = ['dwight-mvqtyx2n', 'kevin-mvqxdggy', 'kelly-mvqxdx82', 'jim-mw9iivm1'];
  const body = JSON.stringify({ schema: 'paramount-runtime-v1', savedAt: 'x', agents: ids.map((id) => ({ id, name: id, provider: 'claude', cwd: root })) });
  fs.writeFileSync(path.join(root, RUNTIME_FILE), body);
  assert.deepEqual(seedRecordFromRegistry(root, munderFloor(root), 1), []);
  assert.equal(fs.readFileSync(path.join(root, RUNTIME_FILE), 'utf8'), body);
});
