'use strict';
// Owner use of 8f574966 (NSC-206): "I see the beach ball too much". The Electron main thread stopped
// pumping events while the Paramount snapshot (polled every few seconds) re-read every message of every
// agent, and while launcher discovery and git ran as blocking child processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

test('the lag probe logs a stall over 200 ms with the operations running during it, and nothing below', () => {
  const { createLagProbe } = loadTs('src/main/lag-probe.ts');
  let now = 0; const lines = [];
  const probe = createLagProbe({ now: () => now, log: (e) => lines.push(e) });
  now = 100; probe.tick();                       // on time
  const end = probe.begin('paramount.snapshot');
  now = 250; end();                              // finished inside the next stall window
  const other = probe.begin('paramount.dispatch:orchestrator.ensure');
  now = 650; probe.tick();                       // due at 200, fired at 650: 450 ms late
  other();
  now = 750; probe.tick();                       // on time again
  now = 1100; probe.tick();                      // 250 ms late, nothing running
  assert.deepEqual(JSON.parse(JSON.stringify(lines)), [
    { kind: 'paramount-lag', ms: 450, op: 'paramount.snapshot, paramount.dispatch:orchestrator.ensure' },
    { kind: 'paramount-lag', ms: 250, op: 'unknown' },
  ]);
});

test('traced() operations report to the running probe (a blocking snapshot is named)', async () => {
  const { startLagProbe } = loadTs('src/main/lag-probe.ts');
  const { traced } = loadTs('src/main/paramountObservability.ts');
  const lines = [];
  const stop = startLagProbe({ now: () => Date.now(), log: (e) => lines.push(e), intervalMs: 50, thresholdMs: 150 });
  try {
    await new Promise((r) => setTimeout(r, 120));
    await traced('paramount.snapshot', null, {}, () => { const until = Date.now() + 400; while (Date.now() < until) { /* block */ } return { ok: true }; }, { quiet: true });
    await new Promise((r) => setTimeout(r, 120));
  } finally { stop(); }
  const stall = lines.find((l) => l.kind === 'paramount-lag');
  assert.ok(stall, 'a stall was logged');
  assert.ok(stall.ms >= 250, `ms ${stall.ms}`);
  assert.match(stall.op, /paramount\.snapshot/);
});

function bigFloor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'council-lag-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'hive');
  fs.mkdirSync(root, { recursive: true });
  const line = JSON.stringify({ ts: 1, kind: 'paramount-op', phase: 'end', cid: 'c'.repeat(36), op: 'paramount.dispatch', outcome: 'ok', durationMs: 3, context: { note: 'n'.repeat(200) } });
  fs.writeFileSync(path.join(root, 'log.jsonl'), (line + '\n').repeat(50_000) + JSON.stringify({ ts: 2, kind: 'last', note: 'é✓' }) + '\n');
  for (let a = 0; a < 5; a++) {
    const dir = path.join(root, 'agents', `a${a}`);
    for (const d of ['inbox/.done', 'outbox/.sent']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, 'identity.md'), 'x');
    for (let i = 0; i < 1000; i++) {
      const m = { id: `m-${a}-${i}`, from: `a${a}`, to: 'god', act: 'inform', subject: 's', body: 'b'.repeat(400), created_at: new Date(1e12 + (a * 1000 + i) * 1000).toISOString() };
      fs.writeFileSync(path.join(dir, i % 2 ? 'inbox/.done' : 'outbox/.sent', `${m.id}.json`), JSON.stringify(m));
    }
  }
  return { home, root };
}

test('a snapshot\'s floor reads stay under 50 ms with a 50k-line log and a 5k-message mailbox', (t) => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const { home } = bigFloor(t);
  const hive = new HiveManager(() => home);
  hive.voiceMessages({ limit: 500 }); hive.logTail(500); // first read after open
  // This process's CPU time: other test files running in parallel do not count against it.
  const started = process.cpuUsage();
  const messages = hive.voiceMessages({ limit: 500 });
  const log = hive.logTail(500);
  const used = process.cpuUsage(started);
  const ms = (used.user + used.system) / 1000;
  assert.ok(ms < 50, `snapshot floor reads took ${ms.toFixed(1)} ms of CPU`);
  assert.equal(messages.length, 40);
  assert.equal(messages[0].id, 'm-4-999', 'newest first');
  assert.equal(log.length, 500);
  assert.deepEqual(log.at(-1), { ts: 2, kind: 'last', note: 'é✓' });
});

test('a new or moved message shows on the next snapshot (the folder cache follows the folder)', (t) => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const { home, root } = bigFloor(t);
  const hive = new HiveManager(() => home);
  hive.voiceMessages({ limit: 5 });
  const m = { id: 'fresh', from: 'a0', to: 'god', act: 'inform', subject: 'new', body: 'b', created_at: '2099-01-01T00:00:00.000Z' };
  const tmp = path.join(root, 'agents', 'a0', 'outbox', '.fresh.tmp');
  fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, path.join(root, 'agents', 'a0', 'outbox', 'fresh.json'));
  assert.equal(hive.voiceMessages({ limit: 5 })[0].id, 'fresh');
  fs.renameSync(path.join(root, 'agents', 'a0', 'outbox', 'fresh.json'), path.join(root, 'agents', 'a0', 'outbox', '.sent', 'fresh.json'));
  const after = hive.voiceMessages({ limit: 5 })[0];
  assert.equal(after.id, 'fresh'); assert.equal(after.archived, true);
});

test('tailLines returns exactly the last lines, across chunk edges and multi-byte text', (t) => {
  const { tailLines } = loadTs('src/main/hive.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'log.jsonl');
  const lines = Array.from({ length: 3000 }, (_, i) => `${i}:${'ü'.repeat(i % 97)}`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  assert.deepEqual(tailLines(file, 1), [lines.at(-1)]);
  assert.deepEqual(tailLines(file, 1234), lines.slice(-1234));
  assert.deepEqual(tailLines(file, 9999), lines);
  fs.writeFileSync(file, '');
  assert.deepEqual(tailLines(file, 5), []);
});

test('launcher discovery runs the login shell off the main thread once warmed, and on refresh', async () => {
  const account = loadTs('src/main/council-account-launchers.ts');
  let sync = 0; let async = 0;
  const found = { status: 'ok', choices: [], profiles: [] };
  const cache = account.createLauncherDiscoveryCache(() => { sync++; return found; }, async () => { async++; return found; });
  await cache.warm();
  assert.equal(cache.current(), found);
  await cache.refresh();
  assert.deepEqual({ sync, async }, { sync: 0, async: 2 }, 'never the blocking probe after warm-up');
  assert.equal(cache.warm(), undefined, 'warm is a no-op once discovered');
});

test('index.ts: the snapshot reads the config once; discovery is warmed at boot; the probe is started', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const start = src.indexOf("ipcMain.handle('paramount:snapshot'");
  const body = src.slice(start, src.indexOf('{ rethrow: true, quiet: true }));', start));
  assert.equal((body.match(/readConfig\(\)/g) ?? []).length, 1);
  assert.match(src, /createLauncherDiscoveryCache\(discoverLaunchers, discoverLaunchersAsync\)/);
  assert.match(src, /void launcherDiscovery\.warm\(\)/);
  assert.match(src, /startLagProbe\(\{ now: \(\) => Date\.now\(\), log:/);
});
