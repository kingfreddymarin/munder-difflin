'use strict';

const { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { ADDRESSES, createSyntheticFloorPair, syntheticRequest, runSyntheticRelay } = loadTs('src/main/hive-relay/synthetic.ts');
const { verifyReceipts } = loadTs('src/main/hive-relay/protocol.ts');
const { SyntheticHiveRelay } = loadTs('src/main/hive-relay/relay.ts');
const NOW = new Date('2026-11-21T12:00:00Z');

function fixture(t, clock = () => NOW) {
  const root = mkdtempSync(join(tmpdir(), 'pm-relay-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pair = createSyntheticFloorPair(root, clock);
  const relay = pair.makeRelay();
  const sourceClient = pair.connectSource(relay);
  return { ...pair, relay, sourceClient };
}

const serialized = (request) => JSON.stringify(request);
function tasks(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('the registered source binds one target-local task, with metadata-only public audit', (t) => {
  const f = fixture(t);
  f.relay.connect(f.target);
  const request = syntheticRequest(NOW);
  const received = f.sourceClient.submit(serialized(request));
  assert.equal(verifyReceipts(received), true);
  assert.deepEqual(received.map(({ state }) => state), ['received', 'accepted']);
  assert.equal(received[1].emitter, ADDRESSES.target);
  assert.equal(received[1].targetManifestHash, f.target.manifestHash);
  assert.deepEqual(f.sourceClient.submit(serialized(request)), received);
  assert.equal(tasks(f.targetPath).length, 1);
  assert.deepEqual(tasks(f.targetPath)[0].request, request);
  assert.equal(tasks(f.targetPath)[0].taskId, received[1].targetTaskId);
  assert.equal(existsSync(f.sourcePath), false);
  const publicAudit = JSON.stringify(f.relay.audit());
  assert.ok(!publicAudit.includes('objective') && !publicAudit.includes(request.contract.objective));
  received[1].targetTaskId = 'changed-by-client';
  assert.equal(verifyReceipts(received), false);
  assert.equal(f.sourceClient.submit(serialized(request))[1].targetTaskId, 'XH-0001');
});

test('offline, session-only, unknown, expired and unavailable source sessions are refused', (t) => {
  const f = fixture(t);
  assert.equal(f.sourceClient.submit(serialized(syntheticRequest(NOW)))[0].reason, 'offline');
  assert.equal(f.sourceClient.submit(serialized(syntheticRequest(NOW, ADDRESSES.sessionOnly, 2)))[0].reason, 'offline');
  assert.equal(f.sourceClient.submit(serialized(syntheticRequest(NOW, 'studio://hive/unknown/agent/god', 3)))[0].reason, 'unknown_target');
  assert.throws(() => f.relay.connect(f.sessionOnly), /no registered floor/);
  const first = f.relay.connect(f.target);
  const second = f.relay.connect(f.target);
  first.disconnect();
  assert.throws(() => first.submit(serialized(syntheticRequest(NOW))), /disconnected/);
  assert.equal(f.relay.directory().find((peer) => peer.address === f.target.address).state, 'online');
  second.disconnect();
  const expired = syntheticRequest(new Date(NOW.getTime() - 180_000), ADDRESSES.target, 4);
  assert.equal(f.sourceClient.submit(serialized(expired))[0].state, 'expired');
  assert.equal(existsSync(f.targetPath), false);
  assert.throws(() => new SyntheticHiveRelay(f.journal, [f.target, f.target]), /Duplicate hive address/);
});

test('the transport rejects forged identity, mutated retries, unknown fields, secrets and unverified references', (t) => {
  const f = fixture(t);
  const target = f.relay.connect(f.target);
  const request = syntheticRequest(NOW);
  assert.throws(() => target.submit(serialized(request)), /sender does not match/);
  assert.throws(() => f.sourceClient.submit(serialized({ ...request, launcher: '/bin/sh' })), /Invalid envelope fields/);
  assert.throws(() => f.sourceClient.submit(serialized({ ...request, contract: { ...request.contract, objective: 'password: sample' } })), /Invalid bounded contract/);
  assert.throws(() => f.sourceClient.submit(serialized({ ...request, contract: { ...request.contract, objective: 'Read /tmp/private' } })), /Invalid bounded contract/);
  const unknownReference = { ...request, references: [{ ...request.references[0], sha256: '0'.repeat(64) }] };
  assert.equal(f.sourceClient.submit(serialized(unknownReference))[0].reason, 'invalid_reference');
  assert.throws(() => f.sourceClient.submit(serialized(request)), /different envelope/);
  assert.throws(() => f.sourceClient.submit(serialized({ ...request, requestId: '../etc/passwd' })), /Invalid request identity/);
  assert.equal(existsSync(f.targetPath), false);
});

test('an interruption after binding returns the original task on a retry after expiry', (t) => {
  let time = NOW;
  const f = fixture(t, () => time);
  const bind = f.target.bind.bind(f.target);
  f.target.bind = (...params) => {
    bind(...params);
    throw new Error('Simulated interruption after saving the local task');
  };
  f.relay.connect(f.target);
  const request = syntheticRequest(NOW);
  assert.throws(() => f.sourceClient.submit(serialized(request)), /Simulated interruption/);
  assert.equal(tasks(f.targetPath).length, 1);
  time = new Date(NOW.getTime() + 180_001);
  const restarted = f.makeRelay();
  const source = f.connectSource(restarted);
  assert.deepEqual(source.submit(serialized(request)).map((receipt) => receipt.state), ['received']);
  f.target.bind = bind;
  restarted.connect(f.target);
  assert.equal(source.submit(serialized(request)).at(-1).targetTaskId, 'XH-0001');
  assert.equal(tasks(f.targetPath).length, 1);
  const state = JSON.parse(readFileSync(f.journal, 'utf8'));
  state[0].receipts[1].targetTaskId = 'tampered';
  writeFileSync(f.journal, JSON.stringify(state));
  assert.throws(() => f.makeRelay(), /journal integrity/);
});

test('the command proof uses synthetic floors and delegate defaults to dry run', () => {
  assert.equal(runSyntheticRelay('delegate', false).dryRun, true);
  assert.equal(runSyntheticRelay('delegate', true).receipts.at(-1).state, 'accepted');
  assert.equal(runSyntheticRelay('prove', false).valid, true);
});

test('only the target can finalize its synthetic plan and return verifiable evidence', (t) => {
  const f = fixture(t);
  const receiver = f.relay.connect(f.target);
  const request = syntheticRequest(NOW);
  f.sourceClient.submit(serialized(request));
  assert.throws(() => f.sourceClient.complete(request.requestId), /Only the registered target/);
  const receipts = receiver.complete(request.requestId);
  assert.equal(verifyReceipts(receipts), true);
  assert.deepEqual(receipts.map((receipt) => receipt.state), ['received', 'accepted', 'started', 'completed']);
  const evidence = receipts.at(-1).evidence[0];
  const { digest } = loadTs('src/main/hive-relay/protocol.ts');
  assert.equal(evidence.sha256, digest(tasks(f.targetPath)[0].result));
  assert.match(evidence.uri, /^studio-evidence:\/\/synthetic-research\/XH-0001\//);
  assert.deepEqual(receiver.complete(request.requestId), receipts);
  assert.deepEqual(f.sourceClient.submit(serialized(request)), receipts);
  assert.deepEqual(f.makeRelay().audit().map((entry) => entry.state), receipts.map((receipt) => receipt.state));
});
