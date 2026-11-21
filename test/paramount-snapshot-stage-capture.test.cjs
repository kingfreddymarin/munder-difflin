'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { createSnapshotStageCapture } = loadTs('src/main/snapshotStageCapture.ts');
const { createSnapshotStageTimer } = loadTs('src/main/paramountSnapshotTiming.ts');

const stage = (cid = '123e4567-e89b-12d3-a456-426614174000', extra = {}) => ({
  kind: 'paramount-snapshot-stage', cid, stage: 'registry',
  syncMs: 321.2, waitMs: 0.3, totalMs: 321.5, outcome: 'ok', ...extra
});

function memoryFs() {
  const files = new Map();
  const modes = new Map();
  const dirs = new Set();
  return {
    files, modes, dirs,
    async mkdir(file, options) { dirs.add(file); modes.set(file, options.mode); },
    async chmod(file, mode) {
      if (!files.has(file) && !dirs.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      modes.set(file, mode);
    },
    async appendFile(file, text, options) {
      modes.set(file, files.has(file) ? modes.get(file) : options.mode);
      files.set(file, (files.get(file) ?? '') + text);
    },
    async stat(file) {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { size: Buffer.byteLength(files.get(file)) };
    },
    async rename(from, to) {
      if (!files.has(from)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      files.set(to, files.get(from));
      modes.set(to, modes.get(from));
      files.delete(from);
      modes.delete(from);
    },
    async unlink(file) {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      files.delete(file);
      modes.delete(file);
    }
  };
}

test('capture persists only validated timing fields with private modes and run correlation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-capture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = 1000;
  const first = createSnapshotStageCapture({ directory: root, appRunId: 'a'.repeat(32), version: '0.4.6', now: () => now++ });
  const second = createSnapshotStageCapture({ directory: root, appRunId: 'b'.repeat(32), version: '0.4.6', now: () => now++ });

  assert.equal(first.record(stage()), true);
  assert.equal(first.record({ kind: 'paramount-snapshot-stage', ...stage(), request: 'secret payload' }), false);
  assert.equal(first.record({ kind: 'paramount-snapshot-stage', cid: '../../private', stage: 'registry', syncMs: 1, waitMs: 0, totalMs: 1, outcome: 'ok' }), false);
  assert.equal(first.record({ kind: 'paramount-snapshot-stage', cid: 'safe', stage: 'registry', syncMs: Infinity, waitMs: 0, totalMs: 1, outcome: 'ok' }), false);
  assert.equal(first.record({ kind: 'paramount-snapshot-stage', cid: 'safe', stage: 'registry', syncMs: 3600001, waitMs: 0, totalMs: 1, outcome: 'ok' }), false);
  assert.equal(first.record({ kind: 'paramount-snapshot-stage', cid: 'c'.repeat(65), stage: 'registry', syncMs: 1, waitMs: 0, totalMs: 1, outcome: 'ok' }), false);
  assert.equal(first.record({ kind: 'paramount-lag', ms: 1, op: 'x'.repeat(16385) }), false);
  assert.equal(first.record({ kind: 'paramount-lag', ms: 5576, op: 'paramount.snapshot:sender=secret,worker-wake.beat' }), true);
  await first.flush();
  assert.equal(second.record(stage('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')), true);
  await second.flush();

  const directory = await fs.stat(root);
  assert.equal(directory.mode & 0o777, 0o700);
  const files = (await fs.readdir(root)).sort();
  assert.deepEqual(files, ['snapshot-timing.0.jsonl']);
  const file = path.join(root, files[0]);
  const meta = await fs.stat(file);
  assert.equal(meta.mode & 0o777, 0o600);
  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['appRunId', 'cid', 'kind', 'outcome', 'stage', 'syncMs', 'totalMs', 'ts', 'version', 'waitMs'].sort());
  assert.equal(rows[0].appRunId, 'a'.repeat(32));
  assert.equal(rows[2].appRunId, 'b'.repeat(32));
  assert.deepEqual(rows[1].operations, ['paramount.snapshot', 'worker-wake.beat']);
  assert.equal(JSON.stringify(rows).includes('secret'), false);
  assert.equal(JSON.stringify(rows).includes('private'), false);
  assert.equal(first.stats().invalid, 6);
});

test('the 32-record queue stays bounded and reports drops on the next captured record', async () => {
  const io = memoryFs();
  let releaseAppend;
  const originalAppend = io.appendFile;
  io.appendFile = async (...args) => {
    if (!releaseAppend) await new Promise((resolve) => { releaseAppend = resolve; });
    return originalAppend(...args);
  };
  const capture = createSnapshotStageCapture({ directory: '/private/diag', appRunId: 'c'.repeat(32), version: '0.4.6', fs: io });
  assert.equal(capture.record(stage()), true);
  for (let i = 1; i < 32; i++) assert.equal(capture.record(stage(`cid-${i}`)), true);
  assert.equal(capture.stats().queued, 32);
  assert.equal(capture.record(stage('overflow')), false);
  assert.equal(capture.stats().dropped, 1);
  while (!releaseAppend) await new Promise((resolve) => setImmediate(resolve));
  releaseAppend();
  await capture.flush();
  assert.equal(capture.record(stage('after-drop')), true);
  await capture.flush();

  const text = io.files.get('/private/diag/snapshot-timing.0.jsonl');
  const rows = text.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 33);
  assert.equal(rows.at(-1).droppedBefore, 1);
  assert.equal(capture.stats().queued, 0);
});

test('append and rotation failures stay out of the caller and the writer recovers', async () => {
  const io = memoryFs();
  const originalAppend = io.appendFile;
  let failAppend = true;
  io.appendFile = async (...args) => {
    if (failAppend) { failAppend = false; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
    return originalAppend(...args);
  };
  const capture = createSnapshotStageCapture({ directory: '/private/faults', appRunId: 'd'.repeat(32), version: '0.4.6', fs: io });
  let clock = 0;
  const timing = createSnapshotStageTimer({ now: () => clock, thresholdMs: 1, log: (event) => capture.record(event) });
  const ipcResult = timing.measure('123e4567-e89b-12d3-a456-426614174000', 'registry', () => { clock += 10; return 'ipc-result'; });
  assert.equal(ipcResult, 'ipc-result', 'asynchronous file failure cannot reject snapshot work');
  await capture.flush();
  assert.equal(capture.stats().writeFailures, 1);
  assert.equal(capture.record(stage('recovered')), true);
  await capture.flush();
  const rows = io.files.get('/private/faults/snapshot-timing.0.jsonl').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].droppedBefore, 1, 'failed write is visible without persisting error text');
  assert.equal(JSON.stringify(rows).includes('disk full'), false);

  const rotationFs = memoryFs();
  const directory = '/private/rotate';
  const current = path.join(directory, 'snapshot-timing.0.jsonl');
  rotationFs.files.set(current, 'x'.repeat(256 * 1024 - 32));
  rotationFs.modes.set(current, 0o600);
  for (let i = 1; i < 3; i++) {
    const archived = path.join(directory, `snapshot-timing.${i}.jsonl`);
    rotationFs.files.set(archived, `${i}`.repeat(256 * 1024 - 1));
    rotationFs.modes.set(archived, 0o600);
  }
  const originalRename = rotationFs.rename;
  let failRename = true;
  rotationFs.rename = async (...args) => {
    if (failRename) { failRename = false; throw Object.assign(new Error('rename denied'), { code: 'EACCES' }); }
    return originalRename(...args);
  };
  const rotating = createSnapshotStageCapture({ directory, appRunId: 'e'.repeat(32), version: '0.4.6', fs: rotationFs });
  assert.equal(rotating.record(stage()), true);
  await rotating.flush();
  assert.equal(rotating.stats().writeFailures, 1);
  assert.equal(Buffer.byteLength(rotationFs.files.get(current)), 256 * 1024 - 32, 'failed rotation never grows the current file');
  assert.equal(rotating.record(stage('rotation-retry')), true);
  await rotating.flush();
  const names = [...rotationFs.files.keys()].filter((name) => name.startsWith(directory));
  assert.ok(names.length <= 3);
  assert.ok(names.every((name) => Buffer.byteLength(rotationFs.files.get(name)) <= 256 * 1024));
  assert.ok([...rotationFs.files.values()].reduce((total, text) => total + Buffer.byteLength(text), 0) <= 3 * 256 * 1024);

  const retentionFs = memoryFs();
  const retentionDir = '/private/retention';
  const currentFile = path.join(retentionDir, 'snapshot-timing.0.jsonl');
  retentionFs.files.set(currentFile, 'c'.repeat(256 * 1024 - 32));
  retentionFs.files.set(path.join(retentionDir, 'snapshot-timing.1.jsonl'), 'previous-current');
  retentionFs.files.set(path.join(retentionDir, 'snapshot-timing.2.jsonl'), 'oldest');
  for (const file of retentionFs.files.keys()) retentionFs.modes.set(file, 0o600);
  const retention = createSnapshotStageCapture({ directory: retentionDir, appRunId: '7'.repeat(32), version: '0.4.6', fs: retentionFs });
  assert.equal(retention.record(stage()), true);
  await retention.flush();
  assert.equal(retentionFs.files.size, 3);
  assert.equal(retentionFs.files.get(path.join(retentionDir, 'snapshot-timing.1.jsonl')), 'c'.repeat(256 * 1024 - 32));
  assert.equal(retentionFs.files.get(path.join(retentionDir, 'snapshot-timing.2.jsonl')), 'previous-current');
});

test('snapshot measure and event loop do not wait for a stalled asynchronous append', async () => {
  const io = memoryFs();
  let releaseAppend;
  io.appendFile = async () => new Promise((resolve) => { releaseAppend = resolve; });
  const capture = createSnapshotStageCapture({ directory: '/private/nonblocking', appRunId: 'f'.repeat(32), version: '0.4.6', fs: io });
  let clock = 0;
  const timer = createSnapshotStageTimer({ now: () => clock, thresholdMs: 1, log: (event) => capture.record(event) });
  const result = timer.measure('123e4567-e89b-12d3-a456-426614174000', 'registry', () => { clock += 20; return 'snapshot-result'; });
  assert.equal(result, 'snapshot-result');
  assert.equal(capture.stats().queued, 1);
  let ticked = false;
  setImmediate(() => { ticked = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ticked, true);
  assert.equal(capture.stats().queued, 1, 'capture is still waiting on fake disk');
  while (!releaseAppend) await new Promise((resolve) => setImmediate(resolve));
  releaseAppend();
  await capture.flush();
});

test('ordinary app wiring captures stages and lag in the app userData directory', () => {
  const source = require('node:fs').readFileSync('src/main/index.ts', 'utf8');
  assert.match(source, /directory:\s*join\(app\.getPath\('userData'\),\s*'diagnostics'\)/);
  assert.match(source, /appRunId:\s*randomBytes\(16\)\.toString\('hex'\)/);
  assert.match(source, /log:\s*\(event\)\s*=>\s*\{\s*snapshotStageCapture\.record\(event\);\s*\}/);
  assert.match(source, /snapshotStageCapture\.record\(event\);[\s\S]{0,180}hive\.appendLog\(event\)/);
  assert.doesNotMatch(source, /\[snapshot-stage\]/);
});

test('long production lag labels retain safe timing evidence', async () => {
 const io = memoryFs();
 const capture = createSnapshotStageCapture({ directory: '/virtual/capture', appRunId: 'c'.repeat(32), version: '0.4.6', fs: io });
 const op = Array.from({length: 40}, (_,i) => `paramount.snapshot:stage-${i}`).join(', ');
 assert.ok(op.length > 512);
 assert.equal(capture.record({kind:'paramount-lag',ms:900,op}),true);
 await capture.flush();
 const records = [...io.files.values()].flatMap(text => text.trim().split('\n').map(JSON.parse));
 assert.equal(records.length, 1);
 assert.deepEqual(records[0].operations, ['paramount.snapshot']);
 assert.equal(JSON.stringify(records).includes('stage-'), false);
});
