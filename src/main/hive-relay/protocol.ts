import { createHash } from 'node:crypto';

export const REQUEST_SCHEMA = 'studio-cross-hive-request-v1' as const;
export const RECEIPT_SCHEMA = 'studio-cross-hive-receipt-v1' as const;
export const MAX_ENVELOPE_BYTES = 16_384;
const MAX_LIFETIME_MS = 15 * 60_000;
const ADDRESS = /^studio:\/\/hive\/[a-zA-Z0-9][a-zA-Z0-9:-]{0,62}\/agent\/[a-z0-9][a-z0-9-]{0,31}$/;
const REQUEST_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const WORK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const REFERENCE = /^studio-task:\/\/[a-zA-Z0-9][a-zA-Z0-9:-]{0,62}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}){0,2}$/;
const EVIDENCE = /^studio-evidence:\/\/[a-zA-Z0-9][a-zA-Z0-9:-]{0,62}\/XH-[0-9]+\/plan\.txt$/;
const URL = /[a-z][a-z0-9+.-]*:\/\//i;
const SECRET_OR_PATH = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:Bearer [a-z0-9._~-]+|(?:ghp_|github_pat_|sk-(?:proj-)?)[a-z0-9_-]{12,}|(?:api[_ -]?key|client[_ -]?secret|password|access[_ -]?token)\s*[:=])|(?:^|\s|['"(])(?:~\/|\/(?!\/)|[a-z]:[\\/]|\\\\)|(?:^|[\s/])\.\.\/)/i;

export type Reference = { uri: string; sha256: string };

export interface RelayRequest {
  schema: typeof REQUEST_SCHEMA;
  requestId: string;
  idempotencyKey: string;
  createdAt: string;
  expiresAt: string;
  from: string;
  to: string;
  replyTo: string;
  work: { parentId: string; title: string; revision: number };
  contract: { objective: string; output: string; tools: string[]; boundaries: string[]; doneMeans: string[] };
  references: Reference[];
  requestedCapability: 'workflow.plan';
  sideEffectClass: 'read-only';
  policyVersion: 'v1';
  budget: { tokenCap: number; contextCapPercent: number };
}

const REASONS = ['unknown_target', 'offline', 'policy_denied', 'expired', 'invalid_schema', 'invalid_reference', 'stale_directory'] as const;
export type Rejection = typeof REASONS[number];
export type Decision =
  | { state: 'accepted'; targetTaskId: string; targetManifestHash: string }
  | { state: 'rejected' | 'expired'; reason: Rejection };

export type SyntheticProgress =
  | { state: 'started'; targetTaskId: string; targetManifestHash: string }
  | { state: 'completed'; targetTaskId: string; targetManifestHash: string; evidence: Reference[] };

export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  requestId: string;
  seq: number;
  state: 'received' | Decision['state'] | SyntheticProgress['state'];
  at: string;
  emitter: string;
  prevHash: string;
  hash: string;
  targetTaskId?: string;
  targetManifestHash?: string;
  reason?: Rejection;
  evidence?: Reference[];
}

export function stableAddress(hiveId: string, role: string) {
  const address = `studio://hive/${hiveId}/agent/${role}`;
  if (!ADDRESS.test(address)) throw new Error('Invalid hive identity');
  return address;
}

export function digest(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown, length: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= length && !/[\u0000-\u001f\u007f]/.test(value) && !SECRET_OR_PATH.test(value) && !URL.test(value);
}

function texts(value: unknown, min = 0): value is string[] {
  return Array.isArray(value) && value.length >= min && value.length <= 20 && value.every((item) => text(item, 200));
}

function positive(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  const iso = new Date(time).toISOString();
  return value === iso || value === iso.replace(/\.000Z$/, 'Z') ? time : NaN;
}

/** Parse bounded bytes at both ends. All identities and references are opaque, never disk paths. */
export function parseRequest(raw: string): RelayRequest {
  if (Buffer.byteLength(raw) > MAX_ENVELOPE_BYTES) throw new Error('Request exceeds byte limit');
  const candidate: unknown = JSON.parse(raw);
  if (!fields(candidate, ['schema', 'requestId', 'idempotencyKey', 'createdAt', 'expiresAt', 'from', 'to', 'replyTo',
    'work', 'contract', 'references', 'requestedCapability', 'sideEffectClass', 'policyVersion', 'budget'])) throw new Error('Invalid envelope fields');
  const { schema, requestId, idempotencyKey, createdAt, expiresAt, from, to, replyTo, work, contract, references, budget } = candidate;
  if (schema !== REQUEST_SCHEMA || typeof requestId !== 'string' || !REQUEST_ID.test(requestId)
    || typeof from !== 'string' || !ADDRESS.test(from) || typeof to !== 'string' || !ADDRESS.test(to) || from === to || replyTo !== from) {
    throw new Error('Invalid request identity');
  }
  const duration = timestamp(expiresAt) - timestamp(createdAt);
  if (!(duration > 0 && duration <= MAX_LIFETIME_MS)) throw new Error('Invalid request deadline');
  if (!fields(work, ['parentId', 'title', 'revision']) || typeof work.parentId !== 'string' || !WORK_ID.test(work.parentId)
    || !text(work.title, 160) || !positive(work.revision, 999_999) || idempotencyKey !== `${from}:${work.parentId}:${work.revision}`) {
    throw new Error('Invalid work identity');
  }
  if (!fields(contract, ['objective', 'output', 'tools', 'boundaries', 'doneMeans']) || !text(contract.objective, 2000) || !text(contract.output, 1000)
    || !texts(contract.tools) || !contract.tools.every((tool) => tool === 'read-reference') || !texts(contract.boundaries, 1) || !texts(contract.doneMeans, 1)) throw new Error('Invalid bounded contract');
  if (!Array.isArray(references) || references.length > 8 || !references.every((ref) =>
    fields(ref, ['uri', 'sha256']) && typeof ref.uri === 'string' && REFERENCE.test(ref.uri) && typeof ref.sha256 === 'string' && HASH.test(ref.sha256))) {
    throw new Error('Invalid reference');
  }
  if (!fields(budget, ['tokenCap', 'contextCapPercent']) || !positive(budget.tokenCap, 30_000) || !positive(budget.contextCapPercent, 95) || budget.contextCapPercent < 10) {
    throw new Error('Invalid synthetic budget');
  }
  if (candidate.requestedCapability !== 'workflow.plan' || candidate.sideEffectClass !== 'read-only' || candidate.policyVersion !== 'v1') {
    throw new Error('Only the synthetic read-only planning capability is enabled');
  }
  return candidate as unknown as RelayRequest;
}

export function appendReceipt(receipts: readonly Receipt[], requestId: string, emitter: string, at: string,
  decision: Decision | SyntheticProgress | { state: 'received' }): Receipt {
  const fields = {
    schema: RECEIPT_SCHEMA, requestId, seq: receipts.length + 1, at, emitter,
    prevHash: receipts.at(-1)?.hash ?? 'genesis', ...decision,
  };
  return { ...fields, hash: digest(canonical(fields)) };
}

export function verifyReceipts(receipts: readonly Receipt[]): boolean {
  if (receipts.length < 1 || receipts.length > 4 || receipts.length === 3) return false;
  return receipts.every(({ hash, ...receipt }, index) => {
    const previous = receipts[index - 1];
    const accepted = receipts[1];
    if (receipt.schema !== RECEIPT_SCHEMA || receipt.requestId !== receipts[0].requestId || receipt.seq !== index + 1
      || !REQUEST_ID.test(receipt.requestId) || !Number.isFinite(timestamp(receipt.at))
      || receipt.prevHash !== (previous?.hash ?? 'genesis') || hash !== digest(canonical(receipt))) return false;
    if (index === 0) {
      const initial = receipt.state === 'received' || receipt.state === 'rejected' || receipt.state === 'expired';
      if (!initial || receipt.emitter !== 'studio://relay') return false;
    } else if (index === 1) {
      if (previous.state !== 'received' || !['accepted', 'rejected', 'expired'].includes(receipt.state)) return false;
      if (receipt.reason === 'stale_directory' ? receipt.emitter !== 'studio://relay' : !ADDRESS.test(receipt.emitter)) return false;
    } else {
      const progression = index === 2 ? 'started' : 'completed';
      if (accepted.state !== 'accepted' || receipt.state !== progression || receipt.emitter !== accepted.emitter
        || receipt.targetTaskId !== accepted.targetTaskId || receipt.targetManifestHash !== accepted.targetManifestHash) return false;
    }
    if (receipt.state === 'accepted' || receipt.state === 'started' || receipt.state === 'completed') {
      if (typeof receipt.targetTaskId !== 'string' || !WORK_ID.test(receipt.targetTaskId)
        || typeof receipt.targetManifestHash !== 'string' || !HASH.test(receipt.targetManifestHash) || receipt.reason !== undefined) return false;
    } else if (receipt.targetTaskId !== undefined || receipt.targetManifestHash !== undefined
      || (receipt.state === 'received' ? receipt.reason !== undefined : receipt.reason === undefined || !REASONS.includes(receipt.reason))) return false;
    return receipt.state === 'completed'
      ? receipt.evidence?.length === 1 && receipt.evidence.every(({ uri, sha256 }) => EVIDENCE.test(uri) && HASH.test(sha256))
      : receipt.evidence === undefined;
  });
}
