import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/** The harness chooses the state paths. No request field becomes part of a filename. */
export function readState<T>(path: string, initial: T): T {
  if (!existsSync(path)) return initial;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function replaceState(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(value));
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
