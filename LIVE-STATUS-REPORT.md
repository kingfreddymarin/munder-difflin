# Live status and Team refresh correction

## Result

Implemented the confirmed NSC-217 and NSC-221 gaps on top of `5b2544b6`. This is ready for independent review; it is not an independent acceptance PASS.

## Changes

- The main Paramount activity snapshot now carries input, output, cache-read, cache-creation token counts, telemetry-reported USD cost, and the live breaker level alongside existing total tokens, context percentage, status and last tool.
- The provider converts raw token counts and per-agent configured caps to the UI's millions unit. It keeps floor token budget separate from per-agent caps and exposes floor token and USD limits in settings data. Negative, non-finite and absent metrics are not treated as valid values; missing token usage renders as `—`, with cost and context left unknown.
- Live breaker levels `constrained` and `stopped` now take precedence over terminal activity when projecting agent status.
- Team mounts the same visible-window `useLiveRefresh` hook as Home. Both use one shared 4-second interval constant. The router renders only the active page; the hook clears its timer/listener when that page unmounts and only requests refresh while visible.
- Team rows and agent summaries show live token/cost data.

## Evidence

- Before: ran the two new provider regression tests against committed `5b2544b6` adapter source. Exit 1; both failed. The test assertions cover configured cap and token detail/cost/breaker projection, plus preserving unknown values.
- After: full UI suite `npm test` — exit 0, **114/114 passed**.
- After: UI `npm run typecheck` — exit 0.
- After: UI `npm run build` — exit 0; Vite emitted its existing warning that some generated chunks exceed 500 kB.
- After: focused `node --test test/paramount-activity.test.cjs` — exit 0, **2/2 passed**.
- After: root `npm run typecheck:node` — exit 0.
- Refresh verifier: removing Team's `useLiveRefresh` call made `ui/tests/team-live-refresh.test.mjs` exit 1; restored implementation passes as part of the UI suite. It checks Team/Home share the same interval hook, hidden-window gating, cleanup, and single active route page.
- `git diff --check` — exit 0.

## Limits

- No desktop GUI, live floor, account, or external operation was used. UI refresh was verified through the shared hook contract and route wiring, not an interactive Electron session.
- USD is the current telemetry sample's cumulative cost; the lifetime/reset-corrected cost ledger is not part of this Paramount snapshot.
- Home and Health's aggregate “tokens today” remains marked not reported because this telemetry sample does not establish a calendar-day total.
