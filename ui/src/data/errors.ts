// One error shape for every backend failure, so the UI can always show {errorId, code, message}.
// Core failures carry the errorId that is also on a `paramount-error` line in log.jsonl.
// Failures the core never saw (no errorId from it) get a `ui-` id so they are still traceable.
import type { ParamountErrorCode, ParamountFailure } from './paramount-api';

export type ErrorCode = ParamountErrorCode | 'DISCONNECTED';

export class BackendError extends Error {
  readonly errorId: string;
  readonly code: ErrorCode;
  readonly correlationId?: string;
  /** What was being done when it failed, e.g. the command type. */
  readonly operation?: string;

  constructor(init: { errorId: string; code: ErrorCode; message: string; correlationId?: string; operation?: string }) {
    super(init.message);
    this.name = 'BackendError';
    this.errorId = init.errorId;
    this.code = init.code;
    this.correlationId = init.correlationId;
    this.operation = init.operation;
  }

  static local(code: ErrorCode, message: string, operation?: string) {
    return new BackendError({ errorId: localId(), code, message, operation });
  }

  static fromFailure(failure: ParamountFailure, operation?: string) {
    return new BackendError({ errorId: failure.errorId, code: failure.code, message: failure.message || failure.error, correlationId: failure.correlationId, operation });
  }

  /** What the copy button puts on the clipboard. */
  toJSON() {
    return { errorId: this.errorId, code: this.code, message: this.message, correlationId: this.correlationId, operation: this.operation, at: new Date().toISOString() };
  }
}

const CODES: readonly ErrorCode[] = ['INVALID_COMMAND', 'INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'UNSUPPORTED', 'UNCERTAIN_STATE', 'INTERNAL', 'FORBIDDEN', 'DISCONNECTED'];

function localId() {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10);
  return `ui-${Date.now().toString(36)}-${random}`;
}

/** Turns anything thrown or rejected into a BackendError. `paramountSnapshot` rejects with "[<errorId>] <code>: <message>". */
export function toBackendError(cause: unknown, operation?: string): BackendError {
  if (cause instanceof BackendError) return cause;
  // A core failure (or a warning shaped like one) keeps the core's errorId, code and message.
  if (isFailure(cause) && (CODES as readonly string[]).includes(cause.code)) return BackendError.fromFailure(cause, operation);
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'Unknown failure';
  // Electron prefixes IPC rejections with "Error invoking remote method '…': Error: ".
  const match = /\[([^\]\s]+)\]\s+([A-Z_]+):\s*([\s\S]*)$/.exec(raw);
  if (match && (CODES as readonly string[]).includes(match[2])) {
    return new BackendError({ errorId: match[1], code: match[2] as ErrorCode, message: match[3].trim(), operation });
  }
  return BackendError.local('INTERNAL', raw, operation);
}

export function isFailure(value: unknown): value is ParamountFailure {
  return !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false && typeof (value as { errorId?: unknown }).errorId === 'string';
}

/** For preload calls that return `{ ok, error }` without an errorId (hiveSend, writePty, …). */
export function checkOk(result: { ok: boolean; error?: string } | undefined, operation: string, fallback: string) {
  if (!result) throw BackendError.local('DISCONNECTED', 'The desktop core did not answer.', operation);
  if (isFailure(result)) throw BackendError.fromFailure(result, operation);
  if (!result.ok) throw BackendError.local('INTERNAL', result.error || fallback, operation);
}
