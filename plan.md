# Implementation Plan

## 1. Fix Session Switching Regression
**Status:** done

---

## 2. Fix New Session Creation/Attaching Bugs
**Status:** done

---

## 3. Beef Up New Project Helper
**Status:** planned

### Requirements
- Let Claude help choose language/stack through back-and-forth discussion
- Analyze the project idea and order template options by recommendation
- Option to create a private GitHub repo during project creation
- More interactive wizard experience

### Files to Modify
- `app/src/screens/NewProjectScreen.tsx` - Add interactive discussion flow
- `daemon/src/scaffold/templates.ts` - Add template metadata for recommendations
- `daemon/src/websocket.ts` - Add GitHub repo creation endpoint

### Implementation Steps
1. Add project analysis step before template selection
2. Order templates by relevance to user's description
3. Add GitHub integration (gh CLI) for private repo creation
4. Multi-step wizard with back-and-forth refinement

---

## 4. Session Header Redesign
**Status:** done

### Requirements
- Replace text-character icons with proper SVG icons (`@expo/vector-icons`, bundled with Expo)
- Keep all 4 header buttons: terminal, refresh, auto-approve, settings
- Auto-approve toggle: **header only** - remove from settings modal
- Instant notify: **session settings modal only** - remove from notification settings screen
- Settings modal becomes a single-toggle instant-notify panel (or expand later)

### Current Header Layout
```
‹ Back | ServerName + SessionPicker | >_ | ↻ | AA | ⚙
```
Icons are text chars: `>_` (terminal), `↻` (refresh), `AA` (auto-approve), `⚙` (settings gear emoji)

### New Header Layout
```
‹ Back | ServerName + SessionPicker | [terminal] | [refresh] | [shield] | [gear]
```
All icons from `@expo/vector-icons` (Ionicons or MaterialCommunityIcons):
- Terminal: `Ionicons/terminal-outline`
- Refresh: `Ionicons/refresh`
- Auto-approve: `Ionicons/shield-checkmark` (active) / `Ionicons/shield-outline` (inactive)
- Settings: `Ionicons/settings-outline`

### Files to Modify
- `app/src/screens/SessionView.tsx`
  - Import `Ionicons` from `@expo/vector-icons`
  - Replace text icons with `<Ionicons>` components in header
  - Remove auto-approve row from settings modal
  - Keep instant notify as the sole toggle in settings modal
  - Update auto-approve button styling for icon-based toggle
- `app/src/screens/NotificationSettings.tsx`
  - Remove the "Instant Notify" toggle (now session-only)
- `app/src/services/notificationPrefs.ts`
  - Remove `instantNotify` from notification prefs interface (optional cleanup)

### Implementation Steps
1. Add `@expo/vector-icons` import to SessionView (already available via Expo)
2. Replace header button text with Ionicons:
   - Back: keep `‹ Back` text or use `Ionicons/chevron-back`
   - Terminal: `<Ionicons name="terminal-outline" size={20} color="#9ca3af" />`
   - Refresh: `<Ionicons name="refresh" size={20} color="#9ca3af" />` (with disabled opacity)
   - Auto-approve: `<Ionicons name="shield-checkmark" size={20} />` with active/inactive colors
   - Settings: `<Ionicons name="settings-outline" size={20} color="#9ca3af" />`
3. Remove auto-approve `<Switch>` from the session settings modal
4. Update modal title from "Session Settings" to something appropriate (e.g., "Notifications" or keep "Session Settings")
5. Remove instant notify toggle from NotificationSettings.tsx
6. Type check: `cd app && npx tsc --noEmit`

### Tests Needed
- Header renders all 4 icon buttons
- Auto-approve toggle works from header (on/off visual state)
- Settings modal opens with only instant notify toggle
- NotificationSettings screen no longer shows instant notify
- Icons render correctly on Android

---

## 5. Dashboard Waiting/Idle Distinction
**Status:** done

### Requirements
- Finished sessions currently show "waiting" and rise to top over actually-working ones
- Add "idle" state for sessions that have finished their task
- Gray out idle sessions on dashboard
- Sort order: waiting > working > idle > error

### Files to Modify
- `daemon/src/watcher.ts` or `daemon/src/parser.ts` - Detect idle vs waiting state
- `daemon/src/websocket.ts` - Include idle status in session summary
- `app/src/types/index.ts` - Add 'idle' to SessionSummary status type
- `app/src/screens/DashboardScreen.tsx` - Gray styling for idle sessions, updated sort

### Implementation Steps
1. Define "idle" state: session exists but Claude has finished (no pending input, no active tool calls, last activity > N seconds ago)
2. Update daemon parser to distinguish waiting-for-user-input vs idle-finished
3. Update session summary to report idle status
4. Update app types to include 'idle' in status union
5. Update DashboardScreen sort priority and add gray styling for idle sessions
6. Add idle icon (e.g., checkmark or dash) to SessionStatusIcon

### Tests Needed
- Idle sessions sort below working/waiting sessions
- Idle sessions render with gray styling
- Session transitions correctly between working → idle and idle → waiting

---

## 6. Settings Cog Icon on Dashboard FAB
**Status:** done

### Requirements
- Change the bottom-right FAB on the dashboard from the current circle+border to a proper cog icon

### Files to Modify
- `app/App.tsx` - Replace the `settingsGear` View with an Ionicons cog

### Implementation Steps
1. Import `Ionicons` from `@expo/vector-icons`
2. Replace `<View style={styles.settingsGear} />` with `<Ionicons name="settings-sharp" size={22} color="#9ca3af" />`
3. Remove unused `settingsGear` style

### Tests Needed
- Cog icon renders on dashboard
- Tap opens settings screen

---

## 7. Show Password Toggle on Token Field
**Status:** done

### Requirements
- Server edit screen token field should have a show/hide password toggle

### Files to Modify
- `app/src/screens/EditServerScreen.tsx` - Add secureTextEntry toggle to token input

### Implementation Steps
1. Add `showToken` state (default false)
2. Set `secureTextEntry={!showToken}` on the token TextInput
3. Add eye icon toggle button next to the field: `Ionicons/eye-outline` / `Ionicons/eye-off-outline`

### Tests Needed
- Token field obscured by default
- Tap eye icon reveals token text
- Tap again hides it
