# Build Android APK (Tauri)

Build the Companion Android APK using Tauri and install it to the connected device.

## Steps

1. Build the web frontend and Tauri Android APK:
```bash
cd desktop && npm run android:build
```

This runs `scripts/android-version.cjs` to generate an auto-incrementing
`versionCode` (base 1000000 + git commit count, written to the untracked
`src-tauri/android-version.conf.json` overlay) and then builds with that overlay
via `--config`. This guarantees each new APK has a higher `versionCode` than the
previously sideloaded build so it installs as an upgrade. The raw command it wraps:
```bash
node scripts/android-version.cjs && cargo tauri android build --target aarch64 --config src-tauri/android-version.conf.json
```

The APK will be at:
```
desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
```

2. Sign the APK with the debug keystore:
```bash
apksigner sign --ks desktop/debug.keystore --ks-pass pass:android --key-pass pass:android --out /tmp/companion-tauri.apk desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
```

3. Install to connected device via ADB:
```bash
adb install -r /tmp/companion-tauri.apk
```

## Prerequisites

If the Android project hasn't been initialized yet:
```bash
cd desktop && cargo tauri android init && bash scripts/setup-android.sh
```

The setup script patches Firebase/FCM, cleartext traffic, and back navigation. Only needed once after `android init`.

## Troubleshooting

- **google-services.json missing**: Place it at `desktop/src-tauri/gen/android/app/google-services.json` (get from Firebase Console)
- **ADB not connected**: Report the signed APK path at `/tmp/companion-tauri.apk` so the user can install manually
- **Build fails on Rust**: Ensure Android NDK is installed and `ANDROID_HOME` / `ANDROID_NDK_HOME` are set
- **Cleartext traffic error**: Run `bash desktop/scripts/setup-android.sh` to re-patch
