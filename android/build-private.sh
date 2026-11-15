#!/bin/bash
set -eo pipefail

if [ -z "$JAVA_HOME" ]; then export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64; fi
if [ -z "$ANDROID_HOME" ]; then export ANDROID_HOME=$HOME/android-sdk; fi
export PATH="$JAVA_HOME/bin:$PATH"
PLATFORM=$ANDROID_HOME/platforms/android-34/android.jar
BUILD_TOOLS=$ANDROID_HOME/build-tools/34.0.0

PROJECT="$(cd "$(dirname "$0")" && pwd)"
SRC=$PROJECT/app/src/main
MANIFEST=$PROJECT/private/AndroidManifest.xml
OUT=$PROJECT/build-private
PKG_PATH=dev/linjian/peek
OUTPUT=$PROJECT/Zhangxinchuang-private-v0.3.14.1-private2.apk
EXPECTED_CERT_FILE=$PROJECT/private/EXPECTED_CERT_SHA256.txt

if [ -z "$PRIVATE_KS" ]; then echo "Set PRIVATE_KS to the private PKCS12 keystore path"; exit 1; fi
if [ -z "$PRIVATE_KS_PASSWORD" ]; then echo "Set PRIVATE_KS_PASSWORD in the environment"; exit 1; fi
if [ -z "$PRIVATE_KS_ALIAS" ]; then PRIVATE_KS_ALIAS=linjian-yanyu-private; fi

if [ ! -f "$PLATFORM" ]; then
  echo "Android platform not found: $PLATFORM"
  exit 1
fi
if [ ! -f "$PRIVATE_KS" ]; then
  echo "Private release keystore not found."
  exit 1
fi

PROJECT_REAL=$(realpath "$PROJECT")
KEY_REAL=$(realpath "$PRIVATE_KS")
case "$KEY_REAL" in
  "$PROJECT_REAL"/*)
    echo "Refusing to sign: private keystore must live outside the repository."
    exit 1
    ;;
esac

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/apk" "$OUT/compiled_res"

echo "=== Compiling private resources ==="
"$BUILD_TOOLS/aapt2" compile --dir "$SRC/res" -o "$OUT/compiled_res/"

echo "=== Linking private resources ==="
"$BUILD_TOOLS/aapt2" link     -o "$OUT/apk/app.unsigned.apk"     -I "$PLATFORM"     --manifest "$MANIFEST"     --custom-package dev.linjian.peek     --java "$OUT/gen"     --auto-add-overlay     -R "$OUT/compiled_res"/*.flat

echo "=== Compiling Java ==="
find "$SRC/java" -name "*.java" > "$OUT/sources.txt"
echo "$OUT/gen/$PKG_PATH/R.java" >> "$OUT/sources.txt"
javac -encoding UTF-8 -source 11 -target 11 -classpath "$PLATFORM" -d "$OUT/classes" @"$OUT/sources.txt"

echo "=== Creating DEX ==="
"$BUILD_TOOLS/d8" --output "$OUT/apk/" --lib "$PLATFORM" $(find "$OUT/classes" -name "*.class")

echo "=== Building private APK ==="
cd "$OUT/apk"
cp app.unsigned.apk app.tmp.apk
zip -d app.tmp.apk classes.dex 2>/dev/null || true
zip -j app.tmp.apk classes.dex
mv app.tmp.apk app.unsigned.apk

echo "=== Aligning ==="
"$BUILD_TOOLS/zipalign" -f 4 app.unsigned.apk app.aligned.apk

echo "=== Signing private APK ==="
"$BUILD_TOOLS/apksigner" sign     --ks "$PRIVATE_KS"     --ks-type PKCS12     --ks-pass env:PRIVATE_KS_PASSWORD     --key-pass env:PRIVATE_KS_PASSWORD     --ks-key-alias "$PRIVATE_KS_ALIAS"     --out "$OUTPUT"     app.aligned.apk

echo "=== Verifying private signature ==="
VERIFY_OUTPUT=$("$BUILD_TOOLS/apksigner" verify --verbose --print-certs "$OUTPUT")
echo "$VERIFY_OUTPUT"
if [ -f "$EXPECTED_CERT_FILE" ]; then
  EXPECTED_CERT=$(tr -d '[:space:]' < "$EXPECTED_CERT_FILE" | tr '[:upper:]' '[:lower:]')
  echo "$VERIFY_OUTPUT" | tr '[:upper:]' '[:lower:]' | grep -q "$EXPECTED_CERT"
fi

echo ""
echo "=== Done ==="
echo "APK: $OUTPUT"
ls -lh "$OUTPUT"
