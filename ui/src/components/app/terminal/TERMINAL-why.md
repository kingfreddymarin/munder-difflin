# Why the terminal is built this way

Talking to an agent in Council is its live PTY terminal, as in Munder Difflin. Owner decision, 2026-11-12.
Selecting an agent anywhere opens `#/terminal?a=<id>` (`src/app/agent-view.ts`). The chats page stays reachable
by link but is not in primary navigation.

## Renderer: the same stack as Munder
- xterm 5.5.0 with addon-fit 0.10.0, addon-webgl 0.19.0 and addon-unicode11 0.9.0, the exact versions Munder's
  renderer (`src/renderer/src/components/terminalPool.ts`) uses.
- These four packages are resolved from the app repo's own `node_modules` (Vite alias in `vite.config.ts`, `paths`
  in `tsconfig.json`), not from `ui/node_modules`. In this checkout `ui/node_modules` is a symlink to another app's
  dependencies (xterm 6), and changing those would change that app. `ui/package.json` still lists xterm 6. It is
  unused for the terminal and is left alone so the lockfile stays valid.
- Unicode 11 widths: Claude Code lays text out with modern widths (an emoji is two cells).
- WebGL is a lease: taken on attach, released on detach, because Chromium keeps about 16 live contexts. The DOM
  renderer takes over on init failure or context loss, and then repaints.

## Pool
One xterm per pty for the app's lifetime (`terminal-pool.ts`). A view re-parents it, so the scrollback survives an
agent switch, and the pty stream keeps filling the buffer while the terminal is off screen.

## Left out (Munder-only)
Queue automation, Arabic rendering and analytics.
