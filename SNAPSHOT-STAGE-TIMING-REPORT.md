# NSC-216 — snapshot stage timing diagnostics

## Result

Added bounded, payload-free timing to the `paramount:snapshot` handler at the approved `51d56ab1` checkpoint. This is diagnostic instrumentation only: no snapshot fields or account-selection logic changed, no asynchronous operation was moved, and no performance fix is claimed.

Each slow stage emits one stderr JSON line with `kind: paramount-snapshot-stage`, the existing snapshot correlation ID, a fixed stage name, synchronous invocation time, awaited settlement time, total, and `ok`/`error` outcome. Synchronous and awaited time are measured separately with monotonic `performance.now()`. Stages under 100 ms are quiet; output is capped at 12 events per minute process-wide. Events contain no paths, configuration, provider/account labels, command output, errors, or snapshot payload. A failed diagnostic sink is ignored so it cannot alter the result or replace an original error. The stderr sink is available before a floor is selected.

Instrumented stages are config, floor setup, hook health, orchestrator failure state, registry, tasks, messages, organization, archived agents, log tail, roster, activity, projected snapshot config, missions, PTYs, preferences, integrations, the asynchronous Skid probe, engine paths, and sign-in status. The handler wiring test pins their existing evaluation order.

## Runtime evidence distinction

The preserved packaged-app stderr still records a **12,283 ms** lag during `paramount.snapshot`, but it has no stage-level timing. The accompanying `current-floor-runtime.json` records spans of 1,101 ms during floor open, 3,500 ms during worker wake, 275 ms for a runtime beat, and 335/812 ms for team-model dispatches. Those are overlap labels from that capture, not identified blockers.

`floor-service-stages.json` is a separate floor-startup run: 370.5 ms total, including 299.5 ms for `hive.memory`. It does not explain the 12,283 ms snapshot lag. No new GUI or live profile run was performed, so no runtime stage event from the new instrumentation exists yet and the original cause remains unknown.

## Verification

- `node --test test/paramount-snapshot-timing.test.cjs test/main-thread-lag.test.cjs` — exit 0, **17 passed, 0 failed**. Covers known-bad synchronous blocking, quiet fast stage, production `HiveManager.voiceMessages` boundary with injected delay and preserved return value, async-only wait, sync/async failures, original error preservation, no payload logging, per-request correlation under overlap, sink failure, event cap, handler stage names/order, and existing lag/mailbox/log fixtures.
- Known-good/known-bad verifier: fast work emitted no event; a deliberately blocked stage produced a correlated stage event with `waitMs: 0`. The old overlap-only lag test remains green.
- `npm run typecheck:node` — exit 0.
- `node scripts/repro-snapshot-stall-attribution.cjs` — exit 0; still reproduces a 316 ms synthetic stall with overlap-only lag labels. It is not evidence of the original cause.
- `git diff --check` — exit 0.

## Limits and next step

The Electron IPC handler was not invoked end-to-end; its production timing helper and actual HiveManager message-read boundary are covered with isolated fixtures, and a source test verifies the handler wiring/order. No GUI, live accounts, profile access, package build, or broad suite was used.

A future approved disposable packaged run should collect the new `[snapshot-stage]` lines while reproducing the stall, then compare `syncMs` against `waitMs` by stage and correlation ID. Only a stage with reproduced blocking evidence should receive a separate behavior-fix plan.
