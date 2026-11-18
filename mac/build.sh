#!/usr/bin/env bash
# Build, assemble and sign "Sherit Mail" for macOS../build.sh -> build/Sherit.app
#  ./build.sh --install -> also copies it to /Applications/Sherit.app
# Signed with the Developer ID Application identity in the login keychain (hardened runtime). SIGN_ID overrides it.
set -euo pipefail
cd "$(dirname "$0")"
SIGN_ID="${SIGN_ID:-Developer ID Application}"
APP="build/Sherit.app"

swift build -c release --arch "$(uname -m)"
BIN="$(swift build -c release --arch "$(uname -m)" --show-bin-path)/SheritMail"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/SheritMail"
cp Resources/Info.plist "$APP/Contents/Info.plist"

# The app icon (the Ghost): tools/logo/ghost.py draws every size pixel for pixel in Apple's proportions, made again
# whenever the drawing or the web's icon is newer. Without Pillow it falls back to squeezing the web's 512 px icon with sips.
SRC=../hub/public/icons/icon-512.png; GEN=../tools/logo/ghost.py
if [ ! -f build/AppIcon.icns ] || [ "$SRC" -nt build/AppIcon.icns ] || [ "$GEN" -nt build/AppIcon.icns ]; then
  SET=build/AppIcon.iconset; rm -rf "$SET"; mkdir -p "$SET"
  if ! python3 "$GEN" --mac-iconset "$SET"; then
    echo "ghost.py could not draw the icon set; resizing icon-512.png with sips instead" >&2
    for s in 16 32 128 256 512; do
      sips -z $s $s "$SRC" --out "$SET/icon_${s}x${s}.png" >/dev/null
      d=$((s * 2)); sips -z $d $d "$SRC" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
    done
  fi
  iconutil -c icns "$SET" -o build/AppIcon.icns
fi
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP"
codesign --verify --strict --verbose=2 "$APP"
echo "built $APP"

if [ "${1:-}" = "--install" ]; then
  rm -rf "/Applications/Sherit.app"
  cp -R "$APP" "/Applications/Sherit.app"
  echo "installed /Applications/Sherit.app"
fi
