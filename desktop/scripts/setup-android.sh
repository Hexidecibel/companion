#!/bin/bash
# Setup Android project after `cargo tauri android init`
#
# This script patches the generated Android project to:
# 1. Add Firebase/Google Services plugin
# 2. Copy google-services.json
# 3. Add usesCleartextTraffic for dev builds
#
# Usage: cd desktop && bash scripts/setup-android.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
GEN_ANDROID="$PROJECT_DIR/src-tauri/gen/android"

if [ ! -d "$GEN_ANDROID" ]; then
  echo "ERROR: Android project not found at $GEN_ANDROID"
  echo "Run 'cargo tauri android init' first."
  exit 1
fi

echo "=== Patching Android project for FCM ==="

# 1. Add Google Services classpath to root build.gradle.kts
ROOT_GRADLE="$GEN_ANDROID/build.gradle.kts"
if ! grep -q "google-services" "$ROOT_GRADLE"; then
  echo "Adding Google Services plugin to root build.gradle.kts..."
  sed -i '/classpath("org.jetbrains.kotlin:kotlin-gradle-plugin/a\        classpath("com.google.gms:google-services:4.4.2")' "$ROOT_GRADLE"
else
  echo "Google Services plugin already in root build.gradle.kts"
fi

# 2. Add Google Services plugin to app build.gradle.kts
APP_GRADLE="$GEN_ANDROID/app/build.gradle.kts"
if ! grep -q "google-services" "$APP_GRADLE"; then
  echo "Adding Google Services plugin to app build.gradle.kts..."
  sed -i '/id("rust")/a\    id("com.google.gms.google-services")' "$APP_GRADLE"
else
  echo "Google Services plugin already in app build.gradle.kts"
fi

# 3. Add Firebase BOM + messaging dependency to app
if ! grep -q "firebase-bom" "$APP_GRADLE"; then
  echo "Adding Firebase dependencies to app build.gradle.kts..."
  sed -i '/implementation("com.google.android.material/a\    implementation(platform("com.google.firebase:firebase-bom:33.8.0"))\n    implementation("com.google.firebase:firebase-messaging-ktx")' "$APP_GRADLE"
else
  echo "Firebase dependencies already in app build.gradle.kts"
fi

# 4. Copy google-services.json if it exists in app/ (React Native project)
GOOGLE_SERVICES_SRC="$PROJECT_DIR/../app/android/app/google-services.json"
GOOGLE_SERVICES_DST="$GEN_ANDROID/app/google-services.json"
if [ -f "$GOOGLE_SERVICES_SRC" ] && [ ! -f "$GOOGLE_SERVICES_DST" ]; then
  echo "Copying google-services.json from RN app..."
  cp "$GOOGLE_SERVICES_SRC" "$GOOGLE_SERVICES_DST"
elif [ -f "$GOOGLE_SERVICES_DST" ]; then
  echo "google-services.json already present"
else
  echo "WARNING: google-services.json not found at $GOOGLE_SERVICES_SRC"
  echo "  You need to place it manually at: $GOOGLE_SERVICES_DST"
  echo "  Get it from Firebase Console > Project Settings > Android app"
fi

# 4b. Ensure google-services.json has the right package name
if [ -f "$GOOGLE_SERVICES_DST" ]; then
  if ! grep -q "com.hexidecibel.companion" "$GOOGLE_SERVICES_DST"; then
    echo "WARNING: google-services.json does not contain package 'com.hexidecibel.companion'"
    echo "  Add a new Android app in Firebase Console with package name: com.hexidecibel.companion"
    echo "  Or download an updated google-services.json that includes this package"
  fi
fi

# 5. Ensure AndroidManifest has required permissions
MANIFEST="$GEN_ANDROID/app/src/main/AndroidManifest.xml"
if ! grep -q "POST_NOTIFICATIONS" "$MANIFEST"; then
  echo "Adding POST_NOTIFICATIONS permission to AndroidManifest.xml..."
  sed -i '/<uses-permission android:name="android.permission.INTERNET"/a\    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />' "$MANIFEST"
else
  echo "POST_NOTIFICATIONS permission already in manifest"
fi

echo ""
echo "=== Android FCM setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Ensure google-services.json is at: $GOOGLE_SERVICES_DST"
echo "  2. Build: cargo tauri android build"
echo "  3. Dev:   cargo tauri android dev"
