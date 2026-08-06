#!/bin/bash
# Sync the shared extension source into the Safari wrapper's resources folder.
# Run before building the Xcode project (build.sh does this automatically).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
rsync -a --delete \
  "$ROOT/manifest.json" \
  "$ROOT/background.js" \
  "$ROOT/content.js" \
  "$ROOT/content.css" \
  "$ROOT/manage.html" \
  "$ROOT/manage.js" \
  "$ROOT/popup.html" \
  "$ROOT/popup.js" \
  "$ROOT/icons" \
  "$ROOT/safari/ExtensionResources/"
echo "Synced extension resources."
