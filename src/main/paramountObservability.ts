/**
 * Paramount observability: correlation ids, error ids, crash reports and the
 * diagnostics bundle. Reuses the hive's `log.jsonl` (structured, redacted
 * lines) and `crashes/` (one 0600 report per crash) rather than a new store.
 *
 * Every Paramount IPC call gets a correlation id (`cid`). Its start and end
 * land in log.jsonl as `paramount-op` lines with duration and outcome. Every
 * failure handed to the renderer carries an `errorId`; the same id is on a
 * `paramount-error` line holding the code, message, stack and context, so a
 * user-reported id leads straight to the cause.
 *
 * No Electron import: index.ts wires the sinks, tests drive this directly.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParamountDiagnostics, ParamountErrorCode, ParamountFailure } from '../preload/paramount';

export type LogSink = (event: Record<string, unknown>) => void;

export function newErrorId(): string {
  return `E-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}
export function newCorrelationId(): string {
  return randomUUID();
}

// ─── redaction ──────────────────────────────────────────────────────────────
/** Keys whose string or object value is a secret. Numbers and booleans under
 *  a matching key survive (`tokensCap: 5` is a budget, not a credential). */
const SECRET_KEY = /token|secret|passw|apikey|api[_-]key|authorization|cookie|credential|private[_-]?key|signing|bearer/i;
/** Secret shapes inside free text: provider keys, Slack and GitHub tokens,
 *  AWS ids, JWTs, bearer headers. Each match becomes `[REDACTED]`. */
const SECRET_TEXT: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
];
/** `key=value` and `"key": "value"` where the key ENDS in a secret word, with any
 *  prefix: `MD_BROKER_TOKEN=`, `ANTHROPIC_API_KEY=`, `?api_key=`, `"apiKey":"…"`,
 *  `Authorization: Bearer …`. Group 1 (key and separator) is kept so the line still reads. */
const SECRET_ASSIGNMENT = /(\b[A-Za-z0-9_-]*?(?:token|secret|passw(?:or)?d|api[_-]?key|credential|signature|sig|authorization|private[_-]?key)["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|(?:(?:Bearer|Basic)\s+)?[^\s"'&;,}]+)/gi;
/** Numbers, booleans and null under a secret-looking key are budgets and flags,
 *  not credentials (`"maxTokens": 4096`), matching the object rule below. */
const PLAIN_VALUE = /^["']?(?:\d+(?:\.\d+)?|true|false|null)["']?$/i;
/** Password in URL userinfo: `https://user:pass@host` keeps the user. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
export const REDACTED = '[REDACTED]';

export function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_TEXT) out = out.replace(pattern, REDACTED);
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  return out.replace(SECRET_ASSIGNMENT, (match, key: string, value: string) => {
    if (PLAIN_VALUE.test(value)) return match;
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
    return `${key}${quote}${REDACTED}${quote}`;
  });
}

/** Deep copy with secrets removed. Cycles and excessive depth are cut, never thrown. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 12) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) return { name: value.name, message: redactText(value.message), stack: value.stack ? redactText(value.stack) : undefined };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) && v !== null && v !== undefined && typeof v !== 'number' && typeof v !== 'boolean'
      ? REDACTED
      : redact(v, depth + 1, seen);
  }
  return out;
}

// ─── spans ──────────────────────────────────────────────────────────────────
export interface Span {
  readonly cid: string;
  readonly op: string;
  /** Build a failure for the renderer and log its full cause under one errorId. */
  fail(code: ParamountErrorCode, message: string, cause?: unknown, context?: Record<string, unknown>): ParamountFailure;
}

function describe(cause: unknown): { stack?: string; causeMessage?: string } {
  if (cause instanceof Error) return { stack: cause.stack, causeMessage: cause.message };
  if (cause === undefined) return {};
  return { causeMessage: String(cause) };
}

/** A span that logs to `sink`. With no sink (tests, headless) ids are still issued. */
export function createSpan(op: string, sink: LogSink | null = null, context: Record<string, unknown> = {}, cid = newCorrelationId()): Span {
  return {
    cid,
    op,
    fail(code, message, cause, extra) {
      const errorId = newErrorId();
      const safeMessage = redactText(message);
      // Callers never see a stack; it stays in the local log.
      safeLog(sink, {
        kind: 'paramount-error', cid, op, errorId, code, message: safeMessage,
        ...(redact(describe(cause)) as Record<string, unknown>),
        context: redact({ ...context, ...extra })
      });
      return { ok: false, error: safeMessage, message: safeMessage, code, errorId, correlationId: cid };
    }
  };
}

/** The log is a diagnostic; writing it must never turn a success into a failure. */
function safeLog(sink: LogSink | null, event: Record<string, unknown>): void {
  if (!sink) return;
  try { sink(event); } catch { /* best-effort */ }
}

/**
 * Run one Paramount operation inside a span: a `paramount-op` start line, then
 * an end line with duration and outcome. A throw becomes an INTERNAL failure
 * with an errorId, unless `rethrow` is set (for calls whose renderer contract
 * is a resolved value, such as the snapshot); then the thrown Error's message
 * carries the errorId so the renderer's rejection is still traceable.
 */
export async function traced<T>(
  op: string,
  sink: LogSink | null,
  context: Record<string, unknown>,
  fn: (span: Span) => T | Promise<T>,
  opts: { rethrow?: boolean; now?: () => number } = {}
): Promise<T | ParamountFailure> {
  const now = opts.now ?? Date.now;
  const span = createSpan(op, sink, context);
  const started = now();
  safeLog(sink, { kind: 'paramount-op', phase: 'start', cid: span.cid, op, context: redact(context) });
  // 'error': the command answered, but part of it failed in the core (warnings with errorIds).
  const end = (outcome: 'ok' | 'fail' | 'error', extra: Record<string, unknown> = {}): void =>
    safeLog(sink, { kind: 'paramount-op', phase: 'end', cid: span.cid, op, outcome, durationMs: now() - started, ...extra });
  try {
    const result = await fn(span);
    const failed = isFailure(result);
    const partial = failed ? [] : warningIds(result);
    end(failed ? 'fail' : partial.length ? 'error' : 'ok', failed ? { errorId: result.errorId, code: result.code } : partial.length ? { errorIds: partial } : {});
    return result;
  } catch (error) {
    const failure = span.fail('INTERNAL', error instanceof Error ? error.message : 'Operation failed', error);
    end('fail', { errorId: failure.errorId, code: failure.code });
    if (opts.rethrow) throw new Error(`[${failure.errorId}] ${failure.code}: ${failure.message}`);
    return failure;
  }
}

/** errorIds of `warnings` carried by a successful result's payload (one level down). */
function warningIds(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const ids: string[] = [];
  for (const value of Object.values(result as Record<string, unknown>)) {
    const warnings = value && typeof value === 'object' ? (value as { warnings?: unknown }).warnings : undefined;
    if (Array.isArray(warnings)) for (const w of warnings) if (w && typeof (w as { errorId?: unknown }).errorId === 'string') ids.push((w as { errorId: string }).errorId);
  }
  return ids;
}

function isFailure(value: unknown): value is ParamountFailure {
  return !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false &&
    typeof (value as { errorId?: unknown }).errorId === 'string';
}

// ─── crash reports ──────────────────────────────────────────────────────────
export type CrashSource = 'uncaughtException' | 'unhandledRejection' | 'render-process-gone' | 'child-process-gone';
export const MAX_CRASH_REPORTS = 50;

export interface CrashRecorderOptions {
  /** Hive root; null while the hive is disabled or not yet resolved. */
  root(): string | null;
  sink: LogSink | null;
  runtime(): Record<string, unknown>;
}

/**
 * Write one crash report to `<root>/crashes/` (0600) and a `crash` line to
 * log.jsonl with the same errorId. Returns the errorId. Never throws: it runs
 * inside process-level handlers where a throw would recurse.
 */
export function recordCrash(opts: CrashRecorderOptions, source: CrashSource, error: unknown, context: Record<string, unknown> = {}): string {
  const errorId = newErrorId();
  const at = new Date().toISOString();
  const { stack, causeMessage } = describe(error);
  const message = redactText(causeMessage ?? source);
  let reportPath: string | null = null;
  try {
    const root = opts.root();
    if (root) {
      const dir = join(root, 'crashes');
      mkdirSync(dir, { recursive: true });
      // Same naming as agent-exit tails (ISO stamp first, `.log`), so the
      // existing chronological sort and cap apply to both kinds.
      const p = join(dir, `${at.replace(/[:.]/g, '-')}-main-${source}-${errorId}.log`);
      const report = redact({ errorId, source, at, message, stack, context, runtime: safeRuntime(opts) });
      writeFileSync(p, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      reportPath = p;
      pruneReports(dir);
    }
  } catch { /* a crash report must never cause a second crash */ }
  safeLog(opts.sink, { kind: 'crash', source, errorId, message, stack: stack ? redactText(stack) : undefined, context: redact(context), reportPath });
  return errorId;
}

function safeRuntime(opts: CrashRecorderOptions): Record<string, unknown> {
  try { return opts.runtime(); } catch { return {}; }
}

function pruneReports(dir: string): void {
  try {
    const logs = readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
    for (const stale of logs.slice(0, Math.max(0, logs.length - MAX_CRASH_REPORTS))) {
      try { unlinkSync(join(dir, stale)); } catch { /* already gone */ }
    }
  } catch { /* best-effort */ }
}

interface ProcessLike { on(event: string, listener: (...args: unknown[]) => void): unknown }
interface AppLike { on(event: string, listener: (...args: any[]) => void): unknown }

/** Route process and Electron app failure events to crash reports. The
 *  process keeps running after uncaught errors, as the fork always has. */
export function installCrashCapture(opts: CrashRecorderOptions, proc: ProcessLike, app?: AppLike): void {
  proc.on('uncaughtException', (err) => {
    const errorId = recordCrash(opts, 'uncaughtException', err);
    console.error(`[main] uncaughtException ${errorId} (kept alive):`, err);
  });
  proc.on('unhandledRejection', (reason) => {
    const errorId = recordCrash(opts, 'unhandledRejection', reason);
    console.error(`[main] unhandledRejection ${errorId} (kept alive):`, reason);
  });
  if (!app) return;
  app.on('render-process-gone', (_event: unknown, contents: { id?: number; getURL?: () => string } | undefined, details: Record<string, unknown>) => {
    let url: string | undefined;
    try { url = contents?.getURL?.(); } catch { /* destroyed */ }
    recordCrash(opts, 'render-process-gone', new Error(`renderer gone: ${String(details?.reason)}`), { ...details, webContentsId: contents?.id, url });
  });
  app.on('child-process-gone', (_event: unknown, details: Record<string, unknown>) => {
    recordCrash(opts, 'child-process-gone', new Error(`${String(details?.type)} process gone: ${String(details?.reason)}`), { ...details });
  });
}

// ─── diagnostics bundle ─────────────────────────────────────────────────────
export interface DiagnosticsInput {
  root: string | null;
  app: Record<string, unknown>;
  os: Record<string, unknown>;
  config: unknown;
  logLines?: number;
  crashReports?: number;
}

const MAX_LOG_LINES = 2000;
const MAX_REPORT_BYTES = 16_384;

/** Everything a bug report needs, secrets removed. Reads only; never throws on
 *  a missing or unreadable file (the gap is listed in `errors` instead). */
export function buildDiagnostics(input: DiagnosticsInput, cid: string): ParamountDiagnostics {
  const errors: string[] = [];
  const lines = Math.min(Math.max(1, Math.floor(input.logLines ?? 500)), MAX_LOG_LINES);
  let logTail: unknown[] = [];
  const crashes: ParamountDiagnostics['crashes'] = [];
  if (input.root) {
    const logPath = join(input.root, 'log.jsonl');
    try {
      if (existsSync(logPath)) {
        logTail = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).slice(-lines)
          .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
      }
    } catch (e) { errors.push(`log.jsonl: ${(e as Error).message}`); }
    const dir = join(input.root, 'crashes');
    try {
      if (existsSync(dir)) {
        const files = readdirSync(dir).filter((f) => f.endsWith('.log')).sort().slice(-(input.crashReports ?? 20));
        for (const file of files.reverse()) {
          const p = join(dir, file);
          const st = statSync(p);
          // Agent-exit tails are raw PTY output written unredacted by hive.ts.
          // Redact the whole file before the cut, so a secret split by the
          // slice cannot slip past a pattern that needs its key.
          const clean = redactText(readFileSync(p, 'utf8'));
          crashes.push({ file, bytes: st.size, modifiedAt: st.mtime.toISOString(), content: clean.length > MAX_REPORT_BYTES ? clean.slice(-MAX_REPORT_BYTES) : clean });
        }
      }
    } catch (e) { errors.push(`crashes/: ${(e as Error).message}`); }
  } else errors.push('hive disabled: no log or crash reports');
  return redact({
    generatedAt: new Date().toISOString(),
    correlationId: cid,
    app: input.app,
    os: input.os,
    config: input.config,
    logTail,
    crashes,
    errors
  }) as ParamountDiagnostics;
}
