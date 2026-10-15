/** Paramount access matrix: per agent x source, 'rw' | 'r' | 'none'. Only the
 *  restrictive cells are stored; an unset cell is 'rw' (today's behaviour). */
export type AccessLevel = 'rw' | 'r' | 'none';
export type AccessMatrix = Record<string, 'r' | 'none'>;

export function accessKey(agentId: string, sourceId: string): string {
  return `${agentId}:${sourceId}`;
}

export function accessFor(matrix: AccessMatrix | undefined, agentId: string, sourceId: string): AccessLevel {
  if (!matrix) return 'rw';
  const key = accessKey(agentId, sourceId);
  if (!Object.hasOwn(matrix, key)) return 'rw';
  const level = matrix[key];
  // Anything unreadable in a hand-edited config fails closed, not open.
  return level === 'r' || level === 'none' ? level : 'none';
}

/** A new matrix with one cell changed; 'rw' clears the cell. Never mutates the input. */
export function withAccess(matrix: AccessMatrix | undefined, agentId: string, sourceId: string, access: AccessLevel): AccessMatrix {
  const next: AccessMatrix = { ...(matrix ?? {}) };
  const key = accessKey(agentId, sourceId);
  if (access === 'rw') delete next[key];
  else next[key] = access;
  return next;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method.toUpperCase());
}

/** Headers and the query param some upstreams honour to turn a GET into a write.
 *  At 'r' any of them is denied outright rather than stripped (fail closed). */
const METHOD_OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override'];
export function hasMethodOverride(headers: Record<string, unknown>, query: string): boolean {
  const lower = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  if (METHOD_OVERRIDE_HEADERS.some((h) => lower.has(h))) return true;
  for (const key of new URLSearchParams(query.replace(/^\?/, '')).keys()) {
    if (key.toLowerCase() === '_method') return true;
  }
  return false;
}

/** RPC-style upstreams: one URL path is one action and writes accept GET (Slack's
 *  Web API takes `GET /api/chat.postMessage?text=…`). Matching by id as well as
 *  host only ever makes a source stricter, never looser. */
export function isRpcStyle(integrationId: string, upstream: URL): boolean {
  const host = upstream.hostname.toLowerCase();
  return host === 'slack.com' || host.endsWith('.slack.com') || /slack/i.test(integrationId);
}

/** Read methods an RPC-style source may call at 'r'. Anything else is a write. */
const RPC_READ = /^(?:[A-Za-z]+\.)+(?:list|history|info|get|replies)$/;
const RPC_READ_EXACT = new Set(['auth.test']);
export function isRpcReadPath(upstream: URL): boolean {
  const m = /^\/api\/([^/]+)$/.exec(upstream.pathname);
  return !!m && (RPC_READ.test(m[1]) || RPC_READ_EXACT.has(m[1]));
}
