# NSC-216 — synchronous command-resolution reproduction

## Result

**A production-path blocking mechanism is reproduced for failed shell capture; it is not proof that it caused the historical 12,283 ms event.** Successful discovery and successful empty captures are cached and do not repeat shell launches on the warm snapshot path. A failed capture without the output fence remains retryable and is retried at each `PtyManager.commandPath()` call.

## Production path exercised

The fixture runs the actual `PtyManager.commandPath`, `shellEnv.captureFromLoginShell` cache, snapshot stage timer, `traced()` operation span, lag probe, and `createSignInMonitor`. It follows the snapshot's call order: Claude, Codex and Mempalace path checks under `enginePaths`, followed by Claude and Codex path checks under `signIn`. The production shell timeout value of 3,000 ms is asserted.

Only `child_process.spawnSync` is injected. It returns synthetic fenced success, empty fenced success, or failed/no-fence timeout results. The fake shell path is never executed; `node-pty` is stubbed because the fixture starts no PTY; filesystem existence is limited to synthetic files in a temporary directory. Sign-in status uses a deferred fake asynchronous runner, so no provider command or account is invoked.

## Runnable command and result

From this checkout:

```sh
REPRO_SNAPSHOT_COMMAND_RESOLUTION=1 node --test test/paramount-snapshot-command-resolution.test.cjs
```

Final run: exit 0, **3 passed, 0 failed**.

| Scenario | First snapshot shell probes | After warm snapshot | Measured result |
|---|---:|---:|---|
| Cold successful discovery | 3 | 3 total | All three binaries found; engine-path stage 0.8 ms, sign-in path stage 0.7 ms. Status returned `unknown` while the injected asynchronous status checks were pending. |
| Successful empty capture (commands missing) | 3 | 3 total | No binaries found; successful empty capture reused; no slow-stage or snapshot-lag event. |
| Failed capture (no fence / timeout result) | 5 | 10 total | Engine-path stage: 387.6 ms synchronous, 0 ms wait. Sign-in path stage: 259.5 ms synchronous, 0 ms wait. Snapshot request: 647.3 ms. Lag probe: 645 ms and 636 ms while `paramount.snapshot` was active. |

These figures are from the corrected no-`HOME`-override replay captured before product edits in `evidence/snapshot-command/before-corrected.log`. Earlier draft figures above have been replaced with this replay's actual values.

The failed scenario injects five 125 ms waits inside the production `spawnSync` boundary. Those delays are synthetic and bounded; they demonstrate the call count and event-loop effect without launching a real shell. Production `shellEnv` supplies a 3,000 ms timeout per attempt, so a fully timing-out set of five attempts could take up to roughly 15 seconds. This bound makes the mechanism plausible for a 12.3-second stall but does not establish historical causality.

## Interpretation

- A warm positive `PtyManager` path and each successful fenced shell capture are reused; subsequent snapshot checks add no shell launch.
- A valid but empty capture is non-null and cached even when the requested command is absent. Repeated command checks do not relaunch the shell in this case.
- A failed/no-fence capture returns `null`, which `shellEnv` does not cache. `PtyManager` also keeps only successful command resolutions, so the snapshot's three engine-path checks and later two Claude/Codex checks each retry synchronously. A later snapshot retries them again.
- `createSignInMonitor.status()` returns immediately with `unknown` and starts its status runner asynchronously. It did not account for the synchronous delay in this fixture.
- The failure run produced stage events with `waitMs: 0` and lag events naming `paramount.snapshot`. This is direct evidence that the failed command-resolution mechanism can synchronously block a snapshot when the injected shell capture fails.
- The actual packaged run did not record whether shell capture failed, how many shell probes ran, or which command stage was slow. The 370.5 ms floor-service timing is a separate run. The 12,283 ms cause remains unconfirmed.

## Bounded correction plan for review

Proposed next step: make the snapshot consume a nonblocking view of warmed command-path results. Cold or failed results should remain unknown in the snapshot while discovery runs asynchronously in the background or on explicit refresh. Keep the existing synchronous retry available to explicit spawn/install checks, where a just-installed CLI must become visible. Add a regression fixture that replays the five failed command-path checks and requires zero synchronous shell probes from the snapshot path, then separately verifies spawn/install retry still sees a newly available binary. Do not cache a failure in a way that prevents a later install from being discovered.

This is a proposed plan only. No production source or behavior was changed in this step; god owns the correction decision and any implementation dispatch.
