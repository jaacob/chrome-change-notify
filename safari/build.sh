#!/bin/bash
# Build the Safari wrapper app. Syncs shared extension sources first, then
# builds into safari/build and opens the app so it registers the extension
# with Safari. Signed with the local Apple Development certificate so Safari
# does not require "Allow Unsigned Extensions".
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/sync-resources.sh"
xcodebuild -project "$DIR/DOM Change Monitor/DOM Change Monitor.xcodeproj" \
  -scheme "DOM Change Monitor" -configuration Release \
  -derivedDataPath "$DIR/build" \
  -allowProvisioningUpdates \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=JB5Z4TC2Y3 build
APP="$DIR/build/Build/Products/Release/DOM Change Monitor.app"
echo "Built: $APP"
open "$APP"
