#!/usr/bin/env bash
# Build "Sherit Mail" for Windows from this Mac: a cross-compiled x64 build in an NSIS installer, signed for
# the app's own updater with ~/.config/mailhub/windows-updater.key (never in git).
#  ./build.sh -> build/SheritMail_<v>_x64-setup.exe (+.sig) and build/latest.json
#  ./build.sh --publish -> also uploads them to the hub's R2 (dl/windows/), where /dl/windows/* serves them and every
#  installed copy picks the new version up within six hours. Bump `version` in src-tauri/Cargo.toml
#  first: the updater only installs a higher version.
# Needs: brew install nsis llvm; rustup target add x86_64-pc-windows-msvc; cargo install cargo-xwin; cargo install tauri-cli.
set -euo pipefail
cd "$(dirname "$0")"
KEYDIR="$HOME/.config/mailhub"
HUB="https://mail.yourdomain.example"
TARGET=x86_64-pc-windows-msvc
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEYDIR/windows-updater.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$KEYDIR/windows-updater.password")"

V=$(sed -n 's/^version = "\(.*\)"$/\1/p' src-tauri/Cargo.toml | head -1)
(cd src-tauri && cargo test --quiet && cargo tauri build --runner cargo-xwin --target "$TARGET" --ci)

OUT="src-tauri/target/$TARGET/release/bundle/nsis"
SRC="$OUT/Sherit Mail_${V}_x64-setup.exe"
NAME="SheritMail_${V}_x64-setup.exe"
rm -rf build && mkdir -p build
cp "$SRC" "build/$NAME"
cp "$SRC.sig" "build/$NAME.sig"
cp "$SRC" build/SheritMail-setup.exe
python3 - "$V" "$NAME" "$HUB" <<'PY'
import json, sys, datetime
v, name, hub = sys.argv[1:]
sig = open(f"build/{name}.sig").read().strip()
url = f"{hub}/dl/windows/{name}"
json.dump({"version": v, "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "platforms": {"windows-x86_64": {"signature": sig, "url": url}, "windows-x86_64-nsis": {"signature": sig, "url": url}}},
          open("build/latest.json", "w"), indent=2)
PY
ls -la build
echo "built Sherit Mail $V for Windows"

if [ "${1:-}" = "--publish" ]; then
  # The installer and its signature first, the manifest last: no installed copy ever reads a latest.json whose file is missing.
  put() { (cd ../hub && npx wrangler r2 object put "mailhub-store/dl/windows/$1" --file "../windows/build/$1" --content-type "$2" --remote); }
  put "$NAME" application/vnd.microsoft.portable-executable
  put "$NAME.sig" text/plain
  put SheritMail-setup.exe application/vnd.microsoft.portable-executable
  put latest.json application/json
  curl -fsS "$HUB/dl/windows/latest.json" | python3 -c "import json,sys; d=json.load(sys.stdin); print('live:', d['version'], d['platforms']['windows-x86_64']['url'])"
  curl -fsSI "$HUB/dl/windows/$NAME" | grep -i -E "^(HTTP|content-length)"
  echo "published: $HUB/dl/windows/SheritMail-setup.exe"
fi
