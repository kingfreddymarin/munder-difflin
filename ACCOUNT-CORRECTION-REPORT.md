# Account correction implementation report

Branch: `codex/paramount-account-correctness-20261113`, based on `6e54ec753ac069566af508353c31e115bec6476e`.

This report records implementation evidence for independent review. It is not a self-review verdict.

## A1 — preserve explicit account choice

**Fail before:** `hive/agents/jim-mwef5ykj/repros/paramount-account/unresolved-launcher-default.cjs` reproduced the saved alternate launcher disappearing from `team.models` after its fingerprint changed, while actual spawn rejected that saved choice. The crashed-chat recovery card then appeared to target the provider default. The `6e54ec75` review records this mismatch.

**Delta:** `team.models` now distinguishes `default`, `selected`, `stale`, and `unavailable`; it keeps saved launcher identity for stale/unreadable picks instead of erasing it. Profile and crashed-chat recovery hide Sign in/Check again for stale or unavailable selections and route the user to explicit refresh/reselection. An unreadable selection is passed to sign-in as a deliberately invalid account ID so main-process behavior cannot fall through to the provider default. Launcher settings disable saving an unresolved value until the user changes the selection. Exact default and valid selections remain usable.

**Evidence:** `test/council-account-launchers.test.cjs` covers valid, stale fingerprint, and unreadable discovery results; `test/paramount-team.test.cjs` covers the default model shape; `test/claude-channel-recovery.test.cjs` asserts recovery UI scope and profile navigation. Targeted run:

```text
node --test test/claude-channel-recovery.test.cjs test/council-account-launchers.test.cjs test/paramount-team.test.cjs
84 tests passed, 0 failed
```

These are service/model and source-contract checks. No renderer interaction, authenticated provider login, or live account was used.

## A2 — scoped channel file update and recovery

**Fail before:** the previous test executed only the text transformation and regex checks; it did not run backup/apply/restore file operations. The `6e54ec75` review found restoration unverified and restore errors without a specific recovery state/path. No data loss was reproduced.

**Delta:** the one-file updater is now an injected file-operation state machine used by the fixed `~/.minion-aliases.sh` IPC handler. It retains the fixed path, regular non-symlink checks, one-use five-minute token, original hash and file identity checks, syntax validation, same-directory temporary replacement, and mode-preserving backup. It verifies backup bytes, mode and shell syntax; verifies the temporary and replaced target; rechecks identity/content immediately before replacement; and restores through a verified temporary file. Results distinguish `unchanged`, `restored`, and `manual-restore`. If restore fails after replacement, the UI reports that the target may be unverified and shows the path to the verified backup.

Runtime tests use temporary files and real filesystem operations with injected failures. They cover a successful update and verified backup, one-use token, stale edit, an edit during preparation, symlink/wrong target, expiry, post-replacement verification failure with exact restore, and injected restore `EIO` with manual recovery instructions. No user home aliases file was read or written.

Residual race: a non-cooperating editor can still change the file in the narrow interval between the final identity/hash check and atomic rename. Eliminating that interval portably would require a stronger coordination mechanism or platform-specific operation outside this scoped change. Backup and recovery tests exercise the updater service, not Electron dialog IPC end to end.

## Validation

- Changed-area tests: **84 passed, 0 failed**.
- `npm run typecheck`: **passed** (Node and web).
- `npm run build`: **passed**; existing Vite dynamic/static import warning was emitted.
- `npm run test:focused`: **failed** (1,322 tests reported; 1,298 passed, 31 failed, 1 cancelled, 2 skipped). One failure is an existing test attempting to write `/Users/macbookair/.md-statabs-*`, denied by this sandbox (`EPERM`). Other failures were not individually triaged in this implementation run; this aggregate run is not a clean suite result. The changed-area test run above passed independently.
- `git diff --check`: passed.

No application GUI, live agent, real account, actual alias-file write, or external send was used. The checkout also contains an untracked `.trigger-tree/` directory not part of this delta; it was left untouched.

## Review cycle 2 — `REVIEW-2026-11-13-account-correction-fail.md`

The cycle-2 findings are fixed:

1. The mock provider now returns `accountSelection: 'default'` for each sample agent, satisfying the account-model contract.
2. Crashed-chat recovery opens the Team agent sheet's `overview` tab, where the launcher picker is rendered.
3. `LauncherSettings` now reloads its local model after refresh/save and notifies its parent. `AgentSheet` reloads its cached models on that notification, so saved account resolution updates in the open sheet. Sign-in status resets when `accountSelection` changes.

Regression evidence: the new `ui/tests/account-selection-recovery.test.mjs` was run before the source fixes and failed all four assertions; it passes all four after the fixes. Its component harness executes the refresh/save handlers and verifies the parent notification. This is not browser-rendered GUI acceptance.

Validation after cycle 2:

- `cd ui && npm run typecheck` — passed.
- `cd ui && npm test` — **109 passed, 0 failed**.
- `cd ui && npm run build` — passed; Vite emitted its existing large-chunk warning.
- Root `npm run typecheck` (Node + web) — passed.
- Changed-area core tests — **84 passed, 0 failed**.
- Full root `npm run test:focused` was not rerun. No retained full-suite log exists; the earlier run identified only the sandbox `EPERM` case. The other 30 failing cases and one canceled case remain unknown/unclassified.

Separate UI validation now covers the `ui/` project; it was not part of the earlier root typecheck/build. No application GUI, home account, or real launcher file was touched.
