# Desktop / Mobile (Tauri)

Moved verbatim from `CLAUDE.md` (2026-11-03) to keep the auto-loaded context small.

## Desktop / Mobile (Tauri)

Tauri 2.0 wraps the web client as a native app for desktop (Linux, macOS, Windows) and mobile (Android, iOS).

### Key files
- `desktop/src-tauri/tauri.conf.json` - Tauri configuration
- `desktop/src-tauri/src/lib.rs` - Rust entry point, plugin registration
- `desktop/src-tauri/plugins/tauri-plugin-fcm/` - Custom FCM/APNs plugin
- `desktop/scripts/setup-android.sh` - Android project patches (FCM, cleartext, back nav)
- `desktop/google-services.json` - Firebase config (gitignored, place manually)
- `desktop/debug.keystore` - APK signing key (gitignored)

### Commands
```bash
# Desktop
cd desktop && npm run dev       # Dev with hot reload
cd desktop && npm run build     # Release build (.deb, .dmg, etc.)

# Android
cd desktop && cargo tauri android init          # One-time setup
cd desktop && bash scripts/setup-android.sh     # Patch for FCM
cd desktop && npm run android:build              # Build APK (auto-increments versionCode)

# iOS (requires macOS + Xcode)
cd desktop && cargo tauri ios init              # One-time setup
cd desktop && cargo tauri ios build             # Build for device
cd desktop && cargo tauri ios build --export-method app-store-connect  # TestFlight
```

### Native Herald (voice)
- Desktop: `src-tauri/src/herald.rs` registers the Herald global shortcuts (the web layer sends the
  chords via `herald_set_shortcuts`: talk Ctrl+Alt+Space hold, toggle Ctrl+Alt+Shift+H, brief
  Ctrl+Alt+Shift+B, stop Ctrl+Alt+Shift+S; on macOS Ctrl becomes Cmd: ⌘⌥Space, ⌘⌥⇧H, ⌘⌥⇧B,
  ⌘⌥⇧S, never a Control+Option chord (`MAC_NATIVE_CHORDS` in `useNativeHerald.ts`; untouched
  old defaults migrate once, flag `macChords` in `herald_native_prefs`; a failed registration
  shows "could not be registered" with a one-click alternative, `suggestChord`), adds the tray actions (Brief me, Toggle listening,
  Stop speaking, Herald volume submenu, Mute tones), and grants the mic to the app's own origin
  (WebKitGTK / WebView2). It only emits `herald-native` events `{ action, value? }`.
- Passthrough shortcuts (`src-tauri/src/passthrough/`): per shortcut, "Let other apps see this key
  too" (`passthrough: {talk,toggle,brief,stop}`; default ON for hold-to-talk on Windows/macOS so
  Discord Push to Mute on the same chord still works). Such a chord is NOT registered with the
  exclusive plugin; it is observed by a WH_KEYBOARD_LL hook (Windows, own thread + message loop,
  always CallNextHookEx, callback only posts to a channel) or a listen-only CGEventTap (macOS, needs
  Input Monitoring: `herald_request_input_monitoring`). One worker thread runs the pure
  `ChordWatcher` (exact modifiers, release on main key or a modifier, auto-repeat ignored; unit
  tested without the OS). Linux keeps exclusive (X11 XRecord not wired; Wayland unsupported). A
  failed passthrough falls back to exclusive with `passthroughError`. Windows also reports an
  elevated foreground window (`herald-native-status`): an admin game's keys never reach a
  non-elevated hook (run Companion as admin). Cross-check from Linux with check-only shims
  (`llvm-rc` for msvc, fake `cc`/`ar` for aarch64-apple-darwin) + `cargo clippy --target ...`.
- Mobile: `src-tauri/plugins/tauri-plugin-herald-native/` (Kotlin + Swift): earbud play-pause ->
  plugin event `media` `{ action: 'toggle' }`, `set_media_session`, `set_audio_focus` (ducking).
- Web: `web/src/services/nativeBridge.ts` + `web/src/hooks/useNativeHerald.ts` route all of it to
  the existing push-to-talk / remote-trigger handlers; `nativePlatform()` in `utils/platform.ts`
  gates it. Mic permissions: `setup-android.sh` (RECORD_AUDIO), `setup-ios.sh`
  (NSMicrophoneUsageDescription), `src-tauri/Info.plist` + `Entitlements.plist` (macOS).
- CI: pushing a `native/**` branch runs `release.yml` as an artifact-only build (no TestFlight, no
  release, no tag needed).

### Desktop signing + auto-update
- **Version:** `1.0.<git commit count>` from `desktop/scripts/desktop-version.cjs` (overlay `src-tauri/desktop-version.conf.json`, used by `npm run build`; CI needs `fetch-depth: 0`). No tags.
- **Updater:** `src-tauri/src/updater.rs` (startup + every 6h, background download, tray "Restart to update", install on quit). Feed: `https://dev.cush.rocks/updates/stable/latest.json`, served by the daemon from `~/.companion/updates` (`daemon/src/update-feed.ts`; `COMPANION_UPDATES_DIR` overrides). Linux updates only the AppImage; deb installs and dev builds never self-update.
- **Publish:** `bin/companion publish-update --run <id|latest>` (CI `updater-*` artifacts) or `--from <dir>`; verifies every signature against `plugins.updater.pubkey` first.
- **Keys:** `bin/desktop-signing` (`csr`, `import-devid <.cer>`, `updater-keygen`, `status`). Private material lives in `~/.companion/signing` + GH secrets + `inf://prod/companion/*`. Rotating the updater key strands installed apps.
- **macOS:** with `APPLE_DEVID_CERT_P12_B64`/`APPLE_DEVID_CERT_PASSWORD` set, CI signs with Developer ID (hardened runtime; Tauri signs only), then `desktop/scripts/macos-notarize.sh` notarizes + staples the app (retried submit, polling in rounds that survive network blips and a slow Apple queue, up to 3 h), re-packs + re-signs the updater `.app.tar.gz`, rebuilds the dmg from the stapled app, notarizes + staples the dmg, and logs `codesign`/`spctl`; otherwise ad-hoc.

### Android in-app updates (sideload)
`bin/companion publish-update --apk <signed.apk>` writes `<feed>/stable/android.json` (`versionCode`, `versionName`, `url`, `sha256`, `size`, `certSha256`) + `Companion_<versionName>_android-<versionCode>.apk` (helpers + tests: `daemon/scripts/android-feed.js`, `daemon/__tests__/android-feed.test.ts`); it refuses an older-or-equal versionCode and a different signing certificate. The app (`web/src/hooks/useAndroidUpdater.ts`, `components/AndroidUpdateBanner.tsx`) checks on launch + every 6 h and shows "Update available (1.0.N)"; one tap runs `tauri-plugin-herald-native` `app_update_install` (`ApkUpdater.kt`: download to cache/updates, sha256, PackageManager check of package + versionCode + SAME signing certs (`UpdateChecks.kt`, JVM tests: `./gradlew :tauri-plugin-herald-native:testReleaseUnitTest` in `src-tauri/gen/android`), then the system installer via the app FileProvider; the user always confirms). Without "Install unknown apps" it deep-links to that setting. Manifest bits (REQUEST_INSTALL_PACKAGES, FileProvider `cache/updates`) come from `setup-android.sh`. versionName = `1.0.<commit count>` (`android-version.cjs`), like desktop.

### iOS TestFlight banner
iOS cannot self-update. `bin/companion publish-update --run <id>` also writes `<feed>/stable/ios.json` (`build` = run number = CFBundleVersion, `versionName` = the run's desktop version, `publishedAt`, `testflightUrl`, `runId`) when the run has the `ios-ipa` artifact AND build-ios's "Upload IPA to TestFlight" step concluded `success` (skipped = ios.json untouched; never an older build; helpers + tests `daemon/scripts/ios-feed.js`, `daemon/__tests__/ios-feed.test.ts`). The iOS app (`web/src/hooks/useIosTestflight.ts`, `components/IosTestflightBanner.tsx`) reads its CFBundleVersion and fetches the feed natively (`app_update_info` / `app_update_fetch_feed` in `HeraldNativePlugin.swift`, no WebView CORS), shows "Build N is on TestFlight" + Open TestFlight (`itms-beta://`, allowed in `capabilities/default.json`; `--ios-app-id` / `COMPANION_IOS_APP_ID` for the app's own page), dismissible per build. The feed dir is served generically, so no daemon restart is needed for a new manifest.

### APK Signing
```bash
apksigner sign --ks desktop/debug.keystore --ks-pass pass:android --key-pass pass:android \
  --out /tmp/companion-tauri.apk \
  desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
```
