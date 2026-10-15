// An agent's live session, drawn the way Munder draws it: the pooled xterm from terminal-pool,
// Munder's palettes and metrics, the same fit and redraw sequence, zoom and file drag-drop.
// Ported from the fork's PtyTerminalView; the pool keeps the buffer between agent switches.
import * as React from 'react';
import { Minus, Plus } from 'lucide-react';
import { ErrorNotice } from '@/components/app/error-notice';
import { findBridge } from '@/data/bridge';
import { BackendError, checkOk, toBackendError } from '@/data/errors';
import { acquireTerminal, attachTerminal, detachTerminal, fitTerminal, notifyThemeChangeAll, reflowTerminal, setTerminalCwdResolver } from './terminal-pool';
import { TERMINAL_THEMES, type PtyTheme } from './terminal-themes';
import { DEFAULT_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE, getTerminalFontSize, setTerminalFontSize, useTerminalFontSize } from './terminalFontSize';

/** Follows the app's `.dark` class on <html>, which the theme toggler flips. */
function usePtyTheme(): PtyTheme {
  const read = (): PtyTheme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  const [theme, setTheme] = React.useState<PtyTheme>(read);
  React.useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** A dropped filename is attacker-controllable: strip control characters (a newline would submit
 *  the line) and backslash-escape every shell metacharacter, so the path is one inert token. */
function escapeDroppedPath(path: string): string {
  const BS = String.fromCharCode(92);
  const CTRL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g');
  const SPECIAL = new Set((BS + ' $' + String.fromCharCode(96) + String.fromCharCode(34) + String.fromCharCode(39) + ';|&<>(){}[]*?!~#').split('').map((c) => c.charCodeAt(0)));
  return path.replace(CTRL, '').split('').map((ch) => (SPECIAL.has(ch.charCodeAt(0)) ? BS + ch : ch)).join('');
}

export function PtyTerminalView({ ptyId, cwd, label }: { ptyId: string; cwd?: string; label: string }) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const theme = usePtyTheme();
  const fontSize = useTerminalFontSize();
  const themeRef = React.useRef(theme);
  themeRef.current = theme;
  const fontRef = React.useRef(fontSize);
  fontRef.current = fontSize;
  const [error, setError] = React.useState<BackendError | null>(null);
  const bridge = findBridge();

  // Relative paths an agent prints resolve against that agent's own working directory.
  const cwdRef = React.useRef(cwd);
  cwdRef.current = cwd;
  React.useEffect(() => {
    setTerminalCwdResolver((id) => (id === ptyId ? cwdRef.current : undefined));
  }, [ptyId]);

  React.useEffect(() => {
    const container = hostRef.current;
    if (!container || !bridge) return;
    setError(null);
    const entry = acquireTerminal(ptyId, TERMINAL_THEMES[themeRef.current], fontRef.current);
    entry.onError = setError;
    attachTerminal(entry, container);

    // Fit as soon as the host has real dimensions; the first good fit also snaps to the bottom.
    let initialFitDone = false;
    const tryFit = (scrollToEnd: boolean) => {
      if (fitTerminal(entry, scrollToEnd)) initialFitDone = true;
    };
    requestAnimationFrame(() => requestAnimationFrame(() => tryFit(true)));
    const retries = [setTimeout(() => tryFit(true), 60), setTimeout(() => tryFit(true), 240)];
    // JetBrains Mono may still be loading: re-measure once fonts settle or the cells are mis-sized.
    void document.fonts?.ready.then(() => reflowTerminal(entry)).catch(() => undefined);
    const ro = new ResizeObserver(() => tryFit(!initialFitDone));
    ro.observe(container);
    const onWinResize = () => tryFit(false);
    window.addEventListener('resize', onWinResize);
    // After sleep or a hidden window, the canvas can hold stale metrics until something forces a fit.
    const onWake = () => { if (document.visibilityState === 'visible') requestAnimationFrame(() => reflowTerminal(entry)); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    try { entry.term.focus(); } catch { /* noop */ }

    return () => {
      retries.forEach(clearTimeout);
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      if (entry.onError === setError) entry.onError = undefined;
      // Detach, never dispose: the session keeps streaming into the pool.
      detachTerminal(entry, container);
    };
  }, [ptyId, bridge]);

  React.useEffect(() => {
    if (!bridge) return;
    acquireTerminal(ptyId, TERMINAL_THEMES[theme], fontRef.current).term.options.theme = TERMINAL_THEMES[theme];
    notifyThemeChangeAll(theme);
  }, [theme, ptyId, bridge]);

  React.useEffect(() => {
    if (!bridge) return;
    const entry = acquireTerminal(ptyId, TERMINAL_THEMES[themeRef.current], fontSize);
    entry.term.options.fontSize = fontSize;
    fitTerminal(entry);
  }, [fontSize, ptyId, bridge]);

  // Keyboard zoom: Cmd/Ctrl + '=' / '-' / '0', as in Munder.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); setTerminalFontSize(getTerminalFontSize() + 1); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); setTerminalFontSize(getTerminalFontSize() - 1); }
      else if (e.key === '0') { e.preventDefault(); setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Drop files onto the session to type their paths, like a native terminal; Claude attaches images.
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  };
  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    const b = findBridge();
    if (!b?.pathForFile) { setError(BackendError.local('UNSUPPORTED', 'This desktop build cannot read the path of a dropped file.', 'pty.drop')); return; }
    const paths = files.map((f) => b.pathForFile!(f)).filter(Boolean).map(escapeDroppedPath);
    if (paths.length === 0) return;
    b.writePty(ptyId, paths.join(' ') + ' ').then((r) => checkOk(r, 'pty.drop', 'Could not type the dropped path.')).catch((cause) => setError(toBackendError(cause, 'pty.drop')));
  };

  if (!bridge) return <ErrorNotice error={BackendError.local('DISCONNECTED', 'The desktop terminal is unavailable. Open Paramount in the desktop app.', 'pty.attach')} className="m-3" />;

  const palette = TERMINAL_THEMES[theme];
  return (
    <div className="flex h-full min-h-0 w-full flex-col" style={{ background: palette.background, color: palette.foreground }}>
      <div className="flex items-center gap-1.5 border-b border-dashed px-2 py-1 font-mono text-xs opacity-80" style={{ borderColor: palette.brightBlack }}>
        <span aria-hidden className="size-2 animate-pulse" style={{ background: palette.green }} />
        <span className="truncate">live · pty {ptyId}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" onClick={() => setTerminalFontSize(fontSize - 1)} disabled={fontSize <= MIN_TERMINAL_FONT_SIZE} title="Zoom out (Cmd -)" aria-label="Zoom out" className="grid size-6 place-items-center rounded hover:bg-black/10 disabled:opacity-40 dark:hover:bg-white/10"><Minus className="size-3.5" /></button>
          <button type="button" onClick={() => setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE)} title="Reset zoom (Cmd 0)" className="h-6 min-w-8 rounded px-1 hover:bg-black/10 dark:hover:bg-white/10">{fontSize}px</button>
          <button type="button" onClick={() => setTerminalFontSize(fontSize + 1)} disabled={fontSize >= MAX_TERMINAL_FONT_SIZE} title="Zoom in (Cmd +)" aria-label="Zoom in" className="grid size-6 place-items-center rounded hover:bg-black/10 disabled:opacity-40 dark:hover:bg-white/10"><Plus className="size-3.5" /></button>
        </div>
      </div>
      {error && <ErrorNotice error={error} className="m-2"><button type="button" className="self-start text-xs underline" onClick={() => setError(null)}>Dismiss</button></ErrorNotice>}
      <div ref={hostRef} role="region" aria-label={label} onDragOver={onDragOver} onDrop={onDrop} className="min-h-0 flex-1 px-2 pb-2" />
    </div>
  );
}
