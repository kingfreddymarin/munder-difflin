# Paramount

The front end of the agent command center: a React app you talk to one Paramount through, which runs a team of real CLI agents.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build
```

It starts on sample data (the mock provider). Your changes persist in the browser until you press **Settings → Account → Reset sample data**.

## Optional local runtime

Skidbladnir, the local model runtime from `02-products/lab/skidbladnir`, can handle local summarization and memory maintenance when installed and running. It is optional: standard agent work uses the configured CLI engine when Skidbladnir is unavailable. Settings › Setup shows its status and optional install/start commands; its absence does not block Paramount.

Heartbeat and startup requests appear as short system updates in Chats. **Open terminal** opens the agent's live session and its **Updates** tab, where the original message remains available. Ordinary human messages show their original text without an added transport heading. A stopped orchestrator can be started again from Team; its identity and history are retained.

## Screens

| Screen | What it does |
| --- | --- |
| Home | Objectives with progress, Ask me, agent activity, recently closed cards, what went well, Health button |
| Chats | One chat per agent, group chats per ticket, Telegram. Your messages are **priority**: they go to the front of the agent's queue |
| Board | Kanban (columns or by agent). A card holds created date, Studio task, description, plan steps, done-means, evidence |
| Team | One customizable screen: team graph, agents, activity, data-source access, automations. Tap an agent for its profile sheet |
| Terminal | Each agent's live session, the question it is waiting on as buttons, and an input to type into it |
| Health | Command center and Studio services, problems with fixes, event log |
| Settings | Account, connections, Autonomy & YOLO, iteration speed, notifications, **My changes** (audit log) |

The bell in the top right is **Ask me**: every question, approval and suggestion waiting on you. No screen scrolls; long lists open in a side sheet.

## How the UI talks to the core

```
UI ── command (intent) ──►  core: validate → append event to hive/log.jsonl
UI ◄── event stream ──────  core: projections (chats, board, team, health)
```

- `src/data/protocol.ts` — the contract: `Command`, `FloorEvent`, `DataProvider`.
- `src/data/reducer.ts` — applies an event to state. Every event from you becomes an audit entry and a context note in each affected agent's chat.
- `src/data/mock-provider.ts` — in-browser stand-in for the core.
- A `CoreProvider` (JSON-RPC 2.0 over a local WebSocket) replaces the mock without touching any screen. Change one line in `src/App.tsx`.

Nothing about your org lives in components: agents, engines, sources, services, navigation and Team panels are data (`src/data/fixtures.ts`, `src/config/navigation.tsx`).

## Components

All interactive and animated components come from [animate-ui](https://animate-ui.com), vendored under `src/components/animate-ui/`: sidebar, tabs, dialog, sheet, popover, dropdown menu, hover card, tooltip, switch, toggle group, radio group, progress, buttons, theme toggler, code block, sliding number and animated icons. They were copied from the animate-ui registry because animate-ui.com is not reachable from this machine; their npm dependencies are in `package.json`.

animate-ui builds on shadcn/ui, so a few plain shadcn primitives it expects live in `src/components/ui/`: avatar, badge, card, input, label, separator, skeleton, textarea, and the base button the sidebar imports.

App-level building blocks are reused across screens from `src/components/app/`: `AgentAvatar`, `AgentSummary`, `MessageItem`, `CardDetail`, `TokenMeter`, `Tile`, `SeeAll`, `AskItem`, `FilterChips`, `StatTile`.

## Not built yet

- The core service (router, PTYs, committer, scheduler) and the `CoreProvider`.
- Full TTY fidelity in Terminal (colours, cursor control) needs a terminal emulator such as xterm.js; animate-ui has none. The current view renders the session's text stream.
- The desktop shell (Tauri recommended, to match Hlidskjalf) and the unsigned macOS installer.
