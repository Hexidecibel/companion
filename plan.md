# Implementation Plan

Completed items have been moved to FEATURES.md.

---

## Mobile Bug Fix Sprint

All items below are blockers for a stable mobile release.

---

### 1. Fix viewport overflow (100vh → 100dvh)
**Status:** done
**Priority:** HIGH — affects all screens on smaller iOS devices

#### Problem
Multiple components use `100vh` which on mobile includes the address bar / system UI, causing content to extend off screen. When keyboard opens, `100vh` stays the same while visible area shrinks.

#### Files to Modify
- `web/src/styles/global.css` — Replace `100vh` with `100dvh` globally:
  - `#root { min-height: 100vh }` → `100dvh`
  - `#app { min-height: 100vh }` → `100dvh`
  - `.dashboard { height: 100vh }` → `100dvh`
  - `.skill-browser` mobile media query: `height: 100vh; max-height: 100vh` → `100dvh`
  - `.modal-content { max-height: 80vh }` → `80dvh`
  - `.conversation-search { max-height: 70vh }` → `70dvh`

#### Implementation Steps
1. Global find-and-replace `100vh` → `100dvh` in global.css (except where explicitly needed)
2. Replace other `vh` modal heights with `dvh` equivalents
3. Add `-webkit-overflow-scrolling: touch` to all scrollable containers on mobile
4. Test: skill browser, add server screen, settings — all should fit on small screens

---

### 2. Fix safe area handling for all screens
**Status:** done
**Priority:** HIGH — buttons unreachable at top on iOS

#### Problem
Only MobileDashboard and form-header apply `--safe-top` padding. Other full-screen views (skill browser, modals) don't account for the notch/status bar, making top buttons unreachable.

#### Files to Modify
- `web/src/styles/global.css` — Add safe area padding to:
  - `.skill-browser-header`
  - `.modal-content` top padding
  - Any other full-screen overlay headers
- `web/src/components/SkillBrowser.tsx` — Ensure header has safe area class

#### Implementation Steps
1. Add `padding-top: calc(X + var(--safe-top))` to all full-screen/modal headers on mobile
2. Add `padding-bottom: calc(X + var(--safe-bottom))` to bottom-fixed elements
3. Audit every screen accessible on mobile for safe area coverage

---

### 3. Add back buttons on mobile
**Status:** done
**Priority:** HIGH — users get stuck on screens

#### Problem
Navigation relies on swipe gestures which not all iOS devices/versions support. Users can get stuck on terminal, settings, etc.

#### Files to Modify
- `web/src/components/SessionView.tsx` — Already has a back/menu button (← on mobile), verify it works
- `web/src/components/SkillBrowser.tsx` — Has close button, but may need explicit back
- `web/src/components/TerminalPanel.tsx` — Needs a close/back button in toolbar
- `web/src/styles/global.css` — Style for mobile back buttons

#### Implementation Steps
1. Ensure every screen/overlay on mobile has a visible back/close button in the top-left
2. TerminalPanel: add a close button in `.terminal-toolbar`
3. SkillBrowser: verify close button is visible and reachable (safe area issue may be hiding it)
4. ConversationSearch: verify close button works
5. FileFinder: verify close button works
6. All modals: ensure they have a visible close/back mechanism on mobile

---

### 4. Keyboard dismissal — tap conversation to close
**Status:** done
**Priority:** HIGH — keyboard won't close on mobile

#### Problem
On mobile, tapping the conversation area doesn't dismiss the keyboard. Only the arrow button works.

#### Files to Modify
- `web/src/components/SessionView.tsx` — Add click handler to conversation area
- `web/src/components/MessageList.tsx` — Or add it here at the message list level

#### Implementation Steps
1. Add `onClick` handler to the conversation/message list container
2. On mobile, when clicked, call `document.activeElement?.blur()` to dismiss keyboard
3. Only trigger on mobile platforms (don't interfere with desktop text selection)
4. Also handle the terminal output area in TerminalPanel

---

### 5. Keyboard viewport adjustment
**Status:** done
**Priority:** HIGH — search/files cut off by keyboard

#### Problem
When keyboard opens, search toolbar and file finder get hidden behind the keyboard. The layout doesn't adjust.

#### Files to Modify
- `web/src/utils/platform.ts` — Add keyboard detection utility
- `web/src/App.tsx` or `web/src/main.tsx` — Add visualViewport listener
- `web/src/styles/global.css` — CSS variable for keyboard height

#### Implementation Steps
1. Add a `visualViewport` resize listener that sets a CSS variable `--keyboard-height`:
   ```typescript
   const vv = window.visualViewport;
   if (vv) {
     vv.addEventListener('resize', () => {
       const keyboardHeight = window.innerHeight - vv.height;
       document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
     });
   }
   ```
2. Use `--keyboard-height` in CSS for bottom-positioned elements (input bar, search, file finder)
3. When keyboard is open, adjust `max-height` of modals/overlays to account for keyboard
4. Ensure focused inputs scroll into view: add `scrollIntoView({ block: 'nearest' })` on focus

---

### 6. Mobile terminal — empty Enter to accept prompts
**Status:** done
**Priority:** MEDIUM — can't accept prompts in terminal mode

#### Problem
In terminal mode, pressing Enter with empty text does nothing. `handleTerminalSend()` checks `if (!trimmed)` and returns early. But the user needs to send a bare Enter to accept prompts.

#### Files to Modify
- `web/src/components/InputBar.tsx` — Fix `handleTerminalSend` to allow empty sends

#### Implementation Steps
1. In `handleTerminalSend`, remove or bypass the `if (!trimmed)` check for terminal mode
2. When text is empty, send `\n` (or just empty string) via `onTerminalSend`
3. The daemon's `send_terminal_text` should handle this — it sends via `tmux send-keys` which can send Enter alone

---

## Deferred

### OpenAI Codex CLI Parser
**Status:** deferred (roadmap)

Discover Codex conversation files, parse format, translate to internal types. Not prioritized — focusing on Claude Code integration first.

### macOS Desktop — Nice to Have
**Status:** deferred

Global hotkey (Ctrl+Shift+C), deep links (`companion://` URL scheme), CI build pipeline, code signing & notarization, auto-update via `tauri-plugin-updater`. Post-launch polish.
