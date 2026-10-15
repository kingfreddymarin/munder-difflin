#!/usr/bin/env bash
# Build the unsigned Paramount DMG.
#
# Needs the Paramount UI built first (cd ui && npm ci && npm run build): its
# dist/ is bundled via electron-builder extraResources. The dir comes from
# scripts/paramount-ui-dist.cjs: ui/dist, or PARAMOUNT_UI_DIST. Extra args go straight to
# electron-builder, e.g. `scripts/build-dmg.sh --arm64` or `--universal`.
# Output: dist/Paramount-<version>-<arch>.dmg
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-dmg: macOS only" >&2
  exit 1
fi
# Fails with the missing index.html path before any build work.
UI_DIST="$(node "$ROOT/scripts/paramount-ui-dist.cjs")"
export PARAMOUNT_UI_DIST="$UI_DIST"

cd "$ROOT"
# Never look for a signing identity, even if one is in the keychain.
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm run dist:mac -- "$@"

ls -1 "$ROOT"/dist/Paramount-*.dmg
