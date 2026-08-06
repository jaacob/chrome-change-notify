#!/bin/bash
# Build the Safari wrapper app. Syncs shared extension sources first, then
# builds ad-hoc-signed into safari/build and opens the app so it registers
# the extension with Safari.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/sync-resources.sh"
xcodebuild -project "$DIR/DOM Change Monitor/DOM Change Monitor.xcodeproj" \
  -scheme "DOM Change Monitor" -configuration Release \
  -derivedDataPath "$DIR/build" \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=YES CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="" build
APP="$DIR/build/Build/Products/Release/DOM Change Monitor.app"
echo "Built: $APP"
open "$APP"
