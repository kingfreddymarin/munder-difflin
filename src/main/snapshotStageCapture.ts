import { appendFile, chmod, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_QUEUE_RECORDS = 32;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 3;
const MAX_RECORD_BYTES = 2048;
const MAX_DURATION_MS = 60 * 60 * 1000;
const STAGES = new Set([
  'config', 'floorSetup', 'hookHealth', 'orchestratorFailure', 'registry', 'tasks',
  'messages', 'organization', 'archivedAgents', 'log', 'roster', 'activity',
  'snapshotConfig', 'missions', 'ptys', 'preferences', 'integrations', 'skidProbe',
  'enginePaths', 'signIn'
]);
const OPERATIONS = new Set([
  'unknown', 'paramount.snapshot', 'paramount.dispatch', 'runtime.beat',
  'fleet.snapshot', 'floor-entry', 'worker-wake.beat'
]);

export interface SnapshotCaptureFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  appendFile(path: string, data: string, options: { encoding: 'utf8'; mode: number }): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface SnapshotStageCaptureOptions {
  directory: string;
  appRunId: string;
  version: string;
  now?: () => number;
  fs?: SnapshotCaptureFs;
}

type StageRecord = {
  kind: 'paramount-snapshot-stage';
  cid: string;
  stage: string;
  syncMs: number;
  waitMs: number;
  totalMs: number;
  outcome: 'ok' | 'error';
};
type LagRecord = {
  kind: 'paramount-lag';
  ms: number;
  operations: string[];
};
type CaptureRecord = (StageRecord | LagRecord) & {
  ts: number;
  appRunId: string;
  version: string;
  droppedBefore?: number;
};

const defaultFs: SnapshotCaptureFs = { mkdir, chmod, appendFile, stat, rename, unlink };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isErrno = (error: unknown, code: string): boolean =>
  !!error && typeof error === 'object' && 'code' in error && error.code === code;

/**
 * Best-effort, payload-free snapshot/lag capture. `record()` validates and
 * queues synchronously; all directory/file operations run through async fs.
 */
export class SnapshotStageCapture {
  private readonly now: () => number;
  private readonly fs: SnapshotCaptureFs;
  private readonly files: string[];
  private readonly queue: string[] = [];
  private draining: Promise<void> | null = null;
  private drops = 0;
  private failures = 0;
  private invalid = 0;

  constructor(private readonly options: SnapshotStageCaptureOptions) {
    if (!/^[a-f0-9]{16,64}$/i.test(options.appRunId)) throw new Error('invalid app run id');
    if (!/^[A-Za-z0-9.+_-]{1,32}$/.test(options.version)) throw new Error('invalid app version');
    this.now = options.now ?? Date.now;
    this.fs = options.fs ?? defaultFs;
    this.files = Array.from({ length: MAX_FILES }, (_, index) =>
      join(options.directory, `snapshot-timing.${index}.jsonl`));
  }

  /** Returns false for rejected or dropped records; never throws into IPC. */
  record(input: unknown): boolean {
    try {
      const payload = this.validate(input);
      if (!payload) { this.invalid++; return false; }
      if (this.queue.length + (this.draining ? 1 : 0) >= MAX_QUEUE_RECORDS) {
        this.drops++;
        return false;
      }
      const ts = this.now();
      if (!Number.isFinite(ts) || ts < 0) { this.invalid++; return false; }
      const record = {
        ts: Math.floor(ts), appRunId: this.options.appRunId, version: this.options.version,
        ...payload, ...(this.drops > 0 ? { droppedBefore: this.drops } : {})
      } as CaptureRecord;
      const line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) { this.invalid++; return false; }
      this.drops = 0;
      this.queue.push(line);
      this.pump();
      return true;
    } catch {
      this.invalid++;
      return false;
    }
  }

  stats(): { queued: number; dropped: number; writeFailures: number; invalid: number } {
    return {
      queued: this.queue.length + (this.draining ? 1 : 0),
      dropped: this.drops,
      writeFailures: this.failures,
      invalid: this.invalid
    };
  }

  /** Test/controlled-shutdown seam. Ordinary IPC never waits for this promise. */
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private validate(input: unknown): StageRecord | LagRecord | null {
    if (!isRecord(input)) return null;
    if (input.kind === 'paramount-snapshot-stage') {
      if (!this.exactKeys(input, ['kind', 'cid', 'stage', 'syncMs', 'waitMs', 'totalMs', 'outcome'])) return null;
      if (typeof input.cid !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(input.cid)) return null;
      if (typeof input.stage !== 'string' || !STAGES.has(input.stage)) return null;
      if (!this.duration(input.syncMs) || !this.duration(input.waitMs) || !this.duration(input.totalMs)) return null;
      if (input.outcome !== 'ok' && input.outcome !== 'error') return null;
      return {
        kind: 'paramount-snapshot-stage', cid: input.cid, stage: input.stage,
        syncMs: input.syncMs, waitMs: input.waitMs, totalMs: input.totalMs,
        outcome: input.outcome
      };
    }
    if (input.kind === 'paramount-lag') {
      if (!this.exactKeys(input, ['kind', 'ms', 'op'])) return null;
      if (!this.duration(input.ms) || typeof input.op !== 'string' || input.op.length > 16384) return null;
      const operations = [...new Set(input.op.split(',').map((value) => {
        const label = value.trim().split(':', 1)[0];
        return OPERATIONS.has(label) ? label : null;
      }).filter((value): value is string => value !== null))].slice(0, 8);
      if (!operations.length) operations.push('unknown');
      return { kind: 'paramount-lag', ms: input.ms, operations };
    }
    return null;
  }

  private exactKeys(input: Record<string, unknown>, expected: string[]): boolean {
    const actual = Object.keys(input).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
  }

  private duration(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_MS;
  }

  private pump(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.queue.length) this.pump();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const line = this.queue.shift()!;
      try { await this.writeLine(line); }
      catch {
        this.failures++;
        let droppedWithLine = 0;
        try { droppedWithLine = (JSON.parse(line) as { droppedBefore?: number }).droppedBefore ?? 0; }
        catch { /* line was produced internally; preserve the fallback count */ }
        this.drops += droppedWithLine + 1;
      }
    }
  }

  private async writeLine(line: string): Promise<void> {
    const [current, older, oldest] = this.files;
    await this.fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    await this.fs.chmod(this.options.directory, 0o700);
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new Error('record exceeds file cap');
    const currentSize = await this.fileSize(current);
    if (currentSize + bytes > MAX_FILE_BYTES) {
      await this.unlinkIfPresent(oldest);
      await this.renameIfPresent(older, oldest);
      await this.renameIfPresent(current, older);
      await this.chmodIfPresent(older, 0o600);
      await this.chmodIfPresent(oldest, 0o600);
    }
    await this.chmodIfPresent(current, 0o600);
    await this.fs.appendFile(current, line, { encoding: 'utf8', mode: 0o600 });
    await this.fs.chmod(current, 0o600);
    const finalSize = await this.fileSize(current);
    if (finalSize > MAX_FILE_BYTES) throw new Error('capture file exceeds cap');
  }

  private async fileSize(path: string): Promise<number> {
    try { return (await this.fs.stat(path)).size; }
    catch (error) { if (isErrno(error, 'ENOENT')) return 0; throw error; }
  }

  private async chmodIfPresent(path: string, mode: number): Promise<void> {
    try { await this.fs.chmod(path, mode); }
    catch (error) { if (!isErrno(error, 'ENOENT')) throw error; }
  }

  private async unlinkIfPresent(path: string): Promise<void> {
    try { await this.fs.unlink(path); }
    catch (error) { if (!isErrno(error, 'ENOENT')) throw error; }
  }

  private async renameIfPresent(from: string, to: string): Promise<void> {
    try { await this.fs.rename(from, to); }
    catch (error) { if (!isErrno(error, 'ENOENT')) throw error; }
  }
}

export function createSnapshotStageCapture(options: SnapshotStageCaptureOptions): SnapshotStageCapture {
  return new SnapshotStageCapture(options);
}
