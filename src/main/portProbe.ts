import { connect } from 'node:net';

export type PortProbeResult = { ok: true } | { ok: false; code: 'INVALID_PORT' | 'CLOSED' | 'TIMEOUT' };

/** Non-blocking TCP probe: `ok` is true if something accepts a connection on
 *  host:port within `timeoutMs`; otherwise `code` says why (invalid port, refused or
 *  errored, timed out). It sends no bytes and never rejects, so a caller can await
 *  it on the main process safely. */
export function probePort(port: number, host = '127.0.0.1', timeoutMs = 400): Promise<PortProbeResult> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve({ ok: false, code: 'INVALID_PORT' });
  return new Promise((resolve) => {
    let socket: ReturnType<typeof connect>;
    try {
      socket = connect({ port, host });
    } catch {
      resolve({ ok: false, code: 'INVALID_PORT' });
      return;
    }
    let done = false;
    const finish = (result: PortProbeResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT' }), timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('error', () => finish({ ok: false, code: 'CLOSED' }));
  });
}
