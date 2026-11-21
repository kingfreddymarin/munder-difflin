# NSC-216 — Paramount snapshot stall reproduction and bounded plan

## Verdict

**The published 12,283 ms main-thread stall is not attributable to a single snapshot dependency from the preserved evidence.** A runnable fixture reproduces the production lag probe's event-loop stall report and demonstrates its attribution limit. It does not claim to reproduce the published 12.283-second cause.

## Captured evidence

- Build: `ebaaffd0a68448138d0af0aaef8f3c56e3a51425`, packaged Paramount 0.4.6, macOS arm64, Electron 32.3.3. The preserved `app.asar` hash is `23f858b8ee7b14c5e2128cf0c64864836ba0f4673e22de7959e833e2cccd5f33`.
- `stderr.log`: `[lag] 12283 ms during paramount.snapshot` and a separate 231 ms `unknown` stall.
- `current-floor-runtime.json`: 1,101 ms overlapping floor-open and snapshot, 3,500 ms overlapping worker-wake and snapshot, 275 ms runtime beat, and 335/812 ms team-model dispatch lags. These labels identify work active during the timer delay, not the blocking call.
- The disposable floor has no `log.jsonl`; no successful floor selection or user action is established. No nested snapshot stage timings or IPC request duration were captured.
- The snapshot handler in `src/main/index.ts` combines synchronous config/floor/hive/roster/activity reads with an awaited service probe. The evidence does not distinguish a slow synchronous call from overlapping work or asynchronous wait.

## Runnable reproduction

From this checkout:

```sh
node scripts/repro-snapshot-stall-attribution.cjs
```

The script imports the production `createLagProbe`, `lagOp`, and `traced` helpers, runs a deterministic 300 ms synthetic synchronous stall inside a `paramount.snapshot` span, and asserts that the resulting event names both the snapshot and the synthetic dependency. On this run it reported 284 ms. This reproduces the telemetry behavior, not the original dependency or its 12.283-second duration.

Related production-path tests:

```sh
node --test --test-name-pattern="blocking snapshot is named|snapshot's floor reads" test/main-thread-lag.test.cjs
```

Result: 2 passed, 6 filtered. One test confirms `traced()` plus the real lag probe observes a synthetic block. The other calls production `HiveManager.voiceMessages()` and `logTail()` on a synthetic 5,000-message / 50,000-line floor and asserts their warmed CPU time is under 50 ms. This does not cover the complete Electron snapshot handler or the published profile state.

## Bounded next plan (no product change in this phase)

1. Add temporary, payload-free monotonic timings around the snapshot's top-level sections and awaited probes. Record synchronous elapsed time separately from awaited duration and correlate with the existing snapshot correlation id; retain the event-loop lag probe.
2. Add an isolated production-helper fixture that invokes the same section boundaries with synthetic floor data and one injected slow dependency at a time. Confirm the trace identifies the injected stage and separately reports event-loop delay.
3. Re-run the preserved-size mailbox/log fixture and exercise concurrent snapshot, floor-open, and worker-wake activity in a synthetic process. Do not use the published profile or launch the GUI.
4. Change only the dependency proven to block the main event loop, using its existing asynchronous or cached path where valid. Add a regression test for the reproduced input, compare before/after stage and lag timings, then run focused tests and required typechecks. No broad suite or packaging for this investigation.

## Limits

- The 12,283 ms observation has no corresponding nested stage trace, request-duration record, or known action sequence; the precise cause remains unknown.
- The synthetic stall deliberately blocks the event loop and is only an instrumentation reproduction.
- The under-50 ms mailbox/log result is a warmed helper measurement, not a full snapshot timing or guarantee for arbitrary floor size.
- No GUI, live account/provider, live profile database, credential copy, or package launch was used.
