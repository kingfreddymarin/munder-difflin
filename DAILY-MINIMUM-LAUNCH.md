> Integration checkpoint: source preserved from 72812c9d. The final temp-worktree package was removed at teardown and must be rebuilt. Historical build/test details below are not current interactive acceptance.

# Paramount daily minimum: isolated launch guide

Candidate branch: `agent/worker-paramount-finish-daily-use`; base `7b8e8db9`. Recovery changes are recorded in the source commit reported in the task handoff.

## Build state

The main source build and UI production build passed. Electron Builder packaged the macOS arm64 app with the locally installed Electron 32.3.3 distribution. Build path: `dist/nsc193-daily-minimum-recovery/mac-arm64/Paramount.app`. This is an unsigned local build, not a release or delivery. Its tree hash is recorded in the task status after the build was finalized.

## Safe launch

Use a disposable profile and synthetic floor under `/private/tmp`; do not select a real Studio or Varium floor. The app must not replace or open the live owner build.

```sh
PROFILE="$(mktemp -d /private/tmp/paramount-profile.XXXXXX)"
open -n "$(pwd)/dist/nsc193-daily-minimum-recovery/mac-arm64/Paramount.app" --args --user-data-dir="$PROFILE"
```

Set up a synthetic floor under `/private/tmp`; seed fake agents and test files only. Use stand-in provider commands on a temporary `PATH`, not signed-in accounts.

## Checks for the isolated run

1. Confirm Board shows the synthetic task ledger and changes survive a normal quit/reopen.
2. Send agent-to-agent mail, confirm the target wakes, and inspect that both agent folders remain separate.
3. Put distinct rules, task instructions, and handoff entries in two fixture agents. Confirm fresh starts read their own Rules, handoff, inbox, and task context.
4. From one agent profile, change to a catalog-listed model; try both **Save model and resume** and **Save model and start fresh**. Confirm both keep the same agent id, assignment, identity and memory; resume must attach the saved session, while fresh must receive the bootstrap through the inbox queue.
5. From the orchestrator profile, try resume and fresh recovery and confirm its registered identity and floor assignment persist.
6. Simulate an unavailable working folder and confirm the agent remains restorable. Confirm a folder that is truly gone is archived with a visible note.
7. Keep the window open while the Team page is visible and confirm live status remains current. Review the floor log for snapshot and main-thread lag entries.
