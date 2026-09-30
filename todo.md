# Todo

Quick capture for ideas and tasks. Run `/plan` to process into detailed plans.

---

## App Store Release
- Release signing key -- generate a proper upload key for Google Play (back it up!). Enroll in Google Play App Signing
- iOS push notifications -- implement APNs in tauri-plugin-fcm (currently no-op stub) [planned]
- Auth screen store links -- add Google Play and App Store badges/links to the web first-auth screen
- Google Play developer registration -- $25 one-time, set up app listing
- TestFlight beta -- submit iOS build for beta testing before public release

## Upcoming
- Custom "Herald" wake word -- train an openWakeWord model overnight on this box from synthetic Kokoro/Piper "Herald"/"Hey Herald" clips + negatives (bin/ script), load via HERALD_WAKE_MODELS, add spellings to WAKE_NAMES; keep "hey jarvis" as fallback. See plan.md 'Voice Front Layer' [planned]
- Global triggers & native desktop Herald -- remote trigger API (brief/listen/stop/repeat routed to the active device; AutoHotkey, Raycast, curl), Tauri global shortcuts + tray orb, earbud media-button brief on mobile. See plan.md 'Voice Front Layer' [planned]
- Herald go-live (Phase 1 text-only is merged to main, not live) -- needs sign-off for: `bin/companion install-secrets`, `bin/companion herald-provider anthropic`, build daemon + web in the main repo, daemon restart; then `/apk` for the native app UI. Sandbox demo: `bin/herald-sandbox` (port 9887) [in-progress]
- Herald Phase 2 (desktop voice) -- push-to-talk + TTS; hide mic from Discord while PTT held (PipeWire, on by default); duck other audio while Herald speaks (lower/mute/off + level; phones via OS audio focus). See plan.md 'Voice Front Layer' [planned]
- Cmd+Alt+Tab session switcher -- keyboard shortcut to cycle between session windows (MRU order like Alt+Tab, hold modifiers + tap Tab to step, release to switch). Confirm target: desktop Tauri app vs browser; check OS doesn't swallow the combo
- Fleet initiative (Inbox -> Missions -> Routing -> Health) -- opt-in fleet/orchestration layer to differentiate from Anthropic Remote Control; Phase 1 Fleet Inbox is next. See plan.md 'Fleet (Inbox → Missions → Routing → Health)' [planned]
- BUG: App doesn't reconnect after daemon restart -- WS closes on daemon restart, client never re-establishes a working connection; `send` silently no-ops; only fix is remove server + re-add. Need auto-reconnect (backoff) that re-runs authenticate + subscribe, not just reopens the socket. (High pain -- this is what made every debug restart miserable.)
- [folded into Fleet Phase 2 -- Missions notes, see plan.md 'Fleet'] Server-level / session-persistent working memory -- across daemon rebuilds & restarts (and session compaction), Claude loses the live debugging context and re-derives or re-misdiagnoses the same problem. Want a durable "what we're mid-fixing + what we've already ruled out" store that survives. (Surfaced during the AUQ-render bug, which spun for multiple sessions partly from lost context.)
