#!/usr/bin/env bash
# Build a Java-only APK with SDK command-line tools. No downloads or installs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/native/android"
OUT="$ROOT/tmp/android-build"
VERSION="0.1.0-preview.12"
ANDROID_JAR="${ANDROID_JAR:-${ANDROID_HOME:-$HOME/android-build-test/sdk}/platforms/android-36/android.jar}"
KEYSTORE="${ANDROID_DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"
for tool in aapt2 javac java d8 apksigner python3; do
    command -v "$tool" >/dev/null || { printf 'Missing tool: %s\n' "$tool" >&2; exit 1; }
done
[[ -f "$ANDROID_JAR" ]] || { printf 'Set ANDROID_JAR to your API 36 android.jar\n' >&2; exit 1; }
[[ -f "$KEYSTORE" ]] || { printf 'Set ANDROID_DEBUG_KEYSTORE to an Android debug keystore\n' >&2; exit 1; }
mkdir -p "$OUT"
WORK="$(mktemp -d "$OUT/work-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/classes" "$WORK/dex" "$WORK/core" "$WORK/gen"
javac -d "$WORK/core" "$APP/src/dev/picomputeruse/Auth.java" "$APP/src/dev/picomputeruse/SnapshotStore.java" "$APP/src/dev/picomputeruse/TouchGeometry.java" "$APP/tests/CoreTest.java" "$APP/tests/TouchGeometryTest.java"
java -cp "$WORK/core" dev.picomputeruse.CoreTest
java -cp "$WORK/core" dev.picomputeruse.TouchGeometryTest
aapt2 compile --dir "$APP/res" -o "$WORK/resources.zip"
aapt2 link -o "$WORK/base.apk" -I "$ANDROID_JAR" --manifest "$APP/AndroidManifest.xml" \
    --java "$WORK/gen" --min-sdk-version 34 --target-sdk-version 36 \
    --version-code 12 --version-name "$VERSION" "$WORK/resources.zip"
find "$APP/src" "$WORK/gen" -name '*.java' -print > "$WORK/sources.txt"
# android.jar omits LambdaMetafactory. Use the Java 8 compile API; D8 desugars lambdas.
javac --release 8 -Xlint:-options -classpath "$ANDROID_JAR" -d "$WORK/classes" @"$WORK/sources.txt"
find "$WORK/classes" -name '*.class' -print > "$WORK/classes.txt"
d8 --lib "$ANDROID_JAR" --min-api 34 --output "$WORK/dex" @"$WORK/classes.txt"
python3 "$APP/pack-apk.py" "$WORK/base.apk" "$WORK/dex" "$WORK/unsigned.apk"
APK="$OUT/PiComputerUse-$VERSION.apk"
apksigner sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
    --ks-key-alias androiddebugkey --out "$APK" "$WORK/unsigned.apk"
apksigner verify --verbose "$APK"
if [[ -n "${PREFIX:-}" && -d "$HOME/storage/shared" ]]; then
    mkdir -p "$HOME/storage/shared/APK-BUILD"
    cp "$APK" "$HOME/storage/shared/APK-BUILD/PiComputerUse-$VERSION.apk"
fi
printf 'APK: %s\n' "$APK"
sha256sum "$APK"
