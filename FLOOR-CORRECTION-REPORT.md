# Floor correction report (NSC-210 / NSC-211)

## Reproduction and plan (before changes)

- NSC-211 reproduction: `dataFolderRefusal` compares `resolve()` outputs only. A symlink alias of an app data directory passes, as does a case variant on a case-insensitive filesystem. A path below a symlinked directory can also escape the lexical check. The check must compare existing canonical ancestors and then append the nonexistent suffix without creating or modifying paths.
- NSC-210 reproduction: `openFloorProcess` returns success on the child's `spawn` event and schedules parent-picker quit 250 ms later. Spawn means only that the process launched, not that it successfully opened the requested floor.
- Plan: add canonical path comparison that resolves existing ancestor symlinks and handles case-insensitive path spelling; unit-test aliases and nonexistent descendants with disposable fixtures. Add a bounded readiness acknowledgement from the child once it has claimed and opened its requested floor; keep the parent picker alive and report child errors, early exit, and timeout. Use synthetic child processes and focused floor tests only.

## Results

- `dataFolderRefusal` now canonicalizes the existing path prefix with `realpath`, preserves missing descendants without filesystem writes, and compares case-insensitively on default macOS/Windows platforms.
- New Floor now waits up to 15 seconds for a nonce-matched readiness message. The child sends it only after it claims the requested floor and completes floor-service startup. Spawn errors, exit before acknowledgement, and timeout return failure; the picker closes only after acknowledgement.
- Added disposable filesystem coverage for symlink aliases and missing descendants. Existing detached-process coverage now uses a synthetic child that emits the readiness message.
- Verification: `node --test test/floors.test.cjs` passed (20/20); `npm run typecheck:node` passed; `npm run build` passed (main, preload, renderer, asset copy).
- Limits: case alias behavior is explicitly covered only on case-insensitive platforms; this runtime was macOS. No live application or graphical floor launch was attempted, per the dispatch.

## New Floor acknowledgement correction (review follow-up)

- Failed-before: the supplied production-handler fixture reproduced all three defects on `a261e09e`: an acknowledgement repeated on later output, a late acknowledgement mutated state after timeout and scheduled picker quit, and a valid acknowledgement was dropped when followed by more than 256 bytes in the same chunk.
- Changes: process each complete output line before bounding the incomplete-line carry; ignore output after settlement; detach acknowledgement/error/exit listeners on settlement; perform readiness side effects once inside an error boundary; schedule picker quit only on successful acknowledgement.
- Coverage: split and large chunks, noise and duplicate acknowledgements, wrong nonce, timeout with a late acknowledgement, early child exit and spawn error, plus the existing successful detached-child flow.
- Verification: `node --test test/floors.test.cjs` passed 21/21; `tsc --noEmit -p tsconfig.node.json` passed; `git diff --check` passed. Existing dependencies were borrowed from `/Users/macbookair/Documents/studio/worktrees/paramount-daily-use-integration/node_modules`. The supplied fixture reproduced the three failures on `a261e09e` before the fix.
- Limits: no application launch, live floor, account or external action was attempted. Build was not run in this follow-up.
