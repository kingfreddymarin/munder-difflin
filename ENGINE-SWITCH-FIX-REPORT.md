# Engine switch fix report

Base: `247a8656293872b51adf90c701b56edf083580c1`.

## Findings and fixes

### F1 — Immediate target process exit was reported as success

**Before:** The transaction treated `PtyManager.spawn()` allocation success as target startup success. The review reproduced `/bin/sh -c 'exit 23'` being persisted as a successful switch before exit was observed.

**Fix:** `PtyManager` now exposes a bounded natural-exit observation for a PTY. The switch transaction waits 300 ms for target viability before persisting model/account preferences. An early exit takes the existing stop/rollback path and returns the exit code.

**Regression:** `a real PTY target that exits immediately is rejected before preferences persist` uses a real `/bin/sh` PTY, confirms exit code 23, confirms persistence was not called, and confirms rollback ran.

**Status:** PASS after fix. A pre-fix reproduction was recorded by the independent reviewer in `REVIEW-2026-11-13-engine-switch-fail.md`: `switchResult: {ok:true}`, persisted true, followed by exit 23. That reproduction was against the same production helper and `PtyManager`.

### F2 — Concurrent switch/restart operations could corrupt active selection

**Before:** Neither switch nor restart serialized operations per agent. The review reproduced concurrent switch transactions where a failed second target rolled back provider/model/account while the first target remained live. The source also showed restart could kill a concurrently started target.

**Fix:** `withAgentLifecycleLock` is shared by the entire switch and restart handlers. A concurrent contender returns an explicit in-progress error before taking snapshots or stopping a process. `finally` releases the lock after success, normal failure, or thrown rollback.

**Regression:** `per-agent lifecycle lock rejects contenders and releases after success or throw` verifies contender rejection and cleanup. Existing transaction regressions cover target-stop failure and prevent rollback from starting a duplicate process.

**Status:** PASS for lock primitive and cleanup. Mixed switch/switch and switch/restart were not driven through Electron IPC in this worktree; reviewer owns full IPC/UI acceptance.

### F3 — Stopped-agent rollback lost its resumable session pointer

**Before:** A provider change cleared `sessionId`; stopped-agent rollback used `setAgentProvider`, which intentionally did not restore it. The review observed `lastSession` become null after persistence failure.

**Fix:** Stopped-agent rollback now re-registers the original provider metadata through `HiveManager.ensureAgent` with the saved session ID, then restores its archived state. Account and model restoration remain in the surrounding rollback path.

**Regression:** `stopped-agent switch rollback restores the session pointer through HiveManager` drives a failing transaction through the real `HiveManager` and checks provider and session pointer.

**Status:** PASS after fix. Active-agent rollback continues using the existing resume path.

## Validation

- `node --test test/paramount-engine-switch.test.cjs test/paramount-provider-session-switch.test.cjs` — **8 passed, 0 failed**.
- `npm run typecheck:node` — **passed**.
- `git diff --check` — **passed**.
- No Electron IPC/UI acceptance or packaged build was run.

## Changed files

- `src/main/index.ts`
- `src/main/paramount-engine-switch.ts`
- `src/main/pty.ts`
- `test/paramount-engine-switch.test.cjs`
- `test/paramount-provider-session-switch.test.cjs`
- `ENGINE-SWITCH-FIX-REPORT.md`
