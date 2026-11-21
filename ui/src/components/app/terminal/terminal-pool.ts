/**
 * A process-wide pool of live xterm terminals, one per ptyId. Ported from Munder's
 * renderer (components/terminalPool.ts); comments there explain each workaround in depth.
 *
 * Why a pool: node-pty keeps no scrollback. Creating and disposing an xterm on every
 * agent switch gave an empty pane that stayed blank until the TUI happened to repaint.
 * Each pty gets ONE Terminal for the app's lifetime, subscribed to the stream once; a
 * view re-parents its host element in and out.
 *
 * Same renderer as Munder: xterm 5.5 with fit, Unicode 11 widths and a WebGL renderer
 * leased on attach (DOM renderer as the fallback). Left out on purpose: queue automation,
 * Arabic rendering and analytics (Munder-only). See TERMINAL-why.md.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import './terminal-font.css';
import { findBridge } from '@/data/bridge';
import { BackendError, checkOk, toBackendError } from '@/data/errors';
import { classifyPathToken, isPathToken, stripPathToken, terminalLinkSpans } from './terminalPaths';
import { createTerminalRecoveryState, normalizePtyChunk, requestInitialPtyRedraw, scheduleWebglRecovery, type TerminalRecoveryState } from './terminalRecovery';
import { sanitizeTerminalSelection } from './terminalSelection';
import { terminalKeySequence } from './terminalKeys';
import { isDarkBackground, oscColorBody, parseHexColor } from './termColor';

type ThemeMap = Record<string, string>;

export interface TerminalEntry {
  ptyId: string;
  term: Terminal;
  fit: FitAddon;
  /** The element xterm renders into; views re-parent this in and out of the DOM. */
  host: HTMLDivElement;
  /** xterm is only `open()`ed once its host is first attached to the document. */
  opened: boolean;
  /** The WebGL renderer, leased while the terminal is on screen (see leaseWebglRenderer). */
  webgl?: WebglAddon;
  /** The DOM renderer took over (lease released or context lost) and has not repainted yet. */
  needsRendererRepaint: boolean;
  exited: boolean;
  unsub: Array<() => void>;
  recovery: TerminalRecoveryState;
  /** DEC mode 2031: the program asked to be told when the theme flips. */
  themeNotify: boolean;
  /** Set by the mounted view; every failed bridge call lands here with an errorId. */
  onError?: (error: BackendError) => void;
}

const pool = new Map<string, TerminalEntry>();

/** Resolves a relative path printed by an agent against that agent's working directory. */
let cwdOf: (ptyId: string) => string | undefined = () => undefined;
export function setTerminalCwdResolver(resolve: (ptyId: string) => string | undefined): void {
  cwdOf = resolve;
}

function report(entry: TerminalEntry, operation: string, cause: unknown): void {
  const error = toBackendError(cause, operation);
  if (entry.onError) entry.onError(error);
  else console.warn(`[terminal] ${entry.ptyId} ${operation} failed`, error.toJSON());
}

/** Fire a preload call that answers `{ ok, error }` and report a failure instead of dropping it. */
function call(entry: TerminalEntry, operation: string, fallback: string, run: () => Promise<{ ok: boolean; error?: string }> | undefined): void {
  let pending: Promise<{ ok: boolean; error?: string }> | undefined;
  try { pending = run(); } catch (cause) { report(entry, operation, cause); return; }
  if (!pending) { report(entry, operation, BackendError.local('UNSUPPORTED', `${fallback} This desktop build does not offer it.`, operation)); return; }
  pending.then((result) => checkOk(result, operation, fallback)).catch((cause) => report(entry, operation, cause));
}

export function writeToPty(entry: TerminalEntry, data: string): void {
  if (entry.exited) return;
  call(entry, 'pty.write', 'Could not send terminal input.', () => findBridge()?.writePty(entry.ptyId, data));
}

function resizeToFit(entry: TerminalEntry): void {
  call(entry, 'pty.resize', 'Terminal resize failed.', () => findBridge()?.resizePty?.(entry.ptyId, entry.term.cols, entry.term.rows));
}

/** Tell programs that opted into DEC 2031 that the theme changed (`CSI ? 997 ; 1|2 n`). */
export function notifyThemeChangeAll(theme: 'light' | 'dark'): void {
  for (const entry of pool.values()) notifyThemeChange(entry, theme);
}
function notifyThemeChange(entry: TerminalEntry, theme: 'light' | 'dark'): void {
  if (entry.exited || !entry.themeNotify) return;
  writeToPty(entry, `\x1b[?997;${theme === 'dark' ? 1 : 2}n`);
}

/** Get (or lazily create) the persistent terminal for a pty. */
export function acquireTerminal(ptyId: string, theme: ThemeMap, fontSize: number): TerminalEntry {
  const existing = pool.get(ptyId);
  if (existing) return existing;
  const bridge = findBridge();

  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';

  const term = new Terminal({
    theme,
    // Munder's face and metrics. lineHeight 1.0 keeps TUI box-drawing rows joined.
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
    fontSize,
    lineHeight: 1.0,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 100000,
    // Keeps text legible whatever cell colours a program paints (WCAG AA).
    minimumContrastRatio: 4.5,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Unicode 11 widths: with xterm's default (Unicode 6) an emoji is one cell, but Claude Code
  // lays text out with modern widths, so the glyph overflows into the next character.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';

  const entry: TerminalEntry = { ptyId, term, fit, host, opened: false, needsRendererRepaint: false, exited: false, unsub: [], recovery: createTerminalRecoveryState(), themeNotify: false };
  registerLinkProvider(entry);

  if (bridge) {
    // Subscribe ONCE for the terminal's whole lifetime, so the buffer keeps filling off screen.
    entry.unsub.push(bridge.onPtyData(ptyId, (raw) => {
      const chunk = normalizePtyChunk(raw);
      if (!chunk) return;
      const active = term.buffer.active;
      const follow = active.viewportY >= active.baseY;
      term.write(chunk, () => { if (follow) { try { term.scrollToBottom(); } catch { /* detaching */ } } });
    }));
    entry.unsub.push(bridge.onPtyExit(ptyId, ({ exitCode, signal }) => {
      entry.exited = true;
      term.writeln(`\r\n\x1b[2m─ process exited (code ${exitCode}${signal ? `, signal ${signal}` : ''}) ─\x1b[0m`);
    }));
    // An agent restarted into this same pty: re-arm input and start from a clean grid.
    const offRelaunch = bridge.onPtyRelaunch?.(ptyId, () => {
      entry.exited = false;
      try { term.reset(); } catch { /* not yet open */ }
    });
    if (offRelaunch) entry.unsub.push(offRelaunch);
  }

  // Copy and paste: Ctrl/Cmd+C copies only while a selection exists (otherwise it stays SIGINT),
  // Ctrl/Cmd+Shift+C copies, Ctrl/Cmd+Shift+V pastes, right-click copies a selection or pastes.
  const copySelection = (): boolean => {
    if (!term.hasSelection()) return false;
    const text = sanitizeTerminalSelection(term.getSelection());
    if (text) {
      const copy = findBridge()?.copyToClipboard;
      if (copy) call(entry, 'clipboard.copy', 'Could not copy the selection.', () => copy(text));
      else void navigator.clipboard?.writeText(text).catch((cause) => report(entry, 'clipboard.copy', cause));
    }
    return true;
  };
  const pasteClipboard = (): void => {
    if (entry.exited) return;
    const b = findBridge();
    // Read synchronously when possible: dictation tools restore the old clipboard a tick after pasting.
    try {
      const text = b?.readClipboardSync?.();
      if (typeof text === 'string') { if (text) term.paste(text); return; }
    } catch { /* fall back to the async read */ }
    const read = b?.readClipboard ? b.readClipboard() : navigator.clipboard?.readText();
    void read?.then((t) => { if (t) term.paste(t); }).catch((cause) => report(entry, 'clipboard.paste', cause));
  };
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    // Shift+Enter: xterm would send a bare CR (submit); TUIs expect ESC CR (new line).
    const seq = terminalKeySequence(ev);
    if (seq !== null) {
      writeToPty(entry, seq);
      ev.preventDefault();
      return false;
    }
    if (!(ev.ctrlKey || ev.metaKey)) return true;
    const key = ev.key.toLowerCase();
    if (key === 'c' && (ev.shiftKey || term.hasSelection())) {
      if (copySelection() && !ev.shiftKey) term.clearSelection();
      ev.preventDefault();
      return false;
    }
    if (key === 'v' && ev.shiftKey) {
      pasteClipboard();
      ev.preventDefault();
      return false;
    }
    return true;
  });
  host.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (copySelection()) { term.clearSelection(); return; }
    pasteClipboard();
  });

  // Answer OSC 10/11 colour queries. A TUI that asks and gets silence falls back to its own
  // default, which is how panels end up light inside a dark terminal.
  const oscColorReply = (index: 10 | 11) => (data: string): boolean => {
    if (data !== '?') return false;
    if (entry.exited) return true;
    const map = term.options.theme as ThemeMap | undefined;
    const hex = index === 11 ? map?.background : map?.foreground;
    const rgb = hex && parseHexColor(hex);
    if (!rgb) return false;
    writeToPty(entry, `\x1b]${index};${oscColorBody(rgb)}\x1b\\`);
    return true;
  };
  term.parser.registerOscHandler(10, oscColorReply(10));
  term.parser.registerOscHandler(11, oscColorReply(11));
  // DEC 2031: answer with the current theme the moment a program opts in.
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (params.includes(2031)) {
      entry.themeNotify = true;
      const bg = (term.options.theme as ThemeMap | undefined)?.background;
      notifyThemeChange(entry, bg && !isDarkBackground(bg) ? 'light' : 'dark');
    }
    return false;
  });
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (params.includes(2031)) entry.themeNotify = false;
    return false;
  });

  term.onData((data) => writeToPty(entry, data));

  pool.set(ptyId, entry);
  return entry;
}

/** Take a WebGL renderer while the terminal is on screen. It is a lease, released on detach:
 *  Chromium keeps about 16 live WebGL contexts and silently drops the oldest past that, which
 *  left a background terminal black while its pty kept streaming (Munder terminalPool.ts).
 *  On init failure or context loss, the DOM renderer takes over instead of a black terminal. */
function leaseWebglRenderer(entry: TerminalEntry): void {
  if (entry.webgl) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      if (entry.webgl !== webgl) return;
      console.warn('[terminal] webgl context lost; using the DOM renderer');
      entry.webgl = undefined;
      entry.needsRendererRepaint = true;
      try { webgl.dispose(); } catch { /* noop */ }
      // Sleep and wake lose the GPU context and leave xterm's cell metrics stale.
      scheduleWebglRecovery(entry.recovery, requestAnimationFrame, () => repaintAfterRendererLoss(entry));
    });
    // Set before loadAddon: a context lost during init must be seen as the active renderer.
    entry.webgl = webgl;
    entry.term.loadAddon(webgl);
  } catch (e) {
    try { entry.webgl?.dispose(); } catch { /* noop */ }
    entry.webgl = undefined;
    console.warn('[terminal] webgl renderer unavailable; using the DOM renderer', e);
  }
}

/** The live webgl2 context in this terminal's own element (dispose() alone leaks it, xterm.js#6068). */
function webglContextOf(term: Terminal): WebGL2RenderingContext | null {
  const el = term.element;
  if (!el) return null;
  for (const canvas of Array.from(el.querySelectorAll('canvas'))) {
    let gl: WebGL2RenderingContext | null = null;
    try { gl = canvas.getContext('webgl2'); } catch { gl = null; }
    if (gl && !gl.isContextLost()) return gl;
  }
  return null;
}

/** Give the GPU context back when the terminal leaves the screen; buffer and pty stay. */
function releaseWebglRenderer(entry: TerminalEntry): void {
  const webgl = entry.webgl;
  if (!webgl) return;
  entry.webgl = undefined;
  const gl = webglContextOf(entry.term);
  try { webgl.dispose(); } catch { /* noop */ }
  try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* noop */ }
  entry.needsRendererRepaint = true;
}

/** Repaint once the host is on screen and sized; until then the marker stays set. */
function repaintAfterRendererLoss(entry: TerminalEntry): void {
  if (!entry.opened || !entry.host.isConnected || !entry.host.clientWidth || !entry.host.clientHeight) {
    entry.needsRendererRepaint = true;
    return;
  }
  reflowTerminal(entry);
  try {
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
    entry.needsRendererRepaint = false;
  } catch {
    entry.needsRendererRepaint = true;
  }
}

/** Munder's App-level pre-warm: a pooled terminal for every live pty, so its output is buffered
 *  from spawn and the first open shows the whole session, not just what came after. Nothing is
 *  opened or rendered until a view attaches it. */
export function prewarmTerminals(ptyIds: Iterable<string | undefined>, theme: ThemeMap, fontSize: number): void {
  for (const id of ptyIds) if (id) acquireTerminal(id, theme, fontSize);
}

/** Re-parent a pty's terminal into `container`, opening xterm on first attach. */
export function attachTerminal(entry: TerminalEntry, container: HTMLElement): void {
  container.appendChild(entry.host);
  if (!entry.opened) {
    // open() first: the WebGL addon loads only onto an opened terminal.
    entry.term.open(entry.host);
    entry.opened = true;
  }
  leaseWebglRenderer(entry);
  if (entry.needsRendererRepaint) scheduleWebglRecovery(entry.recovery, requestAnimationFrame, () => repaintAfterRendererLoss(entry));
  // Output from before we subscribed is gone: ask the TUI for one fresh frame at its current size.
  // This is the step whose absence left Paramount's pane blank or half-drawn on attach.
  requestInitialPtyRedraw(entry.recovery, () => {
    const redraw = findBridge()?.redrawPty;
    if (!redraw) {
      report(entry, 'pty.redraw', BackendError.local('UNSUPPORTED', 'This desktop build cannot ask the session to redraw; output from before you opened it appears on its next repaint.', 'pty.redraw'));
      return;
    }
    return redraw(entry.ptyId).then((result) => checkOk(result, 'pty.redraw', 'The session did not redraw.')).catch((cause) => {
      report(entry, 'pty.redraw', cause);
      throw cause; // clears the latch, so the next attach tries again
    });
  });
}

/** Take the terminal off screen. Buffer, scrollback and subscription stay in the pool. */
export function detachTerminal(entry: TerminalEntry, container: HTMLElement): void {
  // Another view may already own the host (React can mount the new owner first).
  if (entry.host.parentElement !== container) return;
  releaseWebglRenderer(entry);
  container.removeChild(entry.host);
}

/** Fit to the host and resize the pty only when the grid changed (each resize repaints the TUI). */
export function fitTerminal(entry: TerminalEntry, scrollToEnd = false): boolean {
  const host = entry.host;
  if (!entry.opened || !host.isConnected || !host.clientWidth || !host.clientHeight) return false;
  try {
    const before = { cols: entry.term.cols, rows: entry.term.rows };
    entry.fit.fit();
    if (entry.term.cols !== before.cols || entry.term.rows !== before.rows) resizeToFit(entry);
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
  } catch { return false; }
  if (scrollToEnd) {
    // One line up, then back down, so xterm re-syncs the DOM scrollTop after re-parenting.
    try { entry.term.scrollLines(-1); entry.term.scrollToBottom(); } catch { /* noop */ }
  }
  return true;
}

/** Re-measure cell metrics after a wake or font load, without moving the scroll position. */
export function reflowTerminal(entry: TerminalEntry): void {
  if (!entry.opened) return;
  try {
    entry.term.options.fontFamily = entry.term.options.fontFamily;
    entry.term.options.fontSize = entry.term.options.fontSize;
    entry.term.clearTextureAtlas?.();
  } catch { /* noop */ }
  fitTerminal(entry);
}

/** Tear down a pty's terminal (when the agent is gone for good). */
export function disposeTerminal(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (!entry) return;
  entry.unsub.forEach((u) => { try { u(); } catch { /* noop */ } });
  releaseWebglRenderer(entry);
  try { entry.term.dispose(); } catch { /* noop */ }
  entry.host.remove();
  pool.delete(ptyId);
}

/** Drop terminals whose pty is no longer live, so the pool does not grow forever. */
export function pruneTerminals(livePtyIds: Iterable<string>): void {
  const live = new Set(livePtyIds);
  for (const id of [...pool.keys()]) if (!live.has(id)) disposeTerminal(id);
}

// ⌘/Ctrl-click a URL or a path in terminal output. The text is agent output, so it is treated
// as hostile: URLs go only to the https-only opener, paths only to a stat and a reveal in Finder,
// never to "open with the default app". A plain click stays with the TUI.
function resolvePath(ptyId: string, raw: string): string | null {
  const p = stripPathToken(raw);
  if (!isPathToken(p)) return null;
  if (p.startsWith('/')) return p;
  const cwd = cwdOf(ptyId);
  if (!cwd) return null;
  if (p.startsWith('~/')) return null;
  return `${cwd}/${p.replace(/^\.\//, '')}`;
}

function registerLinkProvider(entry: TerminalEntry): void {
  const { term, ptyId } = entry;
  try {
    term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        const text = line ? line.translateToString(true) : '';
        if (!text || (!text.includes('.') && !text.includes('://'))) { callback(undefined); return; }
        const links: NonNullable<Parameters<typeof callback>[0]> = [];
        for (const span of terminalLinkSpans(text)) {
          const range = { start: { x: span.start + 1, y: bufferLineNumber }, end: { x: span.start + span.raw.length, y: bufferLineNumber } };
          if (span.kind === 'url') {
            const url = span.token;
            links.push({ range, text: url, decorations: { underline: true, pointerCursor: true }, activate: (event) => {
              if (event && !(event.metaKey || event.ctrlKey)) return;
              call(entry, 'link.open', 'Could not open the link.', () => findBridge()?.openExternal?.(url));
            } });
            continue;
          }
          const abs = resolvePath(ptyId, span.raw);
          if (!abs) continue;
          classifyPathToken(span.token); // every verdict reveals here; Paramount has no editor
          links.push({ range, text: span.raw, decorations: { underline: true, pointerCursor: true }, activate: (event) => {
            if (event && !(event.metaKey || event.ctrlKey)) return;
            call(entry, 'path.reveal', 'Could not show the file.', () => findBridge()?.revealPath?.(abs));
          } });
        }
        callback(links.length ? links : undefined);
      },
    });
  } catch { /* proposed API unavailable: links stay off */ }
}
