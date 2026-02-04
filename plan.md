# Implementation Plan

Completed items have been moved to FEATURES.md.

---

## 13. Web/Mobile Parity
**Status:** partially done

Remaining gaps between web and mobile clients.

### Remaining Items

| Feature | Web | Mobile |
|---------|-----|--------|
| Search in conversation | SearchBar | Missing |
| Plan viewer | PlanCard + header button | Missing |

### Implementation

**Mobile Search:**
- `app/src/components/SearchBar.tsx` (new) — Port web SearchBar to React Native
- Match highlighting in `ConversationItem` (already has `HighlightedText` equivalent)
- Prev/next navigation controls
- Header integration in mobile `SessionView`

**Mobile Plan Viewer:**
- Detect plan file references in conversation highlights
- Add "Plan" button to mobile session header
- Open plan file in FileViewer (already supports markdown rendering)

---

## 18. macOS Desktop — Nice to Have
**Status:** planned

Polish features that improve the desktop experience but aren't blockers for release. Can be implemented incrementally post-launch.

### 18a. Global Hotkey

Toggle window visibility from anywhere with Ctrl+Shift+C.

- `tauri-plugin-global-shortcut`
- Register shortcut in main.rs setup
- Make shortcut configurable via web settings panel
- Capability: `"global-shortcut:default"`

### 18b. Deep Links

`companion://server/session-id` URLs open specific sessions from terminal or other apps.

- `tauri-plugin-deep-link`
- Register URL scheme in tauri.conf.json
- Handle deep link in Rust, emit event to frontend, navigate to session
- Capability: `"deep-link:default"`

### 18c. Build Pipeline

- GitHub Actions workflow for Tauri builds
- Matrix: macOS ARM64 + x86_64
- Universal binary via `lipo` or Tauri's target config
- Artifact: .dmg file attached to release

### 18d. Code Signing & Notarization

- Apple Developer certificate
- `tauri.conf.json` signing config
- Notarization via `xcrun notarytool`
- Required for distribution: unsigned .dmg shows Gatekeeper warning

### 18e. Auto-Update

- `tauri-plugin-updater`
- Host update manifest JSON on GitHub Releases
- Check for updates on launch + periodic check
- In-app notification: "Update available — restart to install"

### Files to Modify

| File | Change |
|------|--------|
| `desktop/src-tauri/Cargo.toml` | Add global-shortcut, deep-link, updater plugins |
| `desktop/src-tauri/src/main.rs` | Global hotkey, deep link handler, updater check |
| `desktop/src-tauri/tauri.conf.json` | URL scheme, signing config, updater endpoint |
| `desktop/src-tauri/capabilities/default.json` | Add permissions for new plugins |
| `.github/workflows/desktop-build.yml` (new) | CI for Tauri builds |
| `web/src/components/SettingsScreen.tsx` | Global hotkey config, update check button |

---

## Deferred

### 10. OpenAI Codex CLI Parser
**Status:** deferred (roadmap)

Discover Codex conversation files, parse format, translate to internal types. Not prioritized — focusing on Claude Code integration first.
