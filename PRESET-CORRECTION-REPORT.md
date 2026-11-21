# Existing-agent preset export correction

## Result

Implemented an export action on the selected existing agent's Overview in the actual Paramount Team UI. Ready for independent review; no review verdict is claimed.

## Changes

- The selected agent can save a `munder-difflin/hire@1` preset from its Overview. It uses the current saved provider/model where available and the selected agent's name, accent and per-agent token cap.
- The builder allowlists only those portable fields. It does not serialize cwd, commands, sessions, transcripts, account/launcher selection, credentials, arbitrary skills or MCP specs.
- The UI calls the real Paramount provider and supported typed `window.cth` preload bridge. Main revalidates the definition, opens a native save dialog, reports cancellation distinctly, and writes JSON with mode `0600`. Dialog and file failures return safe messages without exposing the chosen path or low-level error.
- Added an injectable main-process save helper for picker/write outcomes and a provider bridge method for the real UI.

## Evidence

- Before: the actual Overview wiring regression test against committed `5b2544b6` source exited 1; the existing-agent export action was absent.
- Main + importer tests: `node --test test/paramount-agent-preset.test.cjs test/hire-import.test.cjs` — exit 0, **15/15 passed**. Coverage includes selected-agent definition, importer round-trip through a temporary fixture file, picker cancel with zero writes, picker failure, write failure without path leakage, and invalid-manifest rejection before picker.
- UI suite `npm test` — exit 0, **113/113 passed**, including provider bridge outcome coverage and actual Overview wiring.
- UI `npm run typecheck` — exit 0.
- UI `npm run build` — exit 0; Vite reports generated chunks over 500 kB.
- Root `npm run typecheck:node` — exit 0.
- `git diff --check` — exit 0.

## Limits

- No real file export, app GUI, or account was used. Native dialog/file behavior was exercised through injected picker and filesystem boundaries using a temporary fixture path.
- hire@1 currently does not represent every runtime agent attribute. Export includes only name/provider/model/accent/token cap; it intentionally omits persona, role-specific runtime state and unrecognized skills/MCPs.
