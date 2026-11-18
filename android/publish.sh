#!/usr/bin/env bash
# Publish the Android app to the hub, where installed copies (1.7+) find it and offer to install it.
#  ./publish.sh -> builds the signed release, writes build/latest.json, uploads both to R2 under dl/android/
# Bump versionCode (and versionName) in app/build.gradle.kts first: the app only offers a higher versionCode.
# The first install of 1.7 still goes over ADB (./install.sh); from then on the app updates itself from here.
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
HUB="https://mail.yourdomain.example"
[ -f app/google-services.json ] || { echo "app/google-services.json is missing: a build without it has no push notifications" >&2; exit 1; }
CODE=$(sed -n 's/^ *versionCode = \([0-9]*\)$/\1/p' app/build.gradle.kts | head -1)
NAME=$(sed -n 's/^ *versionName = "\(.*\)"$/\1/p' app/build.gradle.kts | head -1)
./gradlew -q assembleRelease
APK=app/build/outputs/apk/release/app-release.apk
FILE="SheritMail-$NAME.apk"
rm -rf build/publish && mkdir -p build/publish
cp "$APK" "build/publish/$FILE"
SHA=$(shasum -a 256 "build/publish/$FILE" | awk '{print $1}')
python3 - "$CODE" "$NAME" "$HUB/dl/android/$FILE" "$SHA" > build/publish/latest.json <<'PY'
import json, sys
code, name, url, sha = sys.argv[1:]
print(json.dumps({"versionCode": int(code), "versionName": name, "url": url, "sha256": sha}, indent=2))
PY
# The APK first, the manifest last: no installed copy ever reads a latest.json whose file is missing.
put() { (cd ../hub && npx wrangler r2 object put "mailhub-store/dl/android/$1" --file "../android/build/publish/$1" --content-type "$2" --remote); }
put "$FILE" application/vnd.android.package-archive
put latest.json application/json
curl -fsS "$HUB/dl/android/latest.json"; echo
curl -fsSI "$HUB/dl/android/$FILE" | grep -i -E "^(HTTP|content-length|content-type)"
echo "published Sherit Mail $NAME ($CODE), sha256 $SHA"
