# Build Dev Client APK

Build and install the Claude Companion dev client APK for hot-reloading development.

This only needs to be run when native dependencies change (new native modules, expo upgrade, etc.).
For JS/TS changes, just run `npx expo start --dev-client` and the app hot-reloads.

## Steps

1. Clean and regenerate android folder:
```bash
cd /Users/chriscushman/local/src/claude-companion/app && rm -rf android && npx expo prebuild --platform android
```

2. Build the debug APK (includes dev client):
```bash
cd /Users/chriscushman/local/src/claude-companion/app/android && ./gradlew assembleDebug
```

3. Install to connected device via ADB:
```bash
adb install -r /Users/chriscushman/local/src/claude-companion/app/android/app/build/outputs/apk/debug/app-debug.apk
```

4. Start the dev server:
```bash
cd /Users/chriscushman/local/src/claude-companion/app && npx expo start --dev-client --port 8084
```

Run steps 1-3 and report success. Then start the dev server in step 4. If ADB install fails, report the APK path. If port 8084 is busy, try 8085.
