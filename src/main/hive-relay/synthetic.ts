import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyntheticHive, SyntheticHiveRelay } from './relay';
import { REQUEST_SCHEMA, digest, stableAddress, verifyReceipts, type RelayRequest } from './protocol';

export const ADDRESSES = {
  source: stableAddress('studio', 'god'),
  target: stableAddress('synthetic-research', 'god'),
  sessionOnly: stableAddress('synthetic-archive', 'god'),
};
export const BRIEF = Buffer.from('Synthetic release brief. Plan a read-only inventory.');
export const BRIEF_URI = 'studio-task://studio/NSC-192/task.md';

/** All paths are derived from a newly allocated fixture, never user or hive input. */
export function createSyntheticFloorPair(root: string, clock: () => Date = () => new Date()) {
  const sourceRoot = join(root, 'source');
  const targetRoot = join(root, 'target');
  mkdirSync(sourceRoot, { mode: 0o700, recursive: true });
  mkdirSync(targetRoot, { mode: 0o700, recursive: true });
  const sourcePath = join(sourceRoot, 'tasks.json');
  const targetPath = join(targetRoot, 'tasks.json');
  const journal = join(root, 'relay-journal.json');
  const source = new SyntheticHive({ id: 'studio', managerRole: 'god', acceptFrom: [], mode: 'active' }, sourcePath);
  const target = new SyntheticHive({ id: 'synthetic-research', managerRole: 'god', acceptFrom: [source.address], mode: 'active' }, targetPath);
  const sessionOnly = new SyntheticHive({ id: 'synthetic-archive', managerRole: 'god', acceptFrom: [], mode: 'session-only' }, join(root, 'unused.json'));
  const makeRelay = () => new SyntheticHiveRelay(journal, [source, target, sessionOnly], clock);
  const connectSource = (relay: SyntheticHiveRelay) => relay.connect(source, (uri) => uri === BRIEF_URI ? Buffer.from(BRIEF) : undefined);
  return { makeRelay, connectSource, journal, sourcePath, targetPath, source, target, sessionOnly };
}

export function syntheticRequest(now: Date, target = ADDRESSES.target, revision = 1): RelayRequest {
  return {
    schema: REQUEST_SCHEMA,
    requestId: randomUUID(),
    idempotencyKey: `${ADDRESSES.source}:NSC-192:${revision}`,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 180_000).toISOString(),
    from: ADDRESSES.source, to: target, replyTo: ADDRESSES.source,
    work: { parentId: 'NSC-192', title: 'Plan the synthetic inventory', revision },
    contract: {
      objective: 'Plan a read-only inventory using the synthetic release brief.',
      output: 'A target-local task with a scoped plan contract',
      tools: ['read-reference'], boundaries: ['read-only', 'no external actions'],
      doneMeans: ['The target records the bound task and replies with its local ID'],
    },
    references: [{ uri: BRIEF_URI, sha256: digest(BRIEF) }],
    requestedCapability: 'workflow.plan',
    sideEffectClass: 'read-only',
    policyVersion: 'v1',
    budget: { tokenCap: 6000, contextCapPercent: 50 },
  };
}

export function runSyntheticRelay(command: 'peers' | 'delegate' | 'prove', send: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'paramount-hive-relay-'));
  try {
    const now = new Date();
    const fixture = createSyntheticFloorPair(root, () => now);
    const relay = fixture.makeRelay();
    const source = fixture.connectSource(relay);
    const receiver = relay.connect(fixture.target);
    if (command === 'peers') return { scope: 'synthetic', peers: relay.directory() };
    const request = syntheticRequest(now);
    if (command === 'delegate' && !send) return { scope: 'synthetic', dryRun: true, request };

    const serialized = JSON.stringify(request);
    const accepted = source.submit(serialized);
    if (command === 'delegate') return { scope: 'synthetic', receipts: accepted };
    const receipts = receiver.complete(request.requestId);
    const replay = source.submit(serialized);
    receiver.disconnect();
    const offline = source.submit(JSON.stringify(syntheticRequest(now, ADDRESSES.target, 2)));
    const sessionOnly = source.submit(JSON.stringify(syntheticRequest(now, ADDRESSES.sessionOnly, 3)));

    const restarted = fixture.makeRelay();
    restarted.connect(fixture.target);
    const afterRestart = fixture.connectSource(restarted).submit(serialized);
    return {
      scope: 'synthetic', audit: restarted.audit(),
      valid: verifyReceipts(receipts) && receipts.at(-1)?.state === 'completed'
        && JSON.stringify(receipts) === JSON.stringify(replay) && JSON.stringify(receipts) === JSON.stringify(afterRestart)
        && offline[0].reason === 'offline' && sessionOnly[0].reason === 'offline',
      receipts, offline, sessionOnly,
    };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
