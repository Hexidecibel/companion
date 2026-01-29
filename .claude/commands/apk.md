# Build Android APK Locally

Build the Claude Companion Android APK without EAS and install it to the connected device.

## Steps

1. Clean and regenerate android folder:
```bash
cd /Users/chriscushman/local/src/claude-companion/app && rm -rf android && npx expo prebuild --platform android
```

2. Build the release APK:
```bash
cd /Users/chriscushman/local/src/claude-companion/app/android && ./gradlew assembleRelease
```

3. The APK will be at:
```
/Users/chriscushman/local/src/claude-companion/app/android/app/build/outputs/apk/release/app-release.apk
```

4. Install to connected device via ADB:
```bash
adb install -r /Users/chriscushman/local/src/claude-companion/app/android/app/build/outputs/apk/release/app-release.apk
```

Run all commands and report the APK location when done. If the build fails, show the error. If ADB install fails (no device connected), report the APK path so the user can install manually.
