import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ErrorNotice } from '@/components/app/error-notice';
import { findBridge } from '@/data/bridge';
import { BackendError, checkOk, toBackendError } from '@/data/errors';

type State = 'connecting' | 'live' | 'ended';

export function LiveTerminal({ ptyId, label }: { ptyId: string; label: string }) {
  const host = React.useRef<HTMLDivElement>(null);
  const [state, setState] = React.useState<State>('connecting');
  const [error, setError] = React.useState<BackendError | null>(null);
  // Shown once, beside the terminal: the preload cannot resize, so the PTY keeps its start size.
  const [notice, setNotice] = React.useState<BackendError | null>(null);

  React.useEffect(() => {
    const bridge = findBridge();
    const node = host.current;
    setNotice(null);
    if (!bridge || !node) {
      setError(BackendError.local('DISCONNECTED', 'The desktop terminal is unavailable. Open Paramount in the desktop app.', 'pty.attach'));
      return;
    }
    setError(null);
    setState('connecting');
    const fail = (operation: string) => (cause: unknown) => setError(toBackendError(cause, operation));
    const terminal = new Terminal({
      cursorBlink: true, scrollback: 5000, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13, theme: { background: '#101419', foreground: '#e8edf2', cursor: '#82cafa' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(node);
    const resizePty = bridge.resizePty?.bind(bridge);
    if (!resizePty) setNotice(BackendError.local('UNSUPPORTED', 'This desktop build cannot resize terminals; the session keeps its starting size.', 'pty.resize'));
    const resize = () => {
      if (!node.clientWidth || !node.clientHeight) return;
      fit.fit();
      if (!resizePty) return;
      resizePty(ptyId, terminal.cols, terminal.rows)
        .then((result) => checkOk(result, 'pty.resize', 'Terminal resize failed.'))
        .catch(fail('pty.resize'));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    const frame = requestAnimationFrame(resize);
    const input = terminal.onData((data) => {
      bridge.writePty(ptyId, data)
        .then((result) => checkOk(result, 'pty.write', 'Could not send terminal input.'))
        .catch(fail('pty.write'));
    });
    const offData = bridge.onPtyData(ptyId, (data) => {
      setState('live');
      terminal.write(data);
    });
    const offExit = bridge.onPtyExit(ptyId, (info) => {
      terminal.writeln(`\r\n[Session ended · exit ${info.exitCode}]`);
      setState('ended');
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      input.dispose();
      offData();
      offExit();
      terminal.dispose();
    };
  }, [ptyId]);

  return <div className="flex h-full min-h-0 flex-col bg-[#101419]">
    {error && <ErrorNotice error={error} className="m-2 text-red-100" />}
    {notice && <ErrorNotice error={notice} className="m-2 text-amber-100" />}
    {!error && state !== 'live' && <p role="status" className="px-3 py-2 text-xs text-slate-400">
      {state === 'connecting' ? 'Attached. Waiting for terminal output…' : 'This terminal session has ended.'}
    </p>}
    <div ref={host} role="region" aria-label={label} className="min-h-0 flex-1 p-2" />
  </div>;
}
