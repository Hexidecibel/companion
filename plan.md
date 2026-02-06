# Implementation Plan

Completed items have been moved to FEATURES.md.

---

## 13. Web/Mobile Parity
**Status:** done

Two remaining gaps between web and mobile clients: conversation search and plan viewer.

### 13a. Mobile Search
**Status:** done

Port the web client's SearchBar and match highlighting to React Native.

#### Requirements
- Search icon button in session header toggles a search bar below the header
- Text input with 150ms debounce, case-insensitive substring matching on highlight content
- Match count display: "3/12"
- Prev/next navigation (▲/▼ buttons), Enter = next, wrap-around at ends
- Yellow background highlighting on matching text within messages
- Current match gets distinct styling (outline or brighter highlight)
- Auto-scroll to current match
- Escape or X button closes search bar and clears highlights

#### Implementation Steps
1. Create `app/src/components/SearchBar.tsx` — TextInput with match count, prev/next buttons, close button
2. Add search state to `SessionView.tsx` — `showSearch`, `searchTerm`, `currentMatchIndex`, `searchMatches` memo
3. Add search icon button to session header (Ionicons `search-outline`, between refresh and auto-approve)
4. Extend `ConversationItem` props with `searchTerm?: string | null` and `isCurrentMatch?: boolean`
5. Add `HighlightedText` helper inside `ConversationItem` — splits text by search term, wraps matches in yellow `<Text>`
6. When `searchTerm` is set, render content as plain highlighted text instead of markdown (matching web behavior)
7. Add `isCurrentMatch` outline style to the message container
8. Auto-scroll to current match via `scrollToIndex` or `scrollTo` with item measurement in SessionView's FlatList/ScrollView

#### Files to Modify

| File | Change |
|------|--------|
| `app/src/components/SearchBar.tsx` (new) | Search input bar with nav controls |
| `app/src/screens/SessionView.tsx` | Search state, header button, SearchBar rendering, scroll-to-match |
| `app/src/components/ConversationItem.tsx` | `searchTerm`/`isCurrentMatch` props, HighlightedText rendering |

---

### 13b. Mobile Plan Viewer
**Status:** done

Detect plan file references in conversation and add a Plan button to the session header.

#### Requirements
- Detect plan file paths from `ExitPlanMode`/`EnterPlanMode` tool calls in highlights
- Show "Plan" icon button in session header when a plan file is detected
- Tapping opens the plan file in the existing FileViewer (already supports markdown rendering)
- Render inline PlanCard for `ExitPlanMode` tool calls showing "Plan Ready" with approval status and "View Plan" button

#### Implementation Steps
1. Add `extractPlanFilePath()` utility — port from web's `MessageBubble.tsx` regex logic, check tool call outputs and message content for `.claude/plans/*.md` or `*plan.md` paths
2. Add `latestPlanFile` memo to `SessionView.tsx` — scan highlights backwards for plan file reference
3. Add plan icon button to session header (Ionicons `document-text-outline`), only visible when `latestPlanFile` is set, opens FileViewer
4. In `ConversationItem.tsx`, detect `ExitPlanMode` tool calls and render a styled PlanCard with "Plan Ready" label, approval status, and "View Plan" button

#### Files to Modify

| File | Change |
|------|--------|
| `app/src/screens/SessionView.tsx` | `latestPlanFile` memo, plan header button |
| `app/src/components/ConversationItem.tsx` | `extractPlanFilePath()`, PlanCard rendering for ExitPlanMode |

---

### File Overlap Analysis

13a and 13b both modify `SessionView.tsx` (header buttons, state) and `ConversationItem.tsx` (rendering). Work sequentially — 13a first (search), then 13b (plan viewer).

---

## 19. Unified Tauri Mobile — Replace React Native with Tauri 2.0 Android/iOS
**Status:** in-progress

Consolidate to a single web codebase (`web/`) for all platforms: browser, desktop, Android, and iOS. Merge the existing `desktop/` project into a unified Tauri 2.0 project that targets all five platforms. Keep the existing `app/` (React Native) working in parallel until the Tauri mobile build has full feature parity.

### Overview

**Current state:**
- `web/` — React + Vite web client (also served by Tauri desktop)
- `desktop/` — Tauri 2.0 wrapper, builds from `web/dist`, desktop-only (macOS/Linux/Windows)
- `app/` — React Native + Expo mobile app (Android/iOS), separate codebase

**Target state:**
- `web/` — Single React + Vite codebase for ALL platforms
- `desktop/` — Unified Tauri 2.0 project targeting desktop + Android + iOS (rename to `tauri/` once stable)
- `app/` — Kept as-is until parity achieved, then archived

### Decision Log
- **Mobile-only features (encryption, QR, scaffolding):** Port to web client
- **Push notifications:** Custom Rust Tauri plugin wrapping FCM (Android) / APNs (iOS)
- **Project layout:** Unified Tauri project (extend `desktop/` to target mobile)
- **MVP scope:** Full feature parity with current RN app before switching
- **Safari/WebKit:** Not yet tested — needs investigation early in the process

---

### Phase 1: Safari/WebKit Compatibility & Responsive Web
**Goal:** Make the web client work well in mobile WebViews before touching Tauri

#### 1a. Safari/WebKit Testing & Fixes
- Test full web client in Safari (macOS) and Safari on iOS (via simulator or device)
- Fix any WebKit-specific CSS/JS issues (flexbox quirks, scrolling, input focus, safe-area-inset)
- Add `-webkit-` prefixes where needed
- Test WebSocket connections work correctly in WKWebView context

#### 1b. Responsive Mobile Layout
- Add comprehensive CSS media queries for mobile viewports (<768px, <480px)
- Add `<meta name="viewport">` handling for Tauri mobile context
- Make sidebar collapse to bottom nav or hamburger on small screens
- Ensure touch targets are at least 44x44px
- Add `safe-area-inset-*` CSS for notched devices
- Test landscape and portrait orientations

#### Files to Modify
| File | Change |
|------|--------|
| `web/src/styles/global.css` | Mobile breakpoints, safe-area, touch targets, WebKit fixes |
| `web/src/components/Dashboard.tsx` | Responsive sidebar behavior |
| `web/src/components/SessionView.tsx` | Mobile-friendly session layout |
| `web/src/components/InputBar.tsx` | Touch-optimized input, virtual keyboard handling |
| `web/src/App.tsx` | Platform detection (mobile vs desktop Tauri vs browser) |

---

### Phase 2: Port Mobile-Only Features to Web
**Goal:** Bring all app-only screens/services into the web client

#### 2a. E2E Encryption
- Port `app/src/services/encryption.ts` to web using `tweetnacl` (works in browser)
- Add `tweetnacl` + `tweetnacl-util` to `web/package.json`
- Integrate into `ServerConnection.ts` — encrypt/decrypt messages when server supports it
- No native dependency needed — `crypto.getRandomValues()` available in all targets

#### 2b. QR Scanner
- Use browser `navigator.mediaDevices.getUserMedia()` + a JS QR decode library (e.g. `jsqr` or `qr-scanner`)
- Create `web/src/components/QRScannerModal.tsx`
- Add "Scan QR" button to server add form
- On Tauri mobile: camera access via WebView works natively
- On desktop/browser: optional, works if webcam available

#### 2c. Session History
- Port `app/src/services/history.ts` to use `localStorage` instead of AsyncStorage
- Create `web/src/services/history.ts` — same API surface, localStorage backend
- Create `web/src/components/HistoryPanel.tsx` — list of past sessions with tap-to-view
- Store up to 50 sessions, 100 messages each (matching app behavior)

#### 2d. Usage Analytics
- Create `web/src/components/UsagePanel.tsx`
- Port token usage display from `app/src/screens/UsageScreen.tsx`
- Progress bars for input/output/cache tokens, weekly/session limits
- Fetch usage data from daemon via existing WebSocket protocol

#### 2e. Project Scaffolding
- Create `web/src/components/NewProjectModal.tsx`
- Port multi-step wizard from `app/src/screens/NewProjectScreen.tsx`
- Template selection, Git init, GitHub repo creation options
- Send scaffold command to daemon via WebSocket

#### 2f. Setup/Onboarding Guide
- Create `web/src/components/SetupGuide.tsx`
- Port installation instructions from `app/src/screens/SetupScreen.tsx`
- Copy-to-clipboard for install commands
- Show when no servers configured

#### Files to Create/Modify
| File | Change |
|------|--------|
| `web/src/services/encryption.ts` (new) | NaCl encryption service (port from app) |
| `web/src/services/ServerConnection.ts` | Integrate encryption into WS messages |
| `web/src/components/QRScannerModal.tsx` (new) | Camera-based QR scanning |
| `web/src/services/history.ts` (new) | localStorage session history |
| `web/src/components/HistoryPanel.tsx` (new) | Session history list |
| `web/src/components/UsagePanel.tsx` (new) | Token usage analytics |
| `web/src/components/NewProjectModal.tsx` (new) | Project scaffolding wizard |
| `web/src/components/SetupGuide.tsx` (new) | Daemon setup instructions |
| `web/package.json` | Add `tweetnacl`, QR scanner lib |

---

### Phase 3: Unified Tauri Project — Add Mobile Targets
**Goal:** Extend the existing `desktop/` Tauri project to build for Android and iOS

#### 3a. Tauri Mobile Initialization
- Run `cargo tauri android init` and `cargo tauri ios init` inside `desktop/src-tauri/`
- This generates `gen/android/` and `gen/apple/` directories with native project shells
- Update `tauri.conf.json` with mobile-specific config (bundle identifier, permissions)
- Add Android-specific `AndroidManifest.xml` permissions (INTERNET, CAMERA, POST_NOTIFICATIONS)
- Add iOS-specific `Info.plist` entries (camera usage, notification permissions)

#### 3b. Platform Detection in Web Client
- Enhance `isTauri()` helper to distinguish desktop vs mobile: `isTauriMobile()`, `isTauriDesktop()`
- Tauri 2.0 exposes `navigator.userAgent` clues and `window.__TAURI_INTERNALS__` on mobile too
- Use platform detection to conditionally show/hide desktop-only features (tray, menu bar, autostart)
- Show mobile-specific UI (bottom nav, larger touch targets) on Tauri mobile

#### 3c. Desktop-Only Feature Guards
- System tray, menu bar, window-state plugin — skip on mobile targets
- Autostart — desktop only
- The `main.rs` needs `#[cfg(desktop)]` / `#[cfg(mobile)]` gates for platform-specific plugins
- Mobile gets: notification plugin, camera plugin (for QR), biometric plugin (optional)

#### Files to Modify
| File | Change |
|------|--------|
| `desktop/src-tauri/tauri.conf.json` | Mobile bundle config, permissions |
| `desktop/src-tauri/Cargo.toml` | Add mobile-conditional deps (camera, biometric) |
| `desktop/src-tauri/src/main.rs` | `#[cfg(desktop)]` / `#[cfg(mobile)]` feature gates |
| `desktop/src-tauri/gen/android/` (new, auto-generated) | Android project shell |
| `desktop/src-tauri/gen/apple/` (new, auto-generated) | iOS project shell |
| `web/src/App.tsx` | Platform-aware routing |
| `web/src/components/Dashboard.tsx` | Conditional desktop/mobile UI |

---

### Phase 4: Push Notifications — Custom Tauri FCM Plugin
**Goal:** Remote push notifications on Android (FCM) and iOS (APNs)

#### 4a. Rust Plugin Structure
- Create `desktop/src-tauri/plugins/tauri-plugin-fcm/` (or as a local crate)
- On Android: Use Tauri's Android plugin bridge to call Firebase Messaging Java APIs
  - Register for FCM token
  - Listen for token refresh
  - Handle foreground message receipt
  - Handle background notification tap
- On iOS: Use Tauri's iOS plugin bridge to call `UNUserNotificationCenter` + APNs registration
  - Request notification permission
  - Get device token
  - Forward to daemon as push token

#### 4b. Web Client Integration
- Create `web/src/services/push.ts` — platform-aware push notification service
  - On Tauri mobile: invoke the FCM/APNs plugin
  - On Tauri desktop: use `tauri-plugin-notification` (local only, as today)
  - On browser: use `BrowserNotifications.ts` (as today)
- Register push token with daemon via `register_push` WebSocket message (same protocol as RN app)

#### 4c. Android FCM Setup
- Add `google-services.json` to `gen/android/app/` (same file used by RN app)
- Add Firebase dependencies to `gen/android/app/build.gradle`
- Implement `FcmPlugin.kt` — Kotlin class extending Tauri's `Plugin` base
  - `FirebaseMessaging.getInstance().token` for registration
  - `FirebaseMessagingService` subclass for background messages

#### 4d. iOS APNs Setup
- Enable Push Notifications capability in Xcode project
- Implement Swift plugin for APNs registration
- Upload APNs auth key to Firebase (if using FCM as unified backend) or handle APNs directly

#### Files to Create
| File | Change |
|------|--------|
| `desktop/src-tauri/plugins/tauri-plugin-fcm/` (new) | Rust plugin crate |
| `desktop/src-tauri/plugins/tauri-plugin-fcm/android/` (new) | Kotlin FCM bridge |
| `desktop/src-tauri/plugins/tauri-plugin-fcm/ios/` (new) | Swift APNs bridge |
| `web/src/services/push.ts` (new) | Unified push service |
| `gen/android/app/google-services.json` | Firebase config (copied from app/) |

---

### Phase 5: Build, Test & Validate
**Goal:** Build working APK/IPA and verify full parity with the RN app

#### 5a. Android Build
- `cargo tauri android build` from `desktop/`
- Sign APK with existing keystore (reuse from `app/android/`)
- Install on test device alongside existing RN app
- Compare feature-by-feature against the RN app

#### 5b. iOS Build (if Mac available)
- `cargo tauri ios build`
- Test in simulator and on device
- Validate push notifications with APNs sandbox

#### 5c. Feature Parity Checklist
- [ ] Connect to server (manual entry)
- [ ] Connect via QR scan
- [ ] Multi-server support
- [ ] View live sessions
- [ ] View conversation messages with markdown rendering
- [ ] Send text input
- [ ] Send images
- [ ] Auto-approve toggle
- [ ] Search conversations
- [ ] View plan files
- [ ] Sub-agent tree
- [ ] Task list
- [ ] Terminal panel
- [ ] Work groups
- [ ] Session history
- [ ] Usage analytics
- [ ] New project scaffolding
- [ ] Push notifications (foreground + background)
- [ ] E2E encryption
- [ ] Archive management
- [ ] Notification settings
- [ ] Font scale / accessibility

#### 5d. Performance Testing
- Scroll performance on long conversations (WebView vs RN native)
- WebSocket reconnection behavior
- Memory usage comparison
- Cold start time comparison

---

### Phase 6: Migration & Cleanup
**Goal:** Switch over from RN and clean up

#### 6a. Rename & Reorganize
- Rename `desktop/` to `tauri/` (or keep as `desktop/` if preferred)
- Update all build scripts, CLAUDE.md references, CI/CD
- Update daemon to serve mobile-optimized web build if needed

#### 6b. Archive React Native App
- Move `app/` to `app-legacy/` or a separate branch
- Remove from active development
- Keep for reference until confident in Tauri mobile

#### 6c. Update Documentation
- Update CLAUDE.md with new build commands
- Update todo.md / plan.md
- Document Tauri mobile build process (Android SDK, Xcode requirements)

---

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| WebKit rendering issues in iOS WebView | Medium | Medium | Phase 1 Safari testing early |
| Push notification complexity on iOS | Medium | High | Can defer iOS push, ship Android first |
| Scroll performance on long conversations | Low | Medium | WebView hardware acceleration, virtualized lists |
| Tauri mobile plugin ecosystem immature | Medium | Medium | Write minimal custom plugins, avoid exotic deps |
| App Store review rejects WebView app | Low | Medium | Tauri apps generally pass; add sufficient native integration |
| Build toolchain complexity (Rust + Android SDK + Xcode) | Medium | Low | Document thoroughly, match existing dev environment |

### Build Commands (Target)
```bash
# Dev
cd desktop && cargo tauri dev                    # Desktop
cd desktop && cargo tauri android dev            # Android (device/emulator)
cd desktop && cargo tauri ios dev                # iOS (simulator)

# Production
cd desktop && cargo tauri build                  # Desktop bundles
cd desktop && cargo tauri android build          # APK/AAB
cd desktop && cargo tauri ios build              # IPA
```

---

## Deferred

### 10. OpenAI Codex CLI Parser
**Status:** deferred (roadmap)

Discover Codex conversation files, parse format, translate to internal types. Not prioritized — focusing on Claude Code integration first.

### 18. macOS Desktop — Nice to Have
**Status:** deferred

Global hotkey (Ctrl+Shift+C), deep links (`companion://` URL scheme), CI build pipeline, code signing & notarization, auto-update via `tauri-plugin-updater`. Post-launch polish.
