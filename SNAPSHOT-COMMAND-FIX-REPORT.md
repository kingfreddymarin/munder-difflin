# NSC-216 — Nonblocking snapshot command discovery

## Change

Snapshot prerequisite assembly no longer calls `PtyManager.commandPath()` for `claude`, `codex`, or `mempalace`. A bounded asynchronous resolver runs the same fenced login-shell `which` query (or asynchronous Windows `where`) with safe command-name validation, a 3-second timeout, 256 KiB output cap, per-command in-flight deduplication, and exponential failure backoff capped at 60 seconds. Successful paths expire after 60 seconds and confirmed absence after 30 seconds; failures remain `unknown`, and reliable absence becomes `missing`.

Resolved changes use the existing Paramount snapshot invalidation event. The sign-in monitor's snapshot path callback reads/starts this asynchronous cache and does not enter synchronous resolution. “Check again” awaits a forced asynchronous path refresh for the provider default; a selected account's explicit binary continues to bypass default discovery. `PtyManager.commandPath()` retains its synchronous retry behavior for explicit spawn/install decisions, with common fallback candidates factored into a helper. The actual UI maps `checking` and `unknown` to an unknown prerequisite, not a missing-tool/install state.

The HOME-free pre-fix fixture is retained. It uses synthetic files, an injected `spawnSync` boundary, a fake `SHELL` path that is never executed, and no real account, profile or GUI.

## Evidence

Pre-fix replay, before product edits:

```sh
REPRO_SNAPSHOT_COMMAND_RESOLUTION=1 node --test test/paramount-snapshot-command-resolution.test.cjs
```

Raw output: `evidence/snapshot-command/before-corrected.log`. The failed-capture scenario made five synchronous shell probes across snapshot prerequisite/sign-in checks, took 647.3 ms in the synthetic snapshot, and produced 645 ms and 636 ms event-loop lag samples. These injected delays demonstrate the blocking mechanism; they do not establish the cause of the historical 12,283 ms app event.

After-fix focused command:

```sh
node --test test/paramount-snapshot-command-discovery.test.cjs test/paramount-snapshot-timing.test.cjs test/engine-signin.test.cjs test/engine-availability.test.cjs test/command-name-validation.test.cjs test/windows-command-fallback.test.cjs
```

Raw output: `evidence/snapshot-command/after-focused.log` — 43 passed, 1 Windows-only test skipped. The production projection and monitor callback fixture asserts zero `spawnSync` calls with all three discoveries cold, repeats overlapping snapshot projection calls, and proves a scheduled event-loop sentinel runs while all async probes remain pending. It also checks fenced async-shell output, timeout kill, failure-as-unknown/backoff, confirmed missing, invalid-name rejection, later install recovery, explicit `commandPath()` retry after installation, and sign-in account-bin preservation.

```sh
npm run typecheck:node
```

Passed; raw output: `evidence/snapshot-command/node-typecheck.log`.

```sh
npm test                         # from ui/
npm run typecheck                # from ui/
npm run build                    # from ui/
```

Passed: UI tests 117/117, UI typecheck, and UI production build. Raw logs are in `evidence/snapshot-command/ui-tests.log`, `ui-typecheck.log`, and `ui-build.log`. The separate UI dependency symlink points to the existing workspace dependency tree; manifests matched, and no packages were installed. The build reports the existing large-chunk warning.

`git diff --check` passed. No broad aggregate, root package build, live shell/account/floor, GUI or package run was performed.

## Limits

- Tests use injected subprocess and filesystem boundaries; the actual user login shell and packaged Electron IPC were not exercised.
- The original 12,283 ms stall remains unattributed. This correction removes the reproduced synchronous command-discovery work from snapshot polling, but does not claim a packaged runtime performance acceptance.
- Explicit spawn/install checks intentionally retain the existing synchronous resolver and its retries; only periodic snapshot discovery and the sign-in monitor lookup use the asynchronous cache.
