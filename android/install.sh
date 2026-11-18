#!/usr/bin/env bash
# Build the release app and install it on the phone plugged into this Mac (USB debugging on)../install.sh
# ADB installs stay outside Google's developer-verification rules, so this works with no Play Store and no registration.
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
# Firebase's client config, if it has been downloaded and not yet moved in (it is gitignored).
if [ ! -f app/google-services.json ] && [ -f "$HOME/Downloads/google-services.json" ]; then cp "$HOME/Downloads/google-services.json" app/; echo "using ~/Downloads/google-services.json"; fi
[ -f app/google-services.json ] || echo "note: no app/google-services.json — building WITHOUT push notifications"
./gradlew -q assembleRelease
APK=app/build/outputs/apk/release/app-release.apk
ls -la "$APK"
"$ADB" install -r "$APK"
"$ADB" shell am start -n com.sheritlabs.mail/.MainActivity >/dev/null
echo "installed and launched"
