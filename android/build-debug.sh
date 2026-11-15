#!/bin/bash
set -eo pipefail

if [ -z "$JAVA_HOME" ]; then export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64; fi
if [ -z "$ANDROID_HOME" ]; then export ANDROID_HOME=$HOME/android-sdk; fi
export PATH="$JAVA_HOME/bin:$PATH"

PLATFORM=$ANDROID_HOME/platforms/android-34/android.jar
BUILD_TOOLS=$ANDROID_HOME/build-tools/34.0.0

PROJECT="$(cd "$(dirname "$0")" && pwd)"
SRC=$PROJECT/app/src/main
MANIFEST=$PROJECT/debug/AndroidManifest.xml
OUT=$PROJECT/build-debug
PKG_PATH=dev/linjian/peek
OUTPUT=$PROJECT/Zhangxinchuang-debug-v0.3.14.2.apk
DEBUG_KS=$OUT/debug.keystore

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/apk" "$OUT/compiled_res"

if [ ! -f "$PLATFORM" ]; then
  echo "Android platform not found: $PLATFORM"
  exit 1
fi

echo "=== Creating ephemeral debug signing key ==="
keytool -genkeypair -noprompt   -alias androiddebugkey   -keyalg RSA -keysize 2048 -validity 10000   -storetype PKCS12   -keystore "$DEBUG_KS"   -storepass android -keypass android   -dname "CN=Android Debug,O=Temporary CI Build"

echo "=== Compiling debug resources ==="
"$BUILD_TOOLS/aapt2" compile --dir "$SRC/res" -o "$OUT/compiled_res/"

echo "=== Linking debug resources ==="
"$BUILD_TOOLS/aapt2" link   -o "$OUT/apk/app.unsigned.apk"   -I "$PLATFORM"   --manifest "$MANIFEST"   --custom-package dev.linjian.peek   --java "$OUT/gen"   --auto-add-overlay   -R "$OUT/compiled_res"/*.flat

echo "=== Compiling Java ==="
find "$SRC/java" -name "*.java" > "$OUT/sources.txt"
echo "$OUT/gen/$PKG_PATH/R.java" >> "$OUT/sources.txt"
javac -encoding UTF-8 -source 11 -target 11 -classpath "$PLATFORM" -d "$OUT/classes" @"$OUT/sources.txt"

echo "=== Creating DEX ==="
"$BUILD_TOOLS/d8" --output "$OUT/apk/" --lib "$PLATFORM" $(find "$OUT/classes" -name "*.class")

echo "=== Building debug APK ==="
cd "$OUT/apk"
cp app.unsigned.apk app.tmp.apk
zip -d app.tmp.apk classes.dex 2>/dev/null || true
zip -j app.tmp.apk classes.dex
mv app.tmp.apk app.unsigned.apk

echo "=== Aligning ==="
"$BUILD_TOOLS/zipalign" -f 4 app.unsigned.apk app.aligned.apk

echo "=== Signing debug APK ==="
"$BUILD_TOOLS/apksigner" sign   --ks "$DEBUG_KS"   --ks-type PKCS12   --ks-pass pass:android   --key-pass pass:android   --ks-key-alias androiddebugkey   --out "$OUTPUT"   app.aligned.apk

echo "=== Verifying debug signature ==="
"$BUILD_TOOLS/apksigner" verify --verbose --print-certs "$OUTPUT"

echo "APK: $OUTPUT"
ls -lh "$OUTPUT"
