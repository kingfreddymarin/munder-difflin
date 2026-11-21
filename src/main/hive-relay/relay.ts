import type { RelayRequest, Receipt, Decision, Reference } from './protocol';
import { appendReceipt, canonical, digest, parseRequest, stableAddress, verifyReceipts } from './protocol';
import { readState, replaceState } from './store';

type Manifest = { id: string; managerRole: string; acceptFrom: readonly string[]; mode: 'active' | 'session-only' };
type Delivery = (raw: string, sender: string, deliveryHash: string, now: Date) => Decision;
type Binding = { requestId: string; requestHash: string; taskId: string; request: RelayRequest; result?: string };
type Completion = { evidence: Reference; bytes: string };
type Journal = { request: RelayRequest; requestHash: string; targetManifestHash: string | null; receipts: Receipt[] };
type Session = { bind: Delivery; finish: (requestId: string, taskId: string, hash: string) => Completion; resolve: (uri: string) => Buffer | undefined };

function expired(request: RelayRequest, now: Date) {
  return Date.parse(request.expiresAt) <= now.getTime();
}

/** An adapter can only act on its own journal. The relay vouches for the exact validated bytes. */
export class SyntheticHive {
  readonly address: string;
  readonly manifestHash: string;
  readonly mode: Manifest['mode'];
  private readonly allowedSources: Set<string>;

  constructor(manifest: Manifest, private readonly taskStore: string) {
    this.address = stableAddress(manifest.id, manifest.managerRole);
    this.manifestHash = digest(canonical(manifest));
    this.mode = manifest.mode;
    this.allowedSources = new Set(manifest.acceptFrom);
  }

  accepts(sender: string) {
    return this.mode === 'active' && this.allowedSources.has(sender);
  }

  bind(raw: string, sender: string, deliveryHash: string, now: Date): Decision {
    const request = parseRequest(raw);
    if (request.from !== sender || request.to !== this.address || !this.accepts(sender) || digest(canonical(request)) !== deliveryHash) {
      return { state: 'rejected', reason: 'policy_denied' };
    }
    const existing = readState<Binding[]>(this.taskStore, []);
    const bound = existing.find((entry) => entry.request.idempotencyKey === request.idempotencyKey);
    if (bound) {
      if (bound.requestId !== request.requestId || bound.requestHash !== deliveryHash) return { state: 'rejected', reason: 'policy_denied' };
      return { state: 'accepted', targetTaskId: bound.taskId, targetManifestHash: this.manifestHash };
    }
    if (expired(request, now)) return { state: 'expired', reason: 'expired' };
    const taskId = `XH-${String(existing.length + 1).padStart(4, '0')}`;
    replaceState(this.taskStore, [...existing, { requestId: request.requestId, requestHash: deliveryHash, taskId, request }]);
    return { state: 'accepted', targetTaskId: taskId, targetManifestHash: this.manifestHash };
  }

  finish(requestId: string, taskId: string, requestHash: string): Completion {
    const tasks = readState<Binding[]>(this.taskStore, []);
    const task = tasks.find((entry) => entry.requestId === requestId && entry.taskId === taskId && entry.requestHash === requestHash);
    if (!task) throw new Error('Only a bound target task can complete');
    // This fixture produces deterministic evidence. It never invokes a worker or provider.
    const bytes = task.result ?? `Synthetic plan\nGoal: ${task.request.contract.objective}\nExpected output: ${task.request.contract.output}\n`;
    if (task.result === undefined) {
      replaceState(this.taskStore, tasks.map((entry) => entry === task ? { ...task, result: bytes } : entry));
    }
    const hiveId = this.address.split('/')[3];
    return { bytes, evidence: { uri: `studio-evidence://${hiveId}/${taskId}/plan.txt`, sha256: digest(bytes) } };
  }
}

/** Trusted app-side coordinator for the synthetic rollout. Peer clients hold a
 * session-bound handle. They cannot choose an identity, filesystem path or launcher. */
export class SyntheticHiveRelay {
  private readonly peers = new Map<string, SyntheticHive>();
  private readonly live = new Map<string, Session>();
  private entries: Journal[];

  constructor(private readonly journalPath: string, peers: readonly SyntheticHive[],
    private readonly clock: () => Date = () => new Date()) {
    for (const peer of peers) {
      if (this.peers.has(peer.address)) throw new Error('Duplicate hive address');
      this.peers.set(peer.address, peer);
    }
    this.entries = readState<Journal[]>(journalPath, []);
    const requestIds = new Set<string>();
    const idempotencyKeys = new Set<string>();
    for (const entry of this.entries) {
      const request = parseRequest(JSON.stringify(entry.request));
      if (requestIds.has(request.requestId) || idempotencyKeys.has(request.idempotencyKey) || !verifyReceipts(entry.receipts) || request.requestId !== entry.receipts[0].requestId
        || digest(canonical(request)) !== entry.requestHash
        || entry.receipts.slice(1).some((receipt) => receipt.emitter !== request.to && receipt.reason !== 'stale_directory')
        || entry.receipts.some((receipt) => receipt.state === 'accepted' && receipt.targetManifestHash !== entry.targetManifestHash)) {
        throw new Error('Relay journal integrity check failed');
      }
      requestIds.add(request.requestId);
      idempotencyKeys.add(request.idempotencyKey);
    }
  }

  /** Only harness setup calls connect. Every replacement revokes the previous handle. */
  connect(peer: SyntheticHive, resolve: Session['resolve'] = () => undefined) {
    if (this.peers.get(peer.address) !== peer || peer.mode !== 'active') throw new Error('Peer has no registered floor transport');
    const session: Session = { bind: peer.bind.bind(peer), finish: peer.finish.bind(peer), resolve };
    this.live.set(peer.address, session);
    return {
      submit: (raw: string) => {
        if (this.live.get(peer.address) !== session) throw new Error('Floor transport is disconnected');
        return this.submit(peer.address, session, raw);
      },
      complete: (requestId: string) => {
        if (this.live.get(peer.address) !== session) throw new Error('Floor transport is disconnected');
        return this.complete(peer, session, requestId);
      },
      disconnect: () => {
        if (this.live.get(peer.address) === session) this.live.delete(peer.address);
      },
    };
  }

  directory() {
    return [...this.peers.values()].map((peer) => ({
      address: peer.address,
      state: peer.mode === 'session-only' ? 'session-only' : this.live.has(peer.address) ? 'online' : 'offline',
      manifestHash: peer.manifestHash,
      capabilities: peer.mode === 'active' ? ['workflow.plan'] : [],
    }));
  }

  audit() {
    return this.entries.flatMap(({ request, requestHash, receipts }) => receipts.map((receipt) => ({
      ...receipt, from: request.from, to: request.to, workCapability: request.requestedCapability, requestHash,
    })));
  }

  private save(entry: Journal) {
    const key = entry.request.requestId;
    const index = this.entries.findIndex((item) => item.request.requestId === key);
    const next = index < 0 ? [...this.entries, entry] : this.entries.map((item, i) => i === index ? entry : item);
    replaceState(this.journalPath, next);
    this.entries = next;
  }

  private submit(sender: string, session: Session, raw: string): Receipt[] {
    const request = parseRequest(raw);
    if (request.from !== sender) throw new Error('Envelope sender does not match the floor transport');
    const requestHash = digest(canonical(request));
    let entry = this.entries.find(({ request: known }) => known.idempotencyKey === request.idempotencyKey || known.requestId === request.requestId);
    if (entry && entry.requestHash !== requestHash) throw new Error('Request identity already binds a different envelope');
    if (entry && (entry.receipts.length > 1 || entry.receipts[0].state !== 'received')) return structuredClone(entry.receipts);

    const now = this.clock();
    const peer = this.peers.get(request.to);
    const receiver = this.live.get(request.to);
    if (!entry) {
      const denied: Decision | null = this.admit(request, session, peer, receiver, now);
      entry = { request, requestHash, targetManifestHash: peer?.manifestHash ?? null,
        receipts: [appendReceipt([], request.requestId, 'studio://relay', now.toISOString(), denied ?? { state: 'received' })] };
      this.save(entry);
      if (denied) return structuredClone(entry.receipts);
    }

    // An interrupted delivery may already be bound on the target. If offline,
    // keep the recorded received state until an authenticated retry can reconcile it.
    if (!receiver || !peer) return structuredClone(entry.receipts);
    const matchesManifest = entry.targetManifestHash === peer.manifestHash;
    const decision = matchesManifest
      ? receiver.bind(JSON.stringify(entry.request), sender, entry.requestHash, now)
      : { state: 'rejected', reason: 'stale_directory' } as const;
    const receipts = [...entry.receipts, appendReceipt(entry.receipts, request.requestId, matchesManifest ? peer.address : 'studio://relay', now.toISOString(), decision)];
    this.save({ ...entry, receipts });
    return structuredClone(receipts);
  }

  private complete(peer: SyntheticHive, session: Session, requestId: string): Receipt[] {
    const entry = this.entries.find((item) => item.request.requestId === requestId);
    const accepted = entry?.receipts[1];
    if (!entry || accepted?.state !== 'accepted' || !accepted.targetTaskId || entry.request.to !== peer.address
      || entry.targetManifestHash !== peer.manifestHash || !peer.accepts(entry.request.from)) {
      throw new Error('Only the registered target can complete its accepted task');
    }
    if (entry.receipts.at(-1)?.state === 'completed') return structuredClone(entry.receipts);
    const { evidence, bytes } = session.finish(requestId, accepted.targetTaskId, entry.requestHash);
    if (Buffer.byteLength(bytes) > 64 * 1024 || digest(bytes) !== evidence.sha256) throw new Error('Target evidence failed verification');
    const at = this.clock().toISOString();
    const bound = { targetTaskId: accepted.targetTaskId, targetManifestHash: peer.manifestHash };
    const started = [...entry.receipts, appendReceipt(entry.receipts, requestId, peer.address, at, { state: 'started', ...bound })];
    const receipts = [...started, appendReceipt(started, requestId, peer.address, at, { state: 'completed', ...bound, evidence: [evidence] })];
    if (!verifyReceipts(receipts)) throw new Error('Target receipt failed verification');
    this.save({ ...entry, receipts });
    return structuredClone(receipts);
  }

  private admit(request: RelayRequest, source: Session, peer: SyntheticHive | undefined, receiver: Session | undefined, now: Date): Decision | null {
    if (expired(request, now)) return { state: 'expired', reason: 'expired' };
    if (Date.parse(request.createdAt) > now.getTime() + 60_000) return { state: 'rejected', reason: 'invalid_schema' };
    if (!peer) return { state: 'rejected', reason: 'unknown_target' };
    if (!receiver) return { state: 'rejected', reason: 'offline' };
    if (!peer.accepts(request.from)) return { state: 'rejected', reason: 'policy_denied' };
    for (const reference of request.references) {
      const bytes = source.resolve(reference.uri);
      if (!bytes || bytes.length > 64 * 1024 || digest(bytes) !== reference.sha256) return { state: 'rejected', reason: 'invalid_reference' };
    }
    return null;
  }
}
