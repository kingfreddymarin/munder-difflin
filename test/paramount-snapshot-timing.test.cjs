'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { createSnapshotStageTimer } = loadTs('src/main/paramountSnapshotTiming.ts');

function timer(options = {}) {
  const events = [];
  return { events, stage: createSnapshotStageTimer({ now: () => Date.now(), log: (event) => events.push(event), ...options }) };
}

test('known-bad synchronous blocking stage is attributed with zero awaited time', () => {
  const { events, stage } = timer();
  const result = stage.measure('request-1', 'messages', () => {
    const until = Date.now() + 130;
    while (Date.now() < until) { /* intentional fixture stall */ }
    return ['synthetic'];
  });
  assert.deepEqual(result, ['synthetic']);
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'messages');
  assert.ok(events[0].syncMs >= 100);
  assert.equal(events[0].waitMs, 0);
  assert.equal(events[0].cid, 'request-1');
  assert.equal(JSON.stringify(events).includes('synthetic'), false, 'no result payload is logged');
});

test('known-good fast stage is quiet', () => {
  const { events, stage } = timer();
  assert.equal(stage.measure('request-1', 'registry', () => 7), 7);
  assert.deepEqual(events, []);
});

test('snapshot handler wires all named stages in its existing evaluation order', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const start = source.indexOf("ipcMain.handle('paramount:snapshot'");
  const end = source.indexOf('/** Roots for agents.discover/import', start);
  assert.ok(start >= 0 && end > start, 'snapshot handler boundaries exist');
  const handler = source.slice(start, end);
  const stages = [...handler.matchAll(/time\('([A-Za-z]+)'/g)].map((match) => match[1]);
  assert.deepEqual(stages, [
    'config', 'floorSetup', 'hookHealth', 'orchestratorFailure',
    'registry', 'tasks', 'messages', 'organization', 'archivedAgents', 'log', 'roster',
    'activity', 'snapshotConfig', 'missions', 'ptys', 'preferences', 'integrations',
    'skidProbe', 'enginePaths', 'signIn'
  ]);
  assert.match(handler, /time\('skidProbe',\s*\(\) => paramountProbeService\('skid', span\.cid\)\)/);
  for (const value of [null, {message: 'failed'}]) {
    const actual = require('./snapshot-failure-fixture.cjs')(value);
    assert.equal(actual.reads, 1, 'snapshot failure knowledge is read once regardless of banner presence');
    assert.deepEqual(actual.stages, ['orchestratorFailure']);
  }
});

test('injected blocking at a real HiveManager messages boundary preserves its production result', () => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hive = new HiveManager(() => null);
  const productionRead = hive.voiceMessages.bind(hive);
  hive.voiceMessages = (opts) => {
    const result = productionRead(opts);
    const until = Date.now() + 120;
    while (Date.now() < until) { /* inject delay at the production boundary */ }
    return result;
  };
  const { events, stage } = timer();
  const messages = stage.measure('real-hive-fixture', 'messages', () => hive.voiceMessages({ limit: 500 }));
  assert.deepEqual(messages, [], 'the instrumented production helper returns its original result');
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'messages');
  assert.ok(events[0].syncMs >= 100);
  assert.equal(events[0].waitMs, 0);
});

test('async delay is reported as wait time rather than blocking synchronous time', async () => {
  const { events, stage } = timer();
  const value = await stage.measure('request-async', 'skidProbe', () => {
    return new Promise((resolve) => setTimeout(() => resolve('ok'), 110));
  });
  assert.equal(value, 'ok');
  assert.equal(events.length, 1);
  assert.ok(events[0].syncMs < 80);
  assert.ok(events[0].waitMs >= 100);
  assert.equal(events[0].totalMs, Math.round((events[0].syncMs + events[0].waitMs) * 10) / 10);
});

test('slow sync and async failures retain the original error and safe stage outcome', async () => {
  const { events, stage } = timer();
  const syncError = new Error('private payload must not be logged');
  assert.throws(() => stage.measure('sync-failure', 'organization', () => {
    const until = Date.now() + 110; while (Date.now() < until) { /* injected */ }
    throw syncError;
  }), (error) => error === syncError);
  const asyncError = new Error('another private payload');
  await assert.rejects(stage.measure('async-failure', 'skidProbe', () => new Promise((_, reject) => setTimeout(() => reject(asyncError), 110))), (error) => error === asyncError);
  assert.deepEqual(events.map(({ cid, outcome }) => [cid, outcome]), [['sync-failure', 'error'], ['async-failure', 'error']]);
  assert.equal(JSON.stringify(events).includes('private payload'), false);
});

test('overlapping requests keep their correlation IDs distinct', async () => {
  const { events, stage } = timer();
  await Promise.all([
    stage.measure('request-A', 'skidProbe', () => new Promise((resolve) => setTimeout(() => resolve('a'), 120))),
    stage.measure('request-B', 'skidProbe', () => new Promise((resolve) => setTimeout(() => resolve('b'), 140)))
  ]);
  assert.deepEqual(new Set(events.map((event) => event.cid)), new Set(['request-A', 'request-B']));
  assert.ok(events.every((event) => event.stage === 'skidProbe'));
});

test('a failing diagnostic sink cannot replace success and output is capped per window', () => {
  let now = 10;
  const events = [];
  const stage = createSnapshotStageTimer({ now: () => now, log: (event) => { events.push(event); if (events.length === 1) throw new Error('sink failure'); }, thresholdMs: 1, maxEventsPerWindow: 2, windowMs: 60_000 });
  assert.equal(stage.measure('a', 'config', () => { now += 3; return 'kept'; }), 'kept');
  assert.equal(stage.measure('b', 'config', () => { now += 3; return 'kept'; }), 'kept');
  assert.equal(stage.measure('c', 'config', () => { now += 3; return 'kept'; }), 'kept');
  assert.equal(events.length, 2, 'the hard cap is respected even if an emitted event sink throws');
});

test('a failing diagnostic sink cannot replace the original stage error', () => {
  let now = 10;
  const original = new Error('preserve this error');
  const stage = createSnapshotStageTimer({ now: () => now, log: () => { throw new Error('sink failure'); }, thresholdMs: 1 });
  assert.throws(() => stage.measure('failure', 'config', () => { now += 3; throw original; }), (error) => error === original);
});
