# Build iOS via Tauri

Build the Companion iOS app using Tauri for TestFlight or device testing.

**Requires macOS with Xcode installed.** Cannot build on Linux.

## Usage
```
/ios [target]
```

Target is optional. Options: `device` (default), `simulator`, `testflight`.

## Prerequisites (one-time)

1. Install Rust iOS targets:
```bash
rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim
```

2. Install CocoaPods:
```bash
brew install cocoapods
```

3. Initialize iOS project:
```bash
cd desktop && cargo tauri ios init
```

4. Configure signing in Xcode:
   - Open `desktop/src-tauri/gen/apple/Companion.xcodeproj`
   - Set team and bundle identifier (`com.companion.codeapp`)
   - Enable Push Notifications capability

## Steps

### Device / Development Build
```bash
cd desktop && cargo tauri ios build
```

### TestFlight / App Store Build
```bash
cd desktop && cargo tauri ios build --export-method app-store-connect
```

The IPA will be at:
```
desktop/src-tauri/gen/apple/build/arm64/Companion.ipa
```

### Upload to TestFlight
```bash
xcrun altool --upload-app --type ios \
  --file "desktop/src-tauri/gen/apple/build/arm64/Companion.ipa" \
  --apiKey $APPLE_API_KEY_ID \
  --apiIssuer $APPLE_API_ISSUER
```

Or use the Transporter app from the Mac App Store.

## Troubleshooting

- **Not on macOS**: iOS builds require macOS + Xcode. Use GitHub Actions macOS runner for CI.
- **Signing errors**: Open Xcode project and configure team/provisioning manually.
- **CocoaPods issues**: Run `cd desktop/src-tauri/gen/apple && pod install`
- **Push notifications**: Ensure APNs key is uploaded to Firebase Console, and Push Notifications capability is enabled in Xcode.
