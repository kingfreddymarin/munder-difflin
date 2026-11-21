# NSC-229 account correction plan

Base: `6e54ec753ac069566af508353c31e115bec6476e`.

## Scope

1. Account identity: preserve whether each Claude/Codex agent uses provider default, a resolved saved launcher, a stale saved launcher, or an unreadable/unavailable selection. Crashed-chat and profile recovery must only probe/sign in against that exact selection. Stale/missing profile identity must prompt refresh/reselection instead of invoking provider default. Setup's intentional provider-default actions stay explicitly labeled and distinct from named launcher actions.
2. Channel-file updater: move prepare/apply state and filesystem operations behind a small injected service. Keep fixed target path, regular-file/no-symlink checks, one-use expiring plan, hash/syntax checks and backup. Recheck target identity/content immediately before atomic replacement. On post-replacement failure, restore through a temporary file and verify restored bytes, mode and syntax. Return a specific recovery result and a safe home-relative backup location when restoration cannot be verified.

## Files and validation

Likely source: `src/main/paramount-team.ts`, preload and UI account models, `ui/src/components/app/engine-sign-in-actions.tsx`, `ui/src/pages/chats.tsx`, `ui/src/features/team/agent-sheet.tsx`, `src/main/claude-channel-recovery.ts`, `src/main/index.ts`. Add focused core/UI tests and `ACCOUNT-CORRECTION-REPORT.md`.

Run focused launcher/account/team/channel tests, UI tests, Node/web/UI typechecks, and source build. Runtime file tests use temporary directories and injected file operations only. No actual launcher config, account, credential, or GUI interaction.

## Acceptance

- Saved default, valid, stale, and unreadable/missing selections are unambiguous in model state and UI.
- Stale selections never call default-account sign-in/status; users can refresh and explicitly reselect.
- Channel update tests cover valid prepare/apply, path/symlink refusal, expiry, intervening edit, backup/rename/verification/restore failures, and verified restoration status.
- Remaining noncooperating-editor race limits are documented.
