#!/usr/bin/env bash
# Build the unsigned Paramount DMG.
#
# Needs the Paramount UI built first (cd ../../paramount && npm run build): its
# dist/ is bundled via electron-builder extraResources. Extra args go straight to
# electron-builder, e.g. `scripts/build-dmg.sh --arm64` or `--universal`.
# Output: dist/Paramount-<version>-mac-<arch>.dmg
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI_DIST="$ROOT/../../paramount/dist"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-dmg: macOS only" >&2
  exit 1
fi
if [[ ! -f "$UI_DIST/index.html" ]]; then
  echo "build-dmg: no Paramount UI build at $UI_DIST/index.html" >&2
  echo "           run 'npm run build' in 00-new/apps/paramount first" >&2
  exit 1
fi

cd "$ROOT"
# Never look for a signing identity, even if one is in the keychain.
export CSC_IDENTITY_AUTO_DISCOVERY=false
npm run dist:mac -- "$@"

ls -1 "$ROOT"/dist/Paramount-*.dmg
