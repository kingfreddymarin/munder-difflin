import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function LiveTerminal({ ptyId, label }: { ptyId: string; label: string }) {
  const host = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const bridge = window.cth;
    const node = host.current;
    if (!bridge || !node) {
      setError('The desktop terminal is unavailable.');
      return;
    }
    setError(null);
    const terminal = new Terminal({
      cursorBlink: true, scrollback: 5000, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13, theme: { background: '#101419', foreground: '#e8edf2', cursor: '#82cafa' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(node);
    const resize = () => {
      if (!node.clientWidth || !node.clientHeight) return;
      fit.fit();
      void bridge.resizePty(ptyId, terminal.cols, terminal.rows).then((result) => {
        if (!result.ok) setError(result.error || 'Terminal resize failed.');
      }).catch(() => setError('The terminal connection was lost.'));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    const frame = requestAnimationFrame(resize);
    const input = terminal.onData((data) => {
      void bridge.writePty(ptyId, data).then((result) => {
        if (!result.ok) setError(result.error || 'Could not send terminal input.');
      }).catch(() => setError('The terminal connection was lost.'));
    });
    const offData = bridge.onPtyData(ptyId, (data) => terminal.write(data));
    const offExit = bridge.onPtyExit(ptyId, () => {
      terminal.writeln('\r\n[Session ended]');
      setError('This terminal session has ended.');
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
    {error && <p role="alert" className="border-b border-red-400/40 px-3 py-2 text-xs text-red-200">{error}</p>}
    <div ref={host} role="region" aria-label={label} className="min-h-0 flex-1 p-2" />
  </div>;
}
