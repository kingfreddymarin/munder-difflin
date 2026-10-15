import { connect } from 'node:net';

/** Non-blocking TCP probe: resolves true if something accepts a connection on
 *  host:port within `timeoutMs`, false on refusal, timeout or any error. It sends
 *  no bytes and never rejects, so a caller can await it on the main process safely. */
export function probePort(port: number, host = '127.0.0.1', timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    let done = false;
    const finish = (open: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
