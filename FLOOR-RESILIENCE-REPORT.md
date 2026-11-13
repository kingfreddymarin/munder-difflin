# Floor resilience correction report

Target: `NSC-219/222/212`, correction cycle 2 for rejected candidate `427ac402`. The supplied pre-fix reproduction exited 0 and confirmed each finding before changes. Post-fix coverage exercises the real `config:changeHome` handler, injected volume states, and persisted-state file operations.

## Corrected findings

1. **Move only rebases paths under copied metadata.** The handler passes the copied `hive`, `palace`, and `roster-backups` roots to `remapMovedCwds`. Project paths elsewhere under the old home and external paths stay unchanged. The handler fixture covers registry, runtime record, and roster records, including both retained and rebased paths.
2. **Unavailable volumes are not treated as deleted working folders.** On macOS, `directoryStateForPath` checks that a volume root is mounted on a device distinct from `/Volumes`. A missing volume root and a leftover mountpoint directory return `unavailable`; a deleted cwd beneath an available volume returns `missing` and is archived by restore. Tests inject these filesystem states and make no `/Volumes` writes.
3. **Floor database replacement keeps a coherent file set and recovers failures.** Closed database members are staged before destination changes. Old database members are moved aside, and stale destination WAL/shared-memory sidecars are removed when absent from source. If staging or replacement fails, the old destination set is restored. Byte fixtures verify file-state handling only; they make no SQLite corruption claim.

The reset-to-picker behavior, lock checks, old-floor recovery path, and unrelated directory safeguards remain covered by the existing targeted tests. No actual GUI or floor process was launched.

## Verification

Using the installed checkout dependencies after confirming its `package.json` matches this worktree:

- Before fix: `node ../../hive/agents/god/repros/paramount-lifecycle/floor-resilience-review.cjs` from the installed product checkout exited 0 with all three `REPRO` findings.
- After fix: `node --test test/paramount-runtime.test.cjs test/floor-lock-services.test.cjs test/floors.test.cjs` — 56 passed, 0 failed.
- `tsc --noEmit -p tsconfig.node.json` — passed.
- `electron-vite build` — passed.

The first TypeScript invocation could not resolve dependencies from the worktree; linking its ignored `node_modules` path to the manifest-matched installed checkout resolved that environment issue. The build emitted the existing Vite warning that `store.ts` is both dynamically and statically imported.

## Correction cycle 3 — rollback backup retention

### Finding addressed

Cycle 2's failed replacement followed by failed restore deleted the only old destination database copy in unconditional staging cleanup. The fix is confined to `copyFloorPersistedState` and its `config:changeHome` error reporting. It preserves the prior copied-root, unavailable-volume, reset, and safe-restore changes.

### Changes

- Snapshot the expected persisted file names and SHA-256 digests before replacement. Digests are computed in fixed-size chunks to avoid loading large databases into memory.
- After install, verify the destination's database/WAL/SHM set and bytes before staging cleanup. After rollback, verify the exact old destination set and bytes before deleting backup files.
- If rollback cannot be verified, skip staging cleanup and throw `FloorPersistedStateCopyError` with recovery state and retained backup path. If cleanup fails after a verified restore or verified install, the error says which state was achieved and includes a still-present backup path when one exists.
- `config:changeHome` now surfaces this structured recovery message directly rather than prefixing a successful install/cleanup failure as “Could not copy data.”

### Evidence

- Before: replayed the supplied production-helper reproduction against `9baeaa5a`; it exited 0 in reproduction mode with `targetExists: false` and `retainedOldCopies: []`.
- After: added runtime tests against the real loaded helper using disposable files and injected operations. Replacement plus restore failure retains and reads the old database/WAL bytes from the reported backup path. Cleanup failure reports `new-target-installed` while confirming the new target bytes and retained old backup. Existing replacement rollback coverage verifies the restored destination set and bytes.
- `node --test test/paramount-runtime.test.cjs test/floor-lock-services.test.cjs test/floors.test.cjs` — exit 0, **58/58 passed**.
- `npm run typecheck:node` — exit 0.
- `git diff --check` — exit 0.

### Fixture limitation and remaining limits

The supplied `floor-backup-loss.cjs --accept` attempt exits 1 because that script extracts only the function body into a virtual machine and does not supply the new module-scope chunked fingerprint helper (nor its crypto dependency). The default mode reproduced the pre-fix bug. The post-fix acceptance is covered by the checked-in full-module runtime regression instead; the shared reproduction file was not modified. No real floor, database, GUI, or remote operation was used. File-level byte checks do not claim SQLite integrity beyond the tested persisted-file set.
