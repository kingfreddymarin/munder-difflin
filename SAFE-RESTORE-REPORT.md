# Safe restore report

Source: `6e54ec753ac069566af508353c31e115bec6476e`.

## Timing evidence

The previous implementation restored agents sequentially. For the deterministic synthetic fixture of nine workers, each gated for 5 ms per callback, that path requires 45 ms of callback wait time (9 × 5 ms), excluding setup and scheduler overhead. The new implementation uses at most four workers, so the same fixture's callback wait lower bound is 15 ms (ceil(9 / 4) × 5 ms). The test measures maximum simultaneous callbacks as exactly four and verifies order, but does not assert elapsed wall time because timer scheduling is nondeterministic. No measured application timing is available; this source-only change does not establish that floor-entry beach ball behavior is fixed.

## Changes

- Restores recorded workers with a concurrency limit of four.
- Captures results by original record index, preserving deterministic order in each result list.
- Shares one in-flight restore promise by floor root so overlapping calls do not launch duplicate workers.
- Per-agent spawn failures remain isolated; missing versus unavailable directory handling, worker roles, archived identity, and retained failed context remain in the existing paths.

## Verification

- `node --test test/paramount-runtime.test.cjs`: 21 passed, 0 failed.
- `npm run typecheck:node`: passed.
- `git diff --check`: passed.

The initial focused test run exposed an existing source-shape assertion for the skipped result push; it was updated to assert the indexed result assignment used for stable ordering, then the complete focused suite passed.

## Limitations

Only synthetic callbacks and temporary fixture roots were used. There was no GUI, floor, provider account, or app run. The previous-attempt review and patch files were not present in the checkout/search locations, so historical measured timings could not be recovered; the old timing above is calculated from the fixture's explicit per-callback delay.
