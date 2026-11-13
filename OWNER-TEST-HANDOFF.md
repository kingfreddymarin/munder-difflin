> Integration checkpoint: source preserved from 72812c9d. The final temp-worktree package was removed at teardown and must be rebuilt. Historical build/test details below are not current interactive acceptance.

# Owner test handoff — Claude to Codex switch

## Build

- App: `dist/nsc214-engine-switch-final/mac-arm64/Paramount.app`
- Platform/runtime: macOS arm64, Electron 32.3.3
- Signature: local ad-hoc signature; `codesign --verify --deep --strict` passed. This is not an Apple-signed or notarized release.
- Bundle tree SHA-256: `0c3de12cf8ae96a7a3051ad51e59363062a5e022e70e7803c94e6e9677722767`
- Executable SHA-256: `e4b788cc426003ae662eccbe7e1b7e988e7b270f6b9fbfd65a4f7f274f1e9f91`
- Source base: `7b8e8db91fa5f09cd7f27f9d6a7983454499c1ac` (`agent/worker-paramount-finish-daily-use`); this worktree contains uncommitted changes for harness integration.

## Ready in this slice

- Agent Profile offers an explicit provider, account launcher and model switch.
- Target provider starts fresh with no prior provider session id. A separate history file keeps the old session pointer, provider, model and launcher id; durable agent files, task links and identity remain in place.
- The current session is stopped before target startup. If target startup or preference persistence fails, the prior provider and session are restored when possible. If stopping the target fails, rollback does not start the old process, avoiding duplicate live sessions.
- Claude/Codex account discovery must be current. When launchers are discovered the switch requires a specific account selection; it does not infer an alternate account.
- A new-session notice states that unsaved conversation context is not transferred and asks the agent to continue from its durable files.

## Focused validation

- Team/provider switch and rollback tests: 41/41 passed across `test/paramount-team.test.cjs` and `test/paramount-engine-switch.test.cjs` (prior run).
- Provider session pointer test: 1/1 passed in `test/paramount-provider-session-switch.test.cjs` (prior run).
- Latest focused recovery/daily-use tests: 18/18 passed across `test/engine-signin.test.cjs`, `test/paramount-engine-switch.test.cjs`, `test/paramount-provider-session-switch.test.cjs`, `ui/tests/external-tools.test.mjs`, and `ui/tests/paramount-daily-use-actions.test.mjs`.
- Latest Node and web type checks passed; `npm run build` passed; Electron Builder produced the app bundle above from local Electron 32.3.3; `codesign --verify --deep --strict` passed.
- Not tested: live Claude/Codex account startup, a real authenticated switch, visual UI interaction, and interactive failure rollback. No real Jim agent or active floor was touched.

## Owner checks in a disposable floor

1. Duplicate a synthetic floor into a disposable location and create a fixture agent with a task, Rules, memory and handoff. Do not use the live Jim agent or a live floor for this check.
2. Open the fixture agent Profile, choose Codex, select the intended launcher explicitly (for example `dcxm`), and select an offered model.
3. Switch. Expect one terminal for the same agent id on Codex, the same task links and durable files, and an explicit notice that unsaved Claude conversation context did not transfer.
4. Confirm the active Codex session does not receive the Claude session id. Confirm the old id remains in `council/extensions/paramount-agent-engine-history.json` and is resumed only if switching back to Claude.
5. Try a missing target account or unsupported model. Expect validation to refuse before stopping the current session. The automated tests cover target start failure and preference-write failure rollback ordering; this package has not had an interactive post-start failure injected.
6. Confirm the alternate launcher remains selected and no credentials are displayed or copied.

## Acceptance gaps and remaining work

- The packaged app has not passed isolated GUI startup or interactive acceptance. A previous direct executable launch, run under Python with a disposable `--user-data-dir`, exited with `SIGABRT` before app code; macOS report `Paramount-2026-11-12-212809.ips` shows main-thread AppKit `_RegisterApplication` / `NSApplication` initialization, parent `Python`, Electron 32.3.3, macOS 26.5.2. The attempted Launch Services helper did not produce a result because Swift's module cache write was denied. The precise environment block from the direct launch was not captured; no credentials were included in diagnostics.
- The floor-entry lag probe now records stage timings, but no isolated floor-entry reproduction or measured blocking-stage fix has passed acceptance.
- Inline account recovery is implemented in Setup and the agent profile warning: Sign in opens the selected provider CLI in an embedded app terminal with the exact account home; Check again forces a fresh account-scoped probe and updates status without app restart. Unknown status is labeled as unknown, missing CLI remains a separate install prerequisite, and login commands are no longer shown as copyable text. Automated status and UI mapping tests pass; actual browser login and alternate-account isolation have not been interactively verified.
- Remaining NSC-193 work is still open: interactive provider-switch acceptance; right-click action acceptance; teams/delegation acceptance; attachments/dictation acceptance; complete board/mail/agent-context acceptance; floor-entry freeze diagnosis and measured fix; final God QA and Telegram notice.
- Disk image delivery remains unavailable because `hdiutil create` failed repeatedly in the earlier package attempt. This handoff is the validated app bundle only.
