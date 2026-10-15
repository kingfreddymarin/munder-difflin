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
